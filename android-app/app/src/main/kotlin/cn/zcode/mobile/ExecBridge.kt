package cn.zcode.mobile

import android.content.Context
import android.webkit.JavascriptInterface
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileOutputStream
import java.io.InputStream
import java.util.concurrent.TimeUnit
import java.util.zip.ZipEntry
import java.util.zip.ZipFile

/**
 * §2.1 的 L1 落地：真机自检已经证明这个 WebView 里 app 能派生 `/system/bin/sh`
 * （OPD2511 / Android 16：shell:true, 105 ms, toybox 可用, aarch64），所以 Bash 工具
 * 在端侧不是"预期能力"而是现成能力，这里把它接到 ExecutionPort 上。
 *
 * 三条不可让的约束：
 *  1. argv 形态绝不经过 shell。`ProcessBuilder(listOf(file) + args)` 直接走 execve，
 *     把用户输入拼进 `sh -c` 就等于让模型的一句话决定设备上跑什么。
 *  2. stdout 与 stderr 必须并发读。顺序读会死锁：管道缓冲区（Linux 默认 64 KB）满了之后
 *     子进程阻塞在写，父进程还阻塞在读另一条流上，两边都不放手，表现为"命令挂死"。
 *  3. 长命令在后台任务中执行，轮询只传任务 ID；取消由任务所有者结束正在运行的进程。
 */
class ExecBridge(private val context: Context) {
    private val jobs = AsyncBridgeJobs()

    @JavascriptInterface
    fun start(request: String): String = jobs.start { job -> execute(request, job) }

    @JavascriptInterface
    fun poll(id: String): String = jobs.poll(id)

    @JavascriptInterface
    fun cancel(id: String): Boolean = jobs.cancel(id)

    fun cancelAll() = jobs.cancelAll()

    /** 旧版自检继续使用同步入口；应用会优先使用 start/poll/cancel。 */
    @JavascriptInterface
    fun exec(request: String): String = execute(request, null)

    /**
     * 合成命令层（0.10.x）的解压桥：Bash 里没有 unzip（toybox 不带），而 java.util.zip 在
     * Android 运行时是现成的——JS 侧的合成 `unzip` 命令经这条桥解包，终端零新增字节。
     *
     * 契约与既有桥一致：JSON 进、JSON 出。入参 `{zip, dest}`（路径走 workspaceFile 的同一套
     * vfs/真实路径映射与 `..` 拦截），回包 `{ok:true, files:N}` 或 `{error}`。
     * 同步签名（SqliteBridge 同款先例）：JS 等到回包才继续——典型配置包几秒内完成，
     * 大包的耗时由调用方（合成命令层）自行权衡。
     *
     * zip-slip 纪律：压缩包是外部输入，条目名不可信——含 `..` 段、绝对路径、盘符拼写
     * 的一律拒绝；落点再按 canonicalPath 复核必须在 dest 之内（双保险，防符号链接）。
     */
    @JavascriptInterface
    fun unzip(request: String): String {
        val json = try { JSONObject(request) } catch (e: Exception) {
            return JSONObject().put("error", "unzip 入参不是合法 JSON：${e.message}").toString()
        }
        val zipPath = json.optString("zip")
        val destPath = json.optString("dest")
        if (zipPath.isEmpty()) return JSONObject().put("error", "unzip 缺少 zip 路径").toString()
        val zipFile: File = try { workspaceFile(zipPath) } catch (e: Exception) {
            return JSONObject().put("error", "${e.message}").toString()
        }
        val destDir: File = try {
            if (destPath.isEmpty()) workspaceRoot() else workspaceFile(destPath)
        } catch (e: Exception) {
            return JSONObject().put("error", "${e.message}").toString()
        }
        if (!zipFile.isFile) return JSONObject().put("error", "zip 文件不存在：${zipFile.absolutePath}").toString()
        if (destDir.exists() && !destDir.isDirectory) {
            return JSONObject().put("error", "解压目标不是目录：${destDir.absolutePath}").toString()
        }
        if (!destDir.isDirectory && !destDir.mkdirs()) {
            return JSONObject().put("error", "解压目标目录创建失败：${destDir.absolutePath}").toString()
        }
        try {
            ZipFile(zipFile).use { archive ->
                val destCanonical = destDir.canonicalPath + File.separator
                var count = 0
                val entries = archive.entries()
                while (entries.hasMoreElements()) {
                    val entry = entries.nextElement() as ZipEntry
                    val target = safeEntryTarget(destDir, destCanonical, entry.name)
                        ?: return JSONObject()
                            .put("error", "拒绝危险条目名（zip-slip）：${entry.name}")
                            .toString()
                    if (entry.isDirectory) {
                        target.mkdirs()
                        continue
                    }
                    target.parentFile?.let { if (!it.isDirectory) it.mkdirs() }
                    archive.getInputStream(entry).use { input ->
                        FileOutputStream(target).use { output ->
                            val buffer = ByteArray(8192)
                            while (true) {
                                val read = input.read(buffer)
                                if (read < 0) break
                                output.write(buffer, 0, read)
                            }
                        }
                    }
                    count++
                }
                return JSONObject().put("ok", true).put("files", count).toString()
            }
        } catch (e: Exception) {
            return JSONObject().put("error", "解压失败：${e.javaClass.simpleName}: ${e.message}").toString()
        }
    }

