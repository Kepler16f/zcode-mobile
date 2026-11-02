package cn.zcode.mobile

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.webkit.JavascriptInterface
import androidx.core.content.FileProvider
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/**
 * 应用内更新（0.11.1，用户点名"点版本号能检查更新"）。
 *
 * 分工：这一层只提供**原生能力**（查版本、下载 APK、装 APK），
 * 弹窗与文案由 UI 侧另有人接；本桥不知道任何 UI 概念。
 *
 * 网络与 GitHttpBridge 同源（那个桥的由来见 GitHttpBridge.kt 头注）：
 *  - 用 HttpURLConnection，**没有 CORS 这一层**（原生请求不受同源策略约束）；
 *  - 网络动作跑在后台线程，JS 侧只拿到一个同步返回的 JSON 字符串；
 *  - 超时 15s，超时/非 200/JSON 解析失败一律回 {"ok":false,"error":"..."}。
 *
 * 版本号**不写死**：current / currentCode 一律从 PackageManager 读 versionName / versionCode。
 * 比较规则：tag 去掉前缀 v，按 "." 切段逐段比数字；相等不算更新，**低版本号也不算更新**
 * （线上出了比本地低的 tag 时不能提示"可更新"）。
 *
 * 安装走 FileProvider（content://）而不是 file://：Android 7+ 抛 FileUriExposed。
 * 私有目录里的文件只有经 FileProvider 才能被系统安装器读到，所以下载一律落 files/updates/。
 */
class UpdateBridge(private val context: Context) {

    /** 前台下载用的应用内线程池（后台下载走前台服务，不占这里）。 */
    private val pool = Executors.newFixedThreadPool(2) { runnable ->
        Thread(runnable, "zcode-update-dl").apply { isDaemon = true }
    }

    /**
     * 查 GitHub 最新 Release。
     *
     * 返回形状（与 UI 侧约定逐字一致）：
     *   无更新：{"ok":true,"hasUpdate":false,"current":"0.11.1","currentCode":11001}
     *   有更新：{"ok":true,"hasUpdate":true,"current":"0.11.1","latest":"0.11.2","tag":"v0.11.2",
     *            "url":"<apk 直链>","notes":"<release body 摘要>","size":123456}
     *   失败：  {"ok":false,"error":"..."}
     */
    @JavascriptInterface
    fun checkForUpdate(): String {
        // 网络动作放后台线程（契约上仍是同步返回一个 JSON 字符串）。
        val slot = arrayOfNulls<String>(1)
        val worker = Thread({ slot[0] = fetchLatestRelease() }, "zcode-update-check").apply {
            isDaemon = true
        }
        worker.start()
        worker.join(CHECK_TIMEOUT_MS + 5_000L)
        return slot[0] ?: errorJson("检查更新超时（${CHECK_TIMEOUT_MS}ms）")
    }

    /**
     * 起一次下载。
     *
     * background=false：应用内线程池下载，进度靠 getDownloadProgress 轮询。
     * background=true ：起前台服务 UpdateDownloadService，通知栏出进度，完成后点通知即可安装。
     *
     * 返回：{"ok":true,"jobId":"..."} / {"ok":false,"error":"..."}
     */
    @JavascriptInterface
    fun startDownload(url: String, background: Boolean): String {
        val target = url.trim()
        if (!target.startsWith("http://") && !target.startsWith("https://")) {
            return errorJson("下载地址不合法：$url")
        }
        val job = UpdateJobs.create(target)
        return try {
            if (background) {
                val intent = Intent(context, UpdateDownloadService::class.java).apply {
                    action = UpdateDownloadService.ACTION_DOWNLOAD
                    putExtra(UpdateDownloadService.EXTRA_JOB_ID, job.id)
                    putExtra(UpdateDownloadService.EXTRA_URL, target)
                }
                // minSdk 26，平台 API 直接可用（自 Android 8 起前台服务必须走这个入口）。
                context.startForegroundService(intent)
            } else {
                pool.execute { runUpdateDownload(context, job) }
            }
            JSONObject().put("ok", true).put("jobId", job.id).toString()
        } catch (e: Exception) {
            job.state = UpdateJob.STATE_FAILED
            job.error = "${e.javaClass.simpleName}: ${e.message}"
            errorJson(job.error)
        }
    }

