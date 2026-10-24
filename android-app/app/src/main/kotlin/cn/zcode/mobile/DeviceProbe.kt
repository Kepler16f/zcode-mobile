package cn.zcode.mobile

import android.content.Context
import android.os.Build
import android.os.Process
import android.system.Os
import android.system.OsConstants
import android.webkit.JavascriptInterface
import org.json.JSONObject
import java.io.File
import java.util.concurrent.TimeUnit

/**
 * §3.4 关卡 9 的可测量部分，以及 §2.1 的 L1 层判定。
 *
 * 本机没有 NDK（SDK 里的 ndk/28.2.13676358 是 1 KB 空占位），所以 L2「随包 ELF 能不能 execve」
 * 这一版测不了，探针如实报 bundledToolchain:false 而不是假装通过。
 * L1 不需要 NDK：直接量 app 派生子进程能不能跑 /system/bin/sh 与 toybox —— 这是 Bash 工具
 * 在 Android 上成立的最低条件，也是 Termux 之外 most 应用被坑的地方。
 */
class DeviceProbe(private val context: Context) {

    @JavascriptInterface
    fun name(): String = "zcodeDevice"

    /**
     * 把授权链接交给系统浏览器（登录流程必需：WebView 里没有用户已登录的账号态）。
     *
     * 只放 http/https：`zcode://`、`file://`、`content://`、`intent://` 一律拒绝。
     * JS 侧的 `openExternal` 参数一路从远端授权接口过来，这里是它进系统前的唯一一道闸。
     */
    @JavascriptInterface
    fun openExternal(url: String): String {
        val report = JSONObject()
        val scheme = url.substringBefore(":", "").lowercase()
        if (scheme != "http" && scheme != "https") {
            return report.put("ok", false).put("error", "只允许 http/https，收到 $scheme:").toString()
        }
        return try {
            val intent = android.content.Intent(android.content.Intent.ACTION_VIEW, android.net.Uri.parse(url))
                .addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
            context.startActivity(intent)
            report.put("ok", true).toString()
        } catch (e: Exception) {
            // 没装浏览器（部分定制 ROM / 无 GMS 设备）就是这条：明确报出来，别让 UI 以为登录已经开始了。
            report.put("ok", false).put("error", "${e.javaClass.simpleName}: ${e.message}").toString()
        }
    }

    /** 同步返回，JS 侧线程会阻塞在这里，最长 timeoutMs。 */
    @JavascriptInterface
    fun execL1(command: String, timeoutMs: Long): String {
        val report = JSONObject()
        val started = System.currentTimeMillis()
        try {
            val process = ProcessBuilder("sh", "-c", command)
                .redirectErrorStream(true)
                .directory(context.cacheDir)
                .start()
            val finished = process.waitFor(timeoutMs, TimeUnit.MILLISECONDS)
            if (!finished) {
                process.destroyForcibly()
                return report
                    .put("ok", false)
                    .put("error", "timeout after ${timeoutMs}ms")
                    .put("durationMs", System.currentTimeMillis() - started)
                    .toString()
            }
            val output = process.inputStream.bufferedReader().use { it.readText() }
            report
                .put("ok", process.exitValue() == 0)
                .put("exitCode", process.exitValue())
                .put("output", output.take(2000))
        } catch (e: Exception) {
            // EACCES/ENOEXEC 在这里出现就是 sepolicy 变了（§7 R14），必须原样报出来。
            report.put("ok", false).put("error", "${e.javaClass.simpleName}: ${e.message}")
        }
        return report.put("durationMs", System.currentTimeMillis() - started).toString()
    }

    /**
     * L2 探针的骨架：尝试 execve nativeLibraryDir 下的随包 ELF。
     * 现在是负对照 —— 库里没有任何随包可执行文件，期望结论是"没有工具链"，不是"execve 被禁"。
     */
    @JavascriptInterface
    fun execL2(): String {
        val dir = context.applicationInfo.nativeLibraryDir
        val candidates = File(dir ?: ".")
            .listFiles { f -> f.name.startsWith("libzcode") && f.name.endsWith(".so") }
            ?.toList()
            ?: emptyList()
        val probe = JSONObject()
            .put("nativeLibraryDir", dir)
            .put("bundledToolchain", false)
            .put("candidates", candidates.size)
            // extractNativeLibs=false 时 .so 直接从 APK mmap，nativeLibraryDir 下没有散装文件，
            // 也就没有可 execve 的路径。真正的断言在 Gradle 里（R13），这里只做现场核对。
            .put("hasLooseNativeLibs", File(dir ?: ".").exists() && candidates.isNotEmpty())
        if (candidates.isEmpty()) {
            return probe.put(
                "note",
                "本机 NDK 是空占位，没有随包 ELF；execve 正对照要等 L2 立项目（§8 M4b）",
            ).toString()
        }
        val target = candidates[0].absolutePath
        return try {
            // Os.execve 会替换当前进程，探针里绝不能用；这里只验证文件存在与可执行位。
            val canExecute = File(target).canExecute()
            probe.put("firstCandidate", target).put("canExecute", canExecute).toString()
        } catch (e: Exception) {
            probe.put("error", e.message).toString()
        }
    }