    /**
     * 条目名 → dest 之内的落点；不安全（`..` 段 / 绝对路径 / 盘符 / 空名 / canonical 越界）返回 null。
     * 条目名的分隔符先统一成 '/'，Windows 打包器常写 '\'。
     */
    private fun safeEntryTarget(destDir: File, destCanonical: String, rawName: String): File? {
        if (rawName.isEmpty()) return null
        val name = rawName.replace('\\', '/')
        if (name.startsWith("/")) return null
        if (name.split('/').any { it == ".." }) return null
        if (name.split('/').any { it.isNotEmpty() && it.length >= 2 && it[1] == ':' }) return null
        val target = File(destDir, name)
        val canonical = try { target.canonicalPath } catch (_: Exception) { return null }
        if (canonical != destCanonical.removeSuffix(File.separator) && !canonical.startsWith(destCanonical)) return null
        return target
    }

    private fun execute(request: String, job: AsyncBridgeJobs.Job?): String {
        val started = System.currentTimeMillis()
        val json = try { JSONObject(request) } catch (e: Exception) {
            return errorPayload("${e.javaClass.simpleName}: ${e.message}", started)
        }
        val timeoutMs = json.optLong("timeoutMs", DEFAULT_TIMEOUT_MS).coerceAtLeast(1)
        val maxBytes = json.optInt("maxOutputBytes", DEFAULT_MAX_OUTPUT_BYTES).coerceIn(0, 2_000_000)

        val builder = try {
            if (json.optBoolean("useShell")) {
                ProcessBuilder("sh", "-c", json.getString("command"))
            } else {
                val argv = ArrayList<String>()
                argv.add(json.getString("file"))
                val args = json.optJSONArray("args")
                for (i in 0 until (args?.length() ?: 0)) argv.add(args!!.getString(i))
                ProcessBuilder(argv)
            }
        } catch (e: Exception) {
            return errorPayload("${e.javaClass.simpleName}: ${e.message}", started)
        }

        val cwdPath = json.optString("cwd")
        val cwd = try { if (cwdPath.isNotEmpty()) workspaceFile(cwdPath) else null } catch (e: Exception) {
            return errorPayload("${e.javaClass.simpleName}: ${e.message}", started)
        }
        if (cwd != null) {
            if (!cwd.isDirectory) return errorPayload("工作目录不存在：${cwd.absolutePath}", started)
            builder.directory(cwd)
        }
        val env = json.optJSONObject("env")
        if (env != null) {
            env.keys().asSequence().filter { KEY_RE.matches(it) }.forEach {
                builder.environment()[it] = env.optString(it)
            }
        }

        if (job?.cancelled?.get() == true) return cancelledPayload(started)
        val process = try {
            builder.start()
        } catch (e: Exception) {
            // EACCES / ENOEXEC 在这里出现就意味着 sepolicy 变了（§7 R14），原样交给上层判级。
            return errorPayload("${e.javaClass.simpleName}: ${e.message}", started)
        }

        job?.onCancel { process.destroyForcibly() }
        // 先读两条输出，再异步写 stdin；否则子进程输出填满管道时父进程可能卡在写入，
        // 连 waitFor 的超时都到不了。未提供 stdin 也必须关闭，通知子进程收到 EOF。
        val out = readStreamAsync(process.inputStream, maxBytes)
        val err = readStreamAsync(process.errorStream, maxBytes)
        val stdin = json.optString("stdin", "")
        Thread {
            try {
                process.outputStream.use { it.write(stdin.toByteArray()) }
            } catch (_: Exception) {
                /* 子进程没读 stdin 就退出，写会断管；退出码才是结论。 */
            }
        }.apply { isDaemon = true; start() }
        val finished = process.waitFor(timeoutMs, TimeUnit.MILLISECONDS)
        if (!finished) process.destroyForcibly()
        val cancelled = job?.cancelled?.get() == true

        val stdout = awaitCapture(out)
        val stderr = awaitCapture(err)
        return JSONObject()
            .put("exitCode", if (finished) process.exitValue() else -1)
            .put("timedOut", !finished && !cancelled)
            .put("cancelled", cancelled)
            .put("stdout", stdout.text)
            .put("stderr", stderr.text)
            .put("stdoutBytes", stdout.bytes)
            .put("stderrBytes", stderr.bytes)
            .put("truncated", stdout.truncated || stderr.truncated)
            .put("resolvedCwd", cwd?.absolutePath ?: context.cacheDir.absolutePath)
            .put("durationMs", System.currentTimeMillis() - started)
            .toString()
    }