    /**
     * 读一次下载进度。
     *
     * 返回：{"ok":true,"jobId":"...","state":"running|done|failed|unknown",
     *        "downloaded":bytes,"total":bytes,"filePath":"..."}
     * 找不到的 jobId 也回 ok:true，只是 state 为 unknown（前端据此判定"没有这一单"）。
     */
    @JavascriptInterface
    fun getDownloadProgress(jobId: String): String {
        val job = UpdateJobs.find(jobId)
        val report = JSONObject().put("ok", true).put("jobId", jobId)
        if (job == null) {
            return report
                .put("state", UpdateJob.STATE_UNKNOWN)
                .put("downloaded", 0)
                .put("total", 0)
                .put("filePath", "")
                .toString()
        }
        return report
            .put("state", job.state)
            .put("downloaded", job.downloaded)
            .put("total", job.total)
            .put("filePath", job.filePath)
            .toString()
    }

    /** 取消下载。返回 {"ok":true}（jobId 不存在也回 ok:true —— 取消一个不存在的任务是幂等的）。 */
    @JavascriptInterface
    fun cancelDownload(jobId: String): String {
        val job = UpdateJobs.find(jobId)
        if (job != null) {
            job.cancelled.set(true)
            if (job.state == UpdateJob.STATE_RUNNING) {
                job.state = UpdateJob.STATE_FAILED
                job.error = "已取消"
            }
        }
        // 后台那一路是前台服务在跑：让它自己收掉（服务被停时会取消同一个 job）。
        runCatching { context.stopService(Intent(context, UpdateDownloadService::class.java)) }
        return JSONObject().put("ok", true).toString()
    }

    /**
     * 装 APK。
     *
     * 返回：{"ok":true} / {"ok":false,"error":"..."} /
     *       {"ok":false,"error":"need_install_permission","canRequest":true}
     *
     * 最后一种＝Android 8+ 的"允许此来源安装应用"没授权，前端据此引导到系统设置
     * （原生侧提供 openInstallPermission 拉起那个设置页）。
     */
    @JavascriptInterface
    fun installApk(filePath: String): String {
        val file = safeApkFile(filePath)
            ?: return errorJson("文件不在应用私有目录内，拒绝安装：$filePath")
        if (!file.isFile) return errorJson("安装包不存在：$filePath")
        if (!context.packageManager.canRequestPackageInstalls()) {
            return JSONObject()
                .put("ok", false)
                .put("error", "need_install_permission")
                .put("canRequest", true)
                .toString()
        }
        return try {
            context.startActivity(buildInstallIntent(context, file))
            JSONObject().put("ok", true).toString()
        } catch (e: Exception) {
            errorJson("${e.javaClass.simpleName}: ${e.message}")
        }
    }