    private fun versionCodeOf(pkg: android.content.pm.PackageInfo?): Long {
        if (pkg == null) return 0L
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) pkg.longVersionCode
        else @Suppress("DEPRECATION") pkg.versionCode.toLong()
    }

    /**
     * 全部文件管理权限（0.7.3，用户点名"申请对全部文件的管理权限"）。
     * Android 11+ 的 MANAGE_EXTERNAL_STORAGE：授予后 app 的文件 API 能触到 /sdcard 全域，
     * FsBridge 据此放行 /ext/<相对路径> 这一支虚拟前缀（见 FsBridge.externalRoot）。
     * 权限页（Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION）按包名直达"本 app"的
     * 授权开关——用户从设置里点进去，比"所有文件访问权限"总列表好找；该 Intent 不存在
     * （厂商 ROM 裁了）就退回总列表页。
     */
    @JavascriptInterface
    fun openAllFilesPermission(): String {
        val report = JSONObject()
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
            return report
                .put("ok", false)
                .put("error", "Android 11 以下没有\"所有文件访问\"这一档（旧版用传统存储权限，重启不生效）")
                .toString()
        }
        if (android.os.Environment.isExternalStorageManager()) {
            // 已经授过：别跳页，回 ok 让 UI 把状态刷成"已授予"（幂等：重复点设置不闪系统页）。
            return report.put("ok", true).put("alreadyGranted", true).toString()
        }
        // 这两个 action 挂在 android.provider.Settings 上（不是 Intent 的常量——出包时
        // Unresolved reference 踩过一次）：按包直达页要带 package: 数据，总列表页不带。
        val byPackage = android.content.Intent(
            android.provider.Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION,
            android.net.Uri.parse("package:" + context.packageName),
        ).addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
        // 厂商 ROM 裁掉按包直达页时的兜底：通用"所有文件访问权限"总列表。
        val general = android.content.Intent(
            android.provider.Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION,
        ).addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
        for (intent in listOf(byPackage, general)) {
            try {
                context.startActivity(intent)
                return report.put("ok", true).toString()
            } catch (_: Exception) {
                // 下一个候选；两个都起不来才如实报。
            }
        }
        return report.put("ok", false).put("error", "系统\"所有文件访问权限\"页打不开（这台 ROM 可能裁掉了该入口）").toString()
    }

    @JavascriptInterface
    fun allFilesGranted(): Boolean {
        // isExternalStorageManager 是 API 30+；低版本没有这一档，如实 false。
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.R &&
            android.os.Environment.isExternalStorageManager()
    }

    /**
     * 外部存储的**公共目录根**（= /sdcard 的真实文件）。/ext 前缀只映射到这一棵树，
     * 并且 FsBridge 在解析后二次核验 canonical 路径确实落在这棵树下（链接逃逸防线）。
     * 没挂载（异常机器）回 null。
     */
    @JavascriptInterface
    fun externalStorageRoot(): String {
        val root = android.os.Environment.getExternalStorageDirectory()
        return try {
            if (root.isDirectory && root.canRead()) root.canonicalPath else ""
        } catch (_: Exception) {
            ""
        }
    }

    @JavascriptInterface
    fun deviceInfo(): String {
        val runtime = Runtime.getRuntime()
        // 报告里必须带版本号：0.0.1 与 0.0.2 的文件后端结论完全不同（内存盘 vs 真盘桥），
        // 装机复测贴回来的 JSON 若认不出是哪一版跑的，两批数据会互相污染。
        val pkg = runCatching {
            context.packageManager.getPackageInfo(context.packageName, 0)
        }.getOrNull()
        return JSONObject()
            .put("brand", Build.BRAND)
            .put("model", Build.MODEL)
            .put("sdkInt", Build.VERSION.SDK_INT)
            .put("appVersion", pkg?.versionName ?: "?")
            .put("appVersionCode", versionCodeOf(pkg))
            .put("abis", Build.SUPPORTED_ABIS.joinToString(","))
            .put("pid", Process.myPid())
            .put("javaMaxMemoryMB", runtime.maxMemory() / 1048576)
            .put("totalMemoryMB", runtime.totalMemory() / 1048576)
            .put("freeMemoryMB", runtime.freeMemory() / 1048576)
            .put("pageSize", Os.sysconf(OsConstants._SC_PAGESIZE))
            .toString()
    }
}
