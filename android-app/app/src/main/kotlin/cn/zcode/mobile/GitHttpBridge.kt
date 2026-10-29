package cn.zcode.mobile

import android.util.Base64
import android.webkit.JavascriptInterface
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URL

/**
 * Git 传输的 HTTP 桥（0.6.7，装机"git 工具一直 fail to fetch"）：
 *
 * isomorphic-git 的 web 传输用 fetch 发智能 HTTP 包，而 WebView 页面在
 * https://appassets.androidplatform.net 源上——对任何 git 远端（含 GitHub）都是跨源请求，
 * git 端点普遍不答 CORS（实测 GitHub：/info/refs 无 ACAO 头、OPTIONS 预检 405），
 * fetch 层直接 "Failed to fetch"。原生 HttpURLConnection 没有 CORS 概念，这里做一个
 * 后台任务负责网络；JS 通过 start/poll/cancel 接收缓冲式响应，base64 过桥。
 *
 * 取舍（写死，与 ExecBridge 同纪律）：
 *  - 网络调用不能占住 JS 事件循环，取消任务时主动断开当前连接。
 *  - 缓冲不流式：小仓库（几十文件）的包在 MB 级，base64 过桥峰值 1.4 倍，WebView 堆装得下；
 *    真流式要跨线程泵双向流，复杂度不成比例。
 *  - 手动跟随重定向（HttpURLConnection 不跟跨协议跳转，http→https 是常态）。
 *  - Accept-Encoding 强制 identity：不代理解压，透传给 isomorphic-git 的必须是原始包。
 *  - 响应上限 128MB：git 仓库包超这个大小就不该在手机上 clone。
 */
class GitHttpBridge {
    private val jobs = AsyncBridgeJobs()

    @JavascriptInterface
    fun start(request: String): String = jobs.start { job -> execute(request, job) }

    @JavascriptInterface
    fun poll(id: String): String = jobs.poll(id)

    @JavascriptInterface
    fun cancel(id: String): Boolean = jobs.cancel(id)

    fun cancelAll() = jobs.cancelAll()

    @JavascriptInterface
    fun call(request: String): String = execute(request, null)

    private fun execute(request: String, job: AsyncBridgeJobs.Job?): String {
        val started = System.currentTimeMillis()
        var active: HttpURLConnection? = null
        try {
            val req = JSONObject(request)
            val url = req.getString("url")
            val method = req.optString("method", "GET").uppercase()
            val timeoutMs = req.optLong("timeoutMs", 300_000L)
            val reqHeaders = req.optJSONObject("headers") ?: JSONObject()
            var headers = reqHeaders.keys().asSequence().associateWith { reqHeaders.optString(it) }
            val bodyBase64 = req.optString("bodyBase64", "")

            var current = URL(url)
            var method0 = method
            var body0 = bodyBase64
            var redirects = 0
            while (true) {
                if (job?.cancelled?.get() == true) return fail("操作已取消", started)
                require(current.protocol == "http" || current.protocol == "https") { "只支持 HTTP(S) URL" }
                val conn = (current.openConnection() as HttpURLConnection).apply {
                    requestMethod = method0
                    connectTimeout = 15_000
                    readTimeout = timeoutMs.coerceIn(1_000L, 300_000L).toInt()
                    useCaches = false
                    // 必须关闭系统自动跳转，否则下面的跨源头部保护不会运行。
                    instanceFollowRedirects = false
                    setRequestProperty("Accept-Encoding", "identity")
                }
                active = conn
                job?.onCancel { conn.disconnect() }
                for ((name, value) in headers) {
                    if (value.isNotEmpty()) {
                        runCatching { conn.setRequestProperty(name, value) }
                    }
                }
                if (body0.isNotEmpty() && method0 != "GET" && method0 != "HEAD") {
                    conn.doOutput = true
                    val bytes = Base64.decode(body0, Base64.NO_WRAP)
                    conn.setFixedLengthStreamingMode(bytes.size)
                    conn.outputStream.use { it.write(bytes); it.flush() }
                }
                val code = conn.responseCode
                if (code in 300..399) {
                    val location = conn.getHeaderField("Location")
                    conn.disconnect()
                    active = null
                    if (location != null && redirects < 5) {
                        redirects += 1
                        val next = URL(current, location)
                        require(next.protocol == "http" || next.protocol == "https") { "重定向仅支持 HTTP(S)" }
                        require(!(current.protocol == "https" && next.protocol != "https")) { "拒绝 HTTPS 降级重定向" }
                        // 303/301/302 的 POST 语义按浏览器规则降级为 GET（仅对无体跳转保留原方法）
                        if (code == 303 || (code in 301..302 && method0 == "POST")) {
                            method0 = "GET"
                            body0 = ""
                        }
                        if (!sameOrigin(current, next)) {
                            // 任意自定义头都可能装凭据。跨源只保留 Git 协议所需的公开头，
                            // 并禁止把写操作的请求体经 307/308 转发给另一个主机。
                            headers = headers.filterKeys { it.lowercase() in SAFE_REDIRECT_HEADERS }
                            require(body0.isEmpty()) { "拒绝跨源转发请求体" }
                        }
                        current = next
                        continue
                    }
                    return fail("重定向 $code 无 Location 或超过 5 跳", started)
                }
                val stream = if (code >= 400) conn.errorStream ?: conn.inputStream else conn.inputStream
                val (bytes, headers) = readResponse(conn, stream)
                return JSONObject()
                    .put("statusCode", code)
                    .put("statusMessage", conn.responseMessage ?: "")
                    .put("headers", headers)
                    .put("bodyBase64", Base64.encodeToString(bytes, Base64.NO_WRAP))
                    .put("durationMs", System.currentTimeMillis() - started)
                    .toString()
            }
        } catch (e: Exception) {
            return fail("${e.javaClass.simpleName}: ${e.message}", started)
        } finally {
            active?.disconnect()
        }
    }

    private fun sameOrigin(a: URL, b: URL): Boolean =
        a.protocol.equals(b.protocol, ignoreCase = true) &&
            a.host.equals(b.host, ignoreCase = true) &&
            (if (a.port >= 0) a.port else a.defaultPort) == (if (b.port >= 0) b.port else b.defaultPort)

    /** 读全响应体 + 头（跳过逐跳头；多值头逗号合并）。 */
    private fun readResponse(
        conn: HttpURLConnection,
        stream: java.io.InputStream?,
    ): Pair<ByteArray, JSONObject> {
        val headers = JSONObject()
        for ((name, values) in conn.headerFields) {
            if (name == null) continue
            val lower = name.lowercase()
            if (lower in setOf("transfer-encoding", "content-length", "connection")) continue
            headers.put(name, values.joinToString(", "))
        }
        val out = ByteArrayOutputStream()
        if (stream != null) {
            val buf = ByteArray(65536)
            stream.use {
                while (true) {
                    val n = it.read(buf)
                    if (n < 0) break
                    out.write(buf, 0, n)
                    if (out.size() > MAX_RESPONSE_BYTES) {
                        throw IllegalStateException("响应超过 128MB 上限，手机上不支持这么大的仓库")
                    }
                }
            }
        }
        return out.toByteArray() to headers
    }

    private fun fail(message: String, started: Long): String =
        JSONObject()
            .put("error", message)
            .put("durationMs", System.currentTimeMillis() - started)
            .toString()

    private companion object {
        const val MAX_RESPONSE_BYTES = 128 * 1024 * 1024
        val SAFE_REDIRECT_HEADERS = setOf("accept", "accept-encoding", "content-type", "git-protocol", "user-agent", "cache-control")
    }
}