    /** 拉起"允许此来源安装应用"的系统设置页。返回 {"ok":true} / {"ok":false,"error":"..."}。 */
    @JavascriptInterface
    fun openInstallPermission(): String {
        return try {
            val intent = Intent(
                android.provider.Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                Uri.parse("package:" + context.packageName),
            ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            context.startActivity(intent)
            JSONObject().put("ok", true).toString()
        } catch (e: Exception) {
            errorJson("${e.javaClass.simpleName}: ${e.message}")
        }
    }

    // ---- 内部实现 ----------------------------------------------------------

    /** 拉 GitHub 的 latest release，解析出 apk 直链与版本信息。 */
    private fun fetchLatestRelease(): String {
        var conn: HttpURLConnection? = null
        try {
            conn = (URL(RELEASES_URL).openConnection() as HttpURLConnection).apply {
                requestMethod = "GET"
                connectTimeout = CHECK_TIMEOUT_MS
                readTimeout = CHECK_TIMEOUT_MS
                useCaches = false
                setRequestProperty("Accept", "application/vnd.github+json")
                setRequestProperty("User-Agent", "aZCode-Android")
            }
            val code = conn.responseCode
            if (code != 200) return errorJson("GitHub API 返回 HTTP $code")
            val body = conn.inputStream.bufferedReader().use { it.readText() }
            val release = JSONObject(body)
            val tag = release.optString("tag_name", "").trim()
            if (tag.isEmpty()) return errorJson("Release 里没有 tag_name")

            val asset = findApkAsset(release.optJSONArray("assets"))
                ?: return errorJson("该版本没有可下载的 .apk 资产")

            val latest = normalizeVersion(tag)
            val current = currentVersionName()
            val currentCode = currentVersionCode()
            val base = JSONObject().put("ok", true).put("current", current)
            // 低版本号不算更新：线上出了比本地低的 tag 时不能提示"可更新"。
            if (compareVersions(latest, current) <= 0) {
                return base.put("hasUpdate", false).put("currentCode", currentCode).toString()
            }
            return base
                .put("hasUpdate", true)
                .put("latest", latest)
                .put("tag", tag)
                .put("url", asset.optString("browser_download_url", ""))
                .put("notes", summarizeNotes(release.optString("body", "")))
                .put("size", asset.optLong("size", 0L))
                .toString()
        } catch (e: Exception) {
            return errorJson("${e.javaClass.simpleName}: ${e.message}")
        } finally {
            conn?.disconnect()
        }
    }

    /** assets 里挑第一个 .apk（按名字后缀，不看 mime）。 */
    private fun findApkAsset(assets: org.json.JSONArray?): JSONObject? {
        if (assets == null) return null
        for (i in 0 until assets.length()) {
            val asset = assets.optJSONObject(i) ?: continue
            val name = asset.optString("name", "")
            val url = asset.optString("browser_download_url", "")
            if (name.endsWith(".apk", ignoreCase = true) && url.isNotEmpty()) return asset
        }
        return null
    }

    /** tag 去掉 v 前缀（大小写都去），得到可比较的版本串。 */
    private fun normalizeVersion(tag: String): String {
        val trimmed = tag.trim()
        return if (trimmed.startsWith("v") || trimmed.startsWith("V")) trimmed.substring(1) else trimmed
    }

    /**
     * 逐段比较版本号：按 "." 切段，每段取开头的数字比；段数不同按缺失段当 0。
     * 返回 a<b → -1，a==b → 0，a>b → 1。
     */
    private fun compareVersions(a: String, b: String): Int {
        val pa = a.split(".")
        val pb = b.split(".")
        val n = maxOf(pa.size, pb.size)
        for (i in 0 until n) {
            val x = numericSegment(pa.getOrNull(i))
            val y = numericSegment(pb.getOrNull(i))
            if (x != y) return if (x < y) -1 else 1
        }
        return 0
    }

    /** 取一段里的前导数字（"11" → 11，"2-beta" → 2，认不出 → 0）。 */
    private fun numericSegment(segment: String?): Long {
        if (segment.isNullOrEmpty()) return 0L
        var end = 0
        while (end < segment.length && segment[end] in '0'..'9') end++
        if (end == 0) return 0L
        return segment.substring(0, end).toLongOrNull() ?: 0L
    }

    /** release body 压成一行摘要（去掉多余空白，截到 300 字）。 */
    private fun summarizeNotes(body: String): String {
        val oneLine = body.replace(Regex("\\s+"), " ").trim()
        return if (oneLine.length <= NOTES_MAX_CHARS) oneLine else oneLine.substring(0, NOTES_MAX_CHARS) + "…"
    }

    /** 当前版本名（PackageManager，不写死）。 */
    private fun currentVersionName(): String {
        val pkg = runCatching { context.packageManager.getPackageInfo(context.packageName, 0) }.getOrNull()
        return pkg?.versionName ?: "0"
    }

    /** 当前 versionCode（PackageManager，不写死）。 */
    private fun currentVersionCode(): Long {
        val pkg = runCatching { context.packageManager.getPackageInfo(context.packageName, 0) }.getOrNull()
            ?: return 0L
        return if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.P) {
            pkg.longVersionCode
        } else {
            @Suppress("DEPRECATION")
            pkg.versionCode.toLong()
        }
    }

