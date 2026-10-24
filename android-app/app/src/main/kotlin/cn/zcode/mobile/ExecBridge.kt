package cn.zcode.mobile

import android.content.Context
import android.webkit.JavascriptInterface
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.InputStream
import java.util.concurrent.TimeUnit

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
 *  3. 同步通道被 JS 占住就没有中途取消：@JavascriptInterface 是阻塞调用，取消只能等
 *     timeoutMs 到。这里如实回 timedOut，不假装能中断。
 */
class ExecBridge(private val context: Context) {

    @JavascriptInterface
    fun exec(request: String): String {
        val started = System.currentTimeMillis()
        val json = JSONObject(request)
        val timeoutMs = json.optLong("timeoutMs", DEFAULT_TIMEOUT_MS)
        val maxBytes = json.optInt("maxOutputBytes", DEFAULT_MAX_OUTPUT_BYTES)

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
        val cwd = if (cwdPath.isNotEmpty()) workspaceFile(cwdPath) else null
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

        val process = try {
            builder.start()
        } catch (e: Exception) {
            // EACCES / ENOEXEC 在这里出现就意味着 sepolicy 变了（§7 R14），原样交给上层判级。
            return errorPayload("${e.javaClass.simpleName}: ${e.message}", started)
        }

        val stdin = json.optString("stdin").takeIf { it.isNotEmpty() }
        if (stdin != null) {
            try {
                process.outputStream.use { it.write(stdin.toByteArray()) }
            } catch (_: Exception) {
                /* 子进程没读 stdin 就退出，写会断管；退出码才是结论。 */
            }
        }

        // 并发抽两条流：见类注释第 2 条。
        val out = readStreamAsync(process.inputStream, maxBytes)
        val err = readStreamAsync(process.errorStream, maxBytes)
        val finished = process.waitFor(timeoutMs, TimeUnit.MILLISECONDS)
        if (!finished) process.destroyForcibly()

        val stdout = awaitCapture(out)
        val stderr = awaitCapture(err)
        return JSONObject()
            .put("exitCode", if (finished) process.exitValue() else -1)
            .put("timedOut", !finished)
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

    /** vfs 命名空间的路径（`/work/demo`）映射到应用私有的 workspace 目录，并挡掉 `..` 逃逸。 */
    private fun workspaceFile(path: String): File {
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

    private companion object {
        const val DEFAULT_TIMEOUT_MS = 60_000L
        const val DEFAULT_MAX_OUTPUT_BYTES = 200_000
        const val READ_GRACE_MS = 2_000L
        val KEY_RE = Regex("^[A-Za-z_][A-Za-z0-9_]*$")
    }
}