    private class Captured(val text: String, val bytes: Int, val truncated: Boolean)

    /** 返回 (抽取线程, 结果槽)：线程写完就塞进槽的第 0 格，调用方 join 之后取。 */
    private fun readStreamAsync(source: InputStream, maxBytes: Int): Pair<Thread, Array<Captured?>> {
        val slot = arrayOfNulls<Captured>(1)
        slot[0] = Captured("", 0, false)
        val thread = Thread {
            val buffer = ByteArrayOutputStream()
            val chunk = ByteArray(8192)
            var total = 0
            var overflow = false
            try {
                while (true) {
                    val read = source.read(chunk)
                    if (read < 0) break
                    total += read
                    val room = maxBytes - buffer.size()
                    if (room > 0) {
                        buffer.write(chunk, 0, minOf(read, room))
                        if (read > room) overflow = true
                    } else {
                        overflow = true
                    }
                }
            } catch (_: Exception) {
                /* destroyForcibly 会让流读到异常，已攒下的内容仍然有效。 */
            }
            slot[0] = Captured(String(buffer.toByteArray()), total, overflow || total > maxBytes)
        }.apply { isDaemon = true }
        thread.start()
        return thread to slot
    }

    private fun awaitCapture(capture: Pair<Thread, Array<Captured?>>): Captured {
        capture.first.join(READ_GRACE_MS)
        return capture.second[0] ?: Captured("", 0, false)
    }

    /**
     * vfs 命名空间的路径（`/work/demo`）映射到应用私有的 workspace 目录，并挡掉 `..` 逃逸。
     *
     * 0.7.9（症状 2）：`/sdcard/…`、`/storage/…` 是**真实路径的工作区**（MANAGE 授予后文件工具
     * 直通它自己，工作区根就是这串拼写），不能再折进私有盘 —— 折出来的
     * workspaceRoot()/sdcard/… 在盘上不存在，Bash 当场"工作目录不存在"，整个工具面瘫在入口。
     * 与 FsBridge 共用同一条拼写判定（ZcodePaths.isExternalStorageSpelling）。授予状态下子进程
     * 与 app 同 uid、同挂 /sdcard 的 FUSE，cd/ls 直接可达（0.7.4 起 tool-engine 的 Bash 守卫
     * 也按 allFilesGranted 放行同一条支路，两侧判据一致）。未授予时这里放行也只是 sh 自己报
     * Permission denied —— 拦截职责在 JS 守卫，原生只做拼写映射，不越权裁决。
     */
    private fun workspaceFile(path: String): File {
        if (ZcodePaths.isExternalStorageSpelling(path)) {
            val cleaned = path.replace('\\', '/')
            require(cleaned.split('/').none { it == ".." }) { "非法工作目录：$path" }
            return File(cleaned)
        }
        val relative = path.trimStart('/').replace('\\', '/')
        require(!relative.split('/').any { it == ".." }) { "非法工作目录：$path" }
        return File(workspaceRoot(), relative)
    }

    fun workspaceRoot(): File = ZcodePaths.workspaceRoot(context)

    private fun errorPayload(message: String, started: Long): String =
        JSONObject()
            .put("error", message)
            .put("exitCode", -1)
            .put("stdout", "")
            .put("stderr", message)
            .put("durationMs", System.currentTimeMillis() - started)
            .toString()

    private fun cancelledPayload(started: Long): String =
        JSONObject().put("exitCode", -1).put("cancelled", true).put("timedOut", false)
            .put("stdout", "").put("stderr", "").put("durationMs", System.currentTimeMillis() - started).toString()

    private companion object {
        const val DEFAULT_TIMEOUT_MS = 60_000L
        const val DEFAULT_MAX_OUTPUT_BYTES = 200_000
        const val READ_GRACE_MS = 2_000L
        val KEY_RE = Regex("^[A-Za-z_][A-Za-z0-9_]*$")
    }
}