    /**
     * 路径防注入：规范化（解 symlink 与 ..）之后必须仍落在 filesDir 或 cacheDir 下，
     * 否则拒绝——不能被一条 "../../data/data/xxx" 之类的路径骗去装别处的文件。
     */
    private fun safeApkFile(path: String): File? {
        if (path.isBlank()) return null
        return try {
            val file = File(path).canonicalFile
            val filesRoot = context.filesDir.canonicalFile
            val cacheRoot = context.cacheDir.canonicalFile
            if (isUnder(file, filesRoot) || isUnder(file, cacheRoot)) file else null
        } catch (e: Exception) {
            null
        }
    }

    private fun isUnder(file: File, root: File): Boolean {
        val rootPath = root.path
        val filePath = file.path
        return filePath == rootPath || filePath.startsWith(rootPath + File.separator)
    }

    private fun errorJson(message: String): String =
        JSONObject().put("ok", false).put("error", message).toString()

    companion object {
        /** GitHub 最新 Release 的 API。 */
        const val RELEASES_URL = "https://api.github.com/repos/Kepler16f/zcode-mobile/releases/latest"

        /** 检查更新的超时（连接与读取各 15s）。 */
        const val CHECK_TIMEOUT_MS = 15_000

        /** release body 摘要的最大字符数。 */
        const val NOTES_MAX_CHARS = 300

        /** 安装包的 MIME。 */
        const val APK_MIME = "application/vnd.android.package-archive"

        /**
         * 造"装这个 APK"的 Intent（FileProvider content:// + 临时读授权）。
         * UpdateBridge 与 UpdateDownloadService 共用这一条路径——通知里点"安装"与
         * 前端调 installApk 必须是同一个动作，不能各造各的 Intent。
         */
        fun buildInstallIntent(context: Context, file: File): Intent {
            val uri = FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", file)
            return Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(uri, APK_MIME)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
            }
        }
    }
}

/**
 * 一个下载任务的运行时状态。桥（读进度）与前台服务（跑下载）在同一进程里共享同一份。
 */
internal class UpdateJob(val id: String, val url: String) {
    /** 建单时刻（清理老任务用）。 */
    val createdAt: Long = System.currentTimeMillis()
    @Volatile var state: String = STATE_RUNNING
    @Volatile var downloaded: Long = 0L
    @Volatile var total: Long = 0L
    @Volatile var filePath: String = ""
    @Volatile var error: String = ""
    val cancelled = AtomicBoolean(false)

    companion object {
        const val STATE_RUNNING = "running"
        const val STATE_DONE = "done"
        const val STATE_FAILED = "failed"
        const val STATE_UNKNOWN = "unknown"
    }
}

/** 进程级的下载任务表（桥与服务共用；进程退出即随之消失）。 */
internal object UpdateJobs {
    private val jobs = ConcurrentHashMap<String, UpdateJob>()

    fun create(url: String): UpdateJob = create(UUID.randomUUID().toString(), url)

    fun create(id: String, url: String): UpdateJob {
        evictOldJobs()
        val job = UpdateJob(id, url)
        jobs[id] = job
        return job
    }

    fun find(id: String): UpdateJob? = jobs[id]

    fun forget(id: String) {
        jobs.remove(id)
    }

    /**
     * 清掉老任务：应用进程可以活很久（一直挂着不退出），不清理的话这张表会慢慢涨。
     * 只清"已经收口且很久没人问"的，正在跑的绝不动。
     */
    private fun evictOldJobs() {
        val now = System.currentTimeMillis()
        val expired = jobs.entries.filter { (_, job) ->
            job.state != UpdateJob.STATE_RUNNING && now - job.createdAt > RETENTION_MS
        }
        expired.forEach { jobs.remove(it.key) }
    }

    /** 任务在表里最多留多久（毫秒）。 */
    private const val RETENTION_MS = 60 * 60 * 1000L
}

/**
 * 下载一个 APK 到应用私有目录（files/updates/xxx.apk）。
 *
 * 落私有目录而不是 /sdcard：装 APK 的系统安装器要经 FileProvider 读，
 * 私有目录经 FileProvider 映射出去最稳，也不用再要存储权限。
 *
 * 手动跟重定向：GitHub 的 release 直链会 302 到 objects.githubusercontent.com，
 * HttpURLConnection 不跟跨协议跳转，自己跟（上限 5 跳）。
 */
internal fun runUpdateDownload(
    context: Context,
    job: UpdateJob,
    onProgress: ((downloaded: Long, total: Long) -> Unit)? = null,
) {
    var conn: HttpURLConnection? = null
    var out: FileOutputStream? = null
    try {
        var current = URL(job.url)
        var redirects = 0
        while (true) {
            conn = (current.openConnection() as HttpURLConnection).apply {
                requestMethod = "GET"
                connectTimeout = 30_000
                readTimeout = 60_000
                useCaches = false
                instanceFollowRedirects = false
                setRequestProperty("Accept", "application/octet-stream")
                setRequestProperty("User-Agent", "aZCode-Android")
            }
            val code = conn.responseCode
            if (code in 300..399) {
                val location = conn.getHeaderField("Location")
                conn.disconnect()
                conn = null
                if (location.isNullOrEmpty() || redirects >= 5) {
                    throw IllegalStateException("重定向 $code 无 Location 或超过 5 跳")
                }
                redirects++
                current = URL(current, location)
                continue
            }
            if (code != 200) throw IllegalStateException("下载失败：HTTP $code")

            val length = conn.contentLength.toLong()
            job.total = if (length > 0) length else 0L

            val dir = File(context.filesDir, "updates").apply { mkdirs() }
            val target = File(dir, apkFileName(job.url, job.id))
            val partial = File(dir, target.name + ".part")
            out = FileOutputStream(partial)
            val buffer = ByteArray(64 * 1024)
            var written = 0L
            var lastPush = 0L
            conn.inputStream.use { input ->
                while (true) {
                    if (job.cancelled.get()) throw IllegalStateException("已取消")
                    val n = input.read(buffer)
                    if (n < 0) break
                    out.write(buffer, 0, n)
                    written += n
                    job.downloaded = written
                    val now = System.currentTimeMillis()
                    // 进度节流：每 250ms 推一次，别把通知刷新成 slideshow。
                    if (onProgress != null && now - lastPush >= PROGRESS_PUSH_INTERVAL_MS) {
                        lastPush = now
                        onProgress(written, job.total)
                    }
                }
            }
            out.flush()
            out.close()
            out = null
            if (target.exists()) target.delete()
            if (!partial.renameTo(target)) {
                // 跨文件系统时 rename 会失败，退化成拷贝（files/updates 与 files 同一分区，正常不会走到）。
                partial.copyTo(target, overwrite = true)
                partial.delete()
            }
            job.filePath = target.absolutePath
            job.downloaded = written
            job.state = UpdateJob.STATE_DONE
            return
        }
    } catch (e: Exception) {
        job.state = UpdateJob.STATE_FAILED
        job.error = "${e.javaClass.simpleName}: ${e.message}"
    } finally {
        runCatching { out?.close() }
        runCatching { conn?.disconnect() }
    }
}

/** 从下载直链里取文件名（去掉查询串与非白名单字符），拿不到就用 jobId 兜底。 */
internal fun apkFileName(url: String, jobId: String): String {
    val raw = url.substringBefore('?').substringBefore('#').substringAfterLast('/')
    val safe = raw.replace(Regex("[^A-Za-z0-9._-]"), "_")
    return when {
        safe.isEmpty() -> "update-$jobId.apk"
        safe.endsWith(".apk", ignoreCase = true) -> safe
        else -> "$safe.apk"
    }
}

/** 进度推送的最小间隔（毫秒）。 */
internal const val PROGRESS_PUSH_INTERVAL_MS = 250L
