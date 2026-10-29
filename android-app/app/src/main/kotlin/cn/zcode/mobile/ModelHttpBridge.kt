package cn.zcode.mobile

import android.util.Base64
import android.webkit.JavascriptInterface
import org.json.JSONObject
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.io.PushbackInputStream
import java.net.HttpURLConnection
import java.net.InetAddress
import java.net.URL
import java.util.UUID
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import java.util.zip.GZIPInputStream
import java.util.zip.Inflater
import java.util.zip.InflaterInputStream

/**
 * 模型专用流桥：网络在后台运行，有界队列背压，JS 只获取已经到达的字节。
 *
 * 为什么需要它：移动端页面在 https://appassets.androidplatform.net 源上，对任何模型网关
 * 都是跨源请求，而 MiniMax 这类 Anthropic 兼容网关的鉴权头会触发 CORS 预检（OPTIONS），
 * 网关不答 ACAO 时 WebView 的 fetch 直接报 Failed to fetch。原生 HttpURLConnection 没有
 * CORS 概念，所以模型请求全部走这里。
 *
 * 取舍（写死，与 GitHttpBridge 同纪律）：
 *  - 网络调用不能占住 JS 事件循环；取消时主动断开连接**并关闭输出流**——只有 disconnect
 *    对卡在请求体写入里的连接不保证能唤醒。
 *  - 手动跟随重定向：模型网关按区域跳转是常态，3xx 直接当失败会让"接得上但说连不上"。
 *  - 请求总时限：readTimeout 只是单次阻塞读的时限，服务端每 4 分钟吐一个字节就能把连接
 *    无限续住，所以另加一条整条请求的 deadline。
 *  - 目标地址收敛：桥是全局注入的，能对任意 URL 发 POST 并把响应读回来。不加约束就是
 *    一个可读 SSRF 原语，所以禁止指向本机与链路本地（云元数据），但保留局域网地址——
 *    Ollama / LM Studio 跑在 192.168.x.x 是合法用法。
 */
class ModelHttpBridge {
    private class Job {
        val queue = ArrayBlockingQueue<ByteArray>(64)
        @Volatile var headers: JSONObject? = null
        @Volatile var done = false
        @Volatile var cancelled = false
        @Volatile var error: String? = null
        @Volatile var connection: HttpURLConnection? = null
        @Volatile var output: OutputStream? = null
        @Volatile var lastPoll = System.currentTimeMillis()
        @Volatile var finishedAt = 0L
    }

    private val jobs = ConcurrentHashMap<String, Job>()

    @JavascriptInterface
    @Synchronized fun start(request: String): String {
        sweepStaleJobs()
        if (activeJobCount() >= MAX_JOBS) return JSONObject().put("error", "模型网络任务过多").toString()
        val id = UUID.randomUUID().toString()
        val job = Job()
        jobs[id] = job
        Thread { runJob(job, request) }.apply { isDaemon = true; start() }
        return JSONObject().put("id", id).toString()
    }

    @JavascriptInterface
    @Synchronized fun poll(id: String): String {
        val job = jobs[id] ?: return JSONObject().put("error", "模型网络任务不存在").toString()
        job.lastPoll = System.currentTimeMillis()
        val out = job.headers?.let { JSONObject(it.toString()) } ?: JSONObject()
        val bytes = job.queue.poll()
        if (bytes != null) out.put("bodyBase64", Base64.encodeToString(bytes, Base64.NO_WRAP))
        val terminal = job.done && job.queue.isEmpty()
        out.put("done", terminal)
        if (terminal) {
            job.error?.let { out.put("error", it) }
            jobs.remove(id, job)
        }
        return out.toString()
    }

    @JavascriptInterface
    fun cancel(id: String): Boolean {
        // 取消**不**把 job 从表里摘掉：摘掉之后 cancelAll() 与过期扫描都看不见它，
        // 那条原生线程就没人管了（连接泄漏）。只打标记，由 poll 收口或过期扫描再移除。
        val job = jobs[id] ?: return false
        markCancelled(job)
        return true
    }

    fun cancelAll() { jobs.values.toList().forEach { markCancelled(it) } }

    private fun markCancelled(job: Job) {
        if (job.cancelled) return
        job.cancelled = true
        job.queue.clear()
        // 关闭输出流 + 断开连接都要放到别的线程：close/disconnect 可能阻塞，不能占住
        // WebView 的 JSInterface 线程。
        Thread {
            runCatching { job.output?.close() }
            runCatching { job.connection?.disconnect() }
        }.apply { isDaemon = true; start() }
    }

    /** 只统计还在跑的：已收尾或已取消的 job 不该占额度，否则取消几次就打满上限了。 */
    private fun activeJobCount(): Int = jobs.values.count { !it.done && !it.cancelled }

    /**
     * 回收僵尸 job：
     *  - 读取方早就消失（JS 崩了/页面被回收）→ 停掉连接，别让原生线程一直占着。
     *  - 已经跑完但没人来 poll 取结果 → 过了保留期就扔掉。
     */
    @Synchronized
    private fun sweepStaleJobs() {
        val now = System.currentTimeMillis()
        jobs.entries.toList().forEach { (id, job) ->
            if (job.done) {
                // 已经收尾但没人来 poll 取结果 → 过保留期就扔掉。
                if (job.finishedAt != 0L && now - job.finishedAt > RETENTION_MS) {
                    jobs.remove(id, job)
                }
            } else if (now - job.lastPoll > IDLE_LIMIT_MS) {
                // 读取方早就消失（JS 崩了/页面被回收）→ 停掉连接，别让原生线程一直占着。
                // 注意：取消后**不能**立刻从表里摘 —— 线程可能还阻塞在读上，摘了就没人管它了，
                // 连接与线程都会泄漏。摘除交给线程自己跑完（job.done）之后的扫描。
                markCancelled(job)
            }
        }
    }

    private fun runJob(job: Job, request: String) {
        val deadlineAt = System.currentTimeMillis() + DEADLINE_MS
        var phase = "解析请求"
        try {
            val req = JSONObject(request)
            val url = URL(req.getString("url"))
            require(url.protocol == "http" || url.protocol == "https") { "仅支持 HTTP(S)" }
            require(url.userInfo == null) { "URL 不允许包含凭据" }
            val headers = readHeaders(req.optJSONObject("headers"))
            val body = req.optString("body", "")
            val bodyBytes = body.toByteArray(Charsets.UTF_8)
            require(bodyBytes.size <= MAX_REQUEST_BYTES) { "模型请求体超过 32 MiB 上限" }

            var current = url
            var method = "POST"
            var payload = bodyBytes
            var outgoing = headers
            var redirects = 0

            while (true) {
                if (job.cancelled) return
                phase = "校验目标地址"
                requireEndpointAllowed(current)
                require(System.currentTimeMillis() < deadlineAt) { "模型请求超时" }

                phase = "建立连接"
                val remaining = deadlineAt - System.currentTimeMillis()
                require(remaining > 0) { "模型请求超时" }
                val conn = current.openConnection() as HttpURLConnection
                job.connection = conn
                try {
                    conn.requestMethod = method
                    conn.connectTimeout = minOf(CONNECT_TIMEOUT_MS.toLong(), remaining).coerceAtLeast(1_000L).toInt()
                    conn.readTimeout = minOf(READ_TIMEOUT_MS.toLong(), remaining).coerceAtLeast(1_000L).toInt()
                    conn.instanceFollowRedirects = false
                    conn.useCaches = false
                    conn.setRequestProperty("Accept-Encoding", "identity")
                    for ((name, value) in outgoing) conn.setRequestProperty(name, value)

                    if (method != "GET" && method != "HEAD") {
                        phase = "写入请求体"
                        conn.doOutput = true
                        conn.setFixedLengthStreamingMode(payload.size)
                        val out = conn.outputStream
                        job.output = out
                        try {
                            var offset = 0
                            while (offset < payload.size) {
                                if (job.cancelled) throw IOException("模型请求已取消")
                                val size = minOf(WRITE_CHUNK_BYTES, payload.size - offset)
                                out.write(payload, offset, size)
                                out.flush()
                                offset += size
                            }
                        } finally {
                            job.output = null
                            runCatching { out.close() }
                        }
                    }
                    if (job.cancelled) return

                    phase = "读取响应"
                    val status = conn.responseCode
                    if (status in 300..399) {
                        val location = conn.getHeaderField("Location")
                        conn.disconnect()
                        job.connection = null
                        if (location.isNullOrBlank()) throw IOException("模型网关返回 " + status + " 但没有 Location")
                        require(redirects < MAX_REDIRECTS) { "模型网关重定向超过 " + MAX_REDIRECTS + " 跳" }
                        val next = URL(current, location)
                        require(next.protocol == "http" || next.protocol == "https") { "重定向仅支持 HTTP(S)" }
                        require(!(current.protocol == "https" && next.protocol != "https")) { "拒绝 HTTPS 降级重定向" }
                        redirects += 1
                        // 303 一律改 GET；301/302 且原来是 POST 也改 GET（浏览器规则）。
                        if (status == 303 || (status in 301..302 && method == "POST")) {
                            method = "GET"
                            payload = ByteArray(0)
                        }
                        if (!sameOrigin(current, next)) {
                            // 凭据头不能跟着跳到另一个主机去。
                            outgoing = outgoing.filterKeys { it.lowercase() !in SENSITIVE_HEADERS }
                            require(payload.isEmpty()) { "拒绝跨源转发模型请求体" }
                        }
                        current = next
                        continue
                    }

                    val responseHeaders = JSONObject()
                    for ((name, values) in conn.headerFields) {
                        if (name != null && name.lowercase() !in OMIT_RESPONSE_HEADERS) {
                            responseHeaders.put(name, values.joinToString(", "))
                        }
                    }
                    job.headers = JSONObject().put("status", status).put("headers", responseHeaders)
                    val raw = if (status >= 400) conn.errorStream else conn.inputStream
                    val stream = decodeStream(raw, conn.getHeaderField("Content-Encoding"))
                    var total = 0L
                    stream?.use { input ->
                        val buffer = ByteArray(16 * 1024)
                        while (!job.cancelled) {
                            require(System.currentTimeMillis() < deadlineAt) { "模型请求超时" }
                            val count = input.read(buffer)
                            if (count < 0) break
                            total += count
                            require(total <= MAX_RESPONSE_BYTES) { "模型响应超过 64 MiB" }
                            val chunk = buffer.copyOf(count)
                            while (!job.cancelled && !job.queue.offer(chunk, 100, TimeUnit.MILLISECONDS)) {
                                require(System.currentTimeMillis() < deadlineAt) { "模型请求超时" }
                                require(System.currentTimeMillis() - job.lastPoll <= IDLE_LIMIT_MS) { "模型读取方已离线" }
                            }
                        }
                    }
                    return
                } finally {
                    job.output = null
                    conn.disconnect()
                    job.connection = null
                }
            }
        } catch (e: Exception) {
            // 跨桥只传错误类型 + 阶段，不传 URL 与请求头（异常文本里可能有）。
            if (!job.cancelled) {
                val detail = redact(e.message)
                val type = e.javaClass.simpleName
                job.error = if (detail.isNullOrEmpty())
                    "原生模型请求失败（" + phase + "）：" + type
                else
                    "原生模型请求失败（" + phase + "）：" + type + "：" + detail
            }
        } finally {
            job.done = true
            job.finishedAt = System.currentTimeMillis()
            job.connection = null
            job.output = null
        }
    }

    /** 读请求头并卡住上限：头数量、单值长度、以及换行注入。 */
    private fun readHeaders(headers: JSONObject?): Map<String, String> {
        if (headers == null) return emptyMap()
        require(headers.length() <= MAX_HEADER_COUNT) { "模型请求头过多" }
        val out = LinkedHashMap<String, String>()
        val keys = headers.keys()
        while (keys.hasNext()) {
            val name = keys.next()
            val value = headers.optString(name, "")
            require(name.isNotBlank()) { "模型请求头名称为空" }
            require(name.length <= MAX_HEADER_NAME_LENGTH) { "模型请求头名称过长" }
            require(value.length <= MAX_HEADER_VALUE_LENGTH) { "模型请求头 " + name + " 的值过长" }
            require(!name.contains('\n') && !name.contains('\r')) { "模型请求头名称含非法字符" }
            require(!value.contains('\n') && !value.contains('\r')) { "模型请求头 " + name + " 的值含非法字符" }
            out[name] = value
        }
        return out
    }

    /** 服务端可能无视 Accept-Encoding: identity 仍回压缩流；不解压的话 JS 侧会拿到乱码。 */
    private fun decodeStream(raw: InputStream?, encoding: String?): InputStream? {
        if (raw == null) return null
        val enc = encoding?.trim()?.lowercase().orEmpty()
        return try {
            when {
                enc.isEmpty() || enc == "identity" -> raw
                enc == "gzip" || enc == "x-gzip" -> GZIPInputStream(raw)
                enc == "deflate" -> inflateStream(raw)
                else -> throw IOException("模型响应使用了不支持的压缩格式：" + enc)
            }
        } catch (e: Exception) {
            runCatching { raw.close() }
            throw e
        }
    }

    /**
     * deflate 有两种线上格式：带 zlib 包装（RFC 1950）和裸流（RFC 1951）。
     * InflaterInputStream 默认按 zlib 解，碰到裸流会抛 ZipException —— 响应就废了。
     * 先窥两个字节区分：zlib 头 CMF 低 4 位是 8，且 (CMF<<8|FLG) % 31 == 0。
     */
    private fun inflateStream(raw: InputStream): InputStream {
        val pushback = PushbackInputStream(raw, 2)
        val b0 = pushback.read()
        val b1 = pushback.read()
        if (b0 < 0 || b1 < 0) {
            // 空响应：交回去让上层读到 EOF。
            return pushback
        }
        pushback.unread(b1)
        pushback.unread(b0)
        val zlibHeader = (b0 and 0x0f) == 8 && (((b0 shl 8) or b1) % 31 == 0)
        return if (zlibHeader) InflaterInputStream(pushback) else InflaterInputStream(pushback, Inflater(true))
    }

    /**
     * 目标地址收敛（防 SSRF）：
     *  - 禁止本机与链路本地：127/8、::1、localhost、0/8、169.254/16（含云元数据
     *    169.254.169.254）、IPv6 fe80::/10。Android 上 127.0.0.1 指的是手机自己，
     *    不是用户的 Ollama，禁掉不会误伤。
     *  - 保留局域网：10/8、172.16/12、192.168/16（本地模型服务在 192.168.x.x 是合法用法）。
     *  - DNS rebinding：域名解析出来的 IP 才是真正要连的地址，所以解析后逐个再判一遍，
     *    只要有一个命中拒绝规则就整体拒绝（不挑一个"干净"的 IP 去连）。
     */
    private fun requireEndpointAllowed(url: URL) {
        // URL.getHost() 对 IPv6 字面量保留方括号（[::1]），先剥掉再判、也再拿去做解析。
        val host = url.host.trim().removePrefix("[").removeSuffix("]")
        require(host.isNotBlank()) { "模型端点缺少主机名" }
        require(!isForbiddenHost(host)) { "模型端点不允许指向本机或链路本地地址" }
        val resolved = try {
            InetAddress.getAllByName(host)
        } catch (e: Exception) {
            throw IOException("模型端点域名解析失败：" + e.javaClass.simpleName)
        }
        for (address in resolved) {
            require(!isForbiddenAddress(address)) { "模型端点解析到本机或链路本地地址，已拒绝连接" }
        }
    }

    private fun isForbiddenAddress(address: InetAddress): Boolean {
        if (address.isAnyLocalAddress || address.isLoopbackAddress || address.isLinkLocalAddress) return true
        val bytes = address.address
        if (bytes.size == 4) {
            val b0 = bytes[0].toInt() and 0xff
            // 0/8：isAnyLocalAddress 只覆盖 0.0.0.0 本身，整段还得自己判。
            if (b0 == 0) return true
            if (b0 == 127) return true
            // 169.254/16：链路本地，含 AWS/GCP 云元数据 169.254.169.254。
            if (b0 == 169 && (bytes[1].toInt() and 0xff) == 254) return true
            return false
        }
        if (bytes.size == 16) {
            // ::ffff:a.b.c.d（IPv4 映射）→ 按 IPv4 规则判，否则能绕过 127/8 的检查。
            var mapped = true
            for (i in 0 until 10) {
                if (bytes[i].toInt() and 0xff != 0) { mapped = false; break }
            }
            if (mapped && (bytes[10].toInt() and 0xff) == 0xff && (bytes[11].toInt() and 0xff) == 0xff) {
                return isForbiddenAddress(InetAddress.getByAddress(bytes.copyOfRange(12, 16)))
            }
            // fe80::/10 链路本地（含 fe80–febf 整段，不只是 fe80: 前缀）。
            if ((bytes[0].toInt() and 0xff) == 0xfe && ((bytes[1].toInt() and 0xf0) == 0x80)) return true
        }
        return false
    }

    private fun isForbiddenHost(rawHost: String): Boolean {
        val host = rawHost.trim().removePrefix("[").removeSuffix("]").lowercase()
        if (host.isEmpty()) return true
        if (host == "localhost" || host.endsWith(".localhost")) return true
        // ::ffff:a.b.c.d（IPv4 映射的点分写法）→ 剥掉前缀按 IPv4 判。
        // 必须放在 expandIpv6 前面：点分十进制的尾段不是合法的十六进制段，
        // expandIpv6 会解析失败返回 null，那样就会掉到「允许」分支。
        if (host.startsWith("::ffff:")) {
            val tail = host.removePrefix("::ffff:")
            val v4 = ipv4ToLong(tail)
            if (v4 != null) return isForbiddenIpv4Value(v4)
        }
        // IPv6 字面量：先展开成 8 段再判，避免 "0:0:0:0:0:0:0:1" 这类写法绕过检查。
        val hextets = expandIpv6(host)
        if (hextets != null) return isForbiddenIpv6(hextets)
        val v4 = ipv4ToLong(host)
        if (v4 != null) {
            return isForbiddenIpv4Value(v4)
        }
        return false
    }

    /** IPv6 字面量展开成 8 段 16 进制；不是 IPv6 字面量则返回 null。 */
    private fun expandIpv6(host: String): IntArray? {
        if (!host.contains(':')) return null
        var h = host
        val zone = h.indexOf('%')
        if (zone >= 0) h = h.substring(0, zone)
        val halves = h.split("::")
        if (halves.size > 2) return null
        val head = if (halves[0].isEmpty()) emptyList() else halves[0].split(':')
        val tail = if (halves.size == 1) emptyList() else (if (halves[1].isEmpty()) emptyList() else halves[1].split(':'))
        if (halves.size == 1 && head.size != 8) return null
        if (head.size + tail.size > 8) return null
        val out = ArrayList<Int>(8)
        for (part in head) { out.add(part.toIntOrNull(16) ?: return null) }
        repeat(8 - head.size - tail.size) { out.add(0) }
        for (part in tail) { out.add(part.toIntOrNull(16) ?: return null) }
        return if (out.size == 8) out.toIntArray() else null
    }

    private fun isForbiddenIpv6(hextets: IntArray): Boolean {
        if (hextets.all { it == 0 }) return true // ::
        if (hextets.take(7).all { it == 0 } && hextets[7] == 1) return true // ::1
        if ((hextets[0] and 0xffc0) == 0xfe80) return true // fe80::/10 链路本地
        // ::ffff:a.b.c.d → 交给 IPv4 规则判。
        // 注意 ::ffff:7f00:1 是十六进制写法：第 6 段是 0x7f00，不是点分十进制。
        // 所以不能只认 ::ffff:a.b.c.d —— 必须把后两段当 IPv4 数值来判掩码。
        if (hextets.take(5).all { it == 0 } && hextets[5] == 0xffff) {
            val v4 = ((hextets[6].toLong() and 0xffff) shl 16) or (hextets[7].toLong() and 0xffff)
            if (isForbiddenIpv4Value(v4)) return true
        }
        return false
    }

    /** 按 32 位 IPv4 数值判断：127/8、0/8、169.254/16 命中即拒。 */
    private fun isForbiddenIpv4Value(v4: Long): Boolean {
        if ((v4 and 0xff000000L) == 0x7f000000L) return true // 127/8
        if ((v4 and 0xff000000L) == 0x00000000L) return true // 0/8
        if ((v4 and 0xffff0000L) == 0xa9fe0000L) return true // 169.254/16，含云元数据
        return false
    }

    private fun ipv4ToLong(host: String): Long? {
        val parts = host.split(".")
        if (parts.size != 4) return null
        var value = 0L
        for (part in parts) {
            if (part.isEmpty() || part.length > 3 || !part.all { it.isDigit() }) return null
            val n = part.toInt()
            if (n > 255) return null
            value = (value shl 8) or n.toLong()
        }
        return value
    }

    private fun sameOrigin(a: URL, b: URL): Boolean =
        a.protocol.equals(b.protocol, ignoreCase = true) &&
            a.host.equals(b.host, ignoreCase = true) &&
            (if (a.port >= 0) a.port else a.defaultPort) == (if (b.port >= 0) b.port else b.defaultPort)

    /** 异常文本里可能带 URL（甚至带 Key 的 query），跨桥前把 URL 抹掉。 */
    private fun redact(message: String?): String? {
        if (message.isNullOrBlank()) return null
        val cleaned = URL_PATTERN.replace(message, "<url>").replace('\n', ' ').replace('\r', ' ').trim()
        if (cleaned.isEmpty()) return null
        return if (cleaned.length > MAX_ERROR_CHARS) cleaned.take(MAX_ERROR_CHARS) + "…" else cleaned
    }

    private companion object {
        const val MAX_JOBS = 32
        const val CONNECT_TIMEOUT_MS = 15_000
        const val READ_TIMEOUT_MS = 300_000
        /** 整条请求的总时限：readTimeout 只是单次阻塞读的时限，挡不住"慢慢滴水"的响应。 */
        const val DEADLINE_MS = 600_000L
        const val IDLE_LIMIT_MS = 600_000L
        const val RETENTION_MS = 60_000L
        const val MAX_REDIRECTS = 5
        const val MAX_REQUEST_BYTES = 32 * 1024 * 1024
        const val MAX_RESPONSE_BYTES = 64 * 1024 * 1024
        const val MAX_HEADER_COUNT = 64
        const val MAX_HEADER_NAME_LENGTH = 256
        const val MAX_HEADER_VALUE_LENGTH = 8 * 1024
        const val WRITE_CHUNK_BYTES = 64 * 1024
        const val MAX_ERROR_CHARS = 200
        val OMIT_RESPONSE_HEADERS = setOf("content-length", "transfer-encoding", "connection", "content-encoding")
        val SENSITIVE_HEADERS = setOf(
            "authorization", "proxy-authorization", "x-api-key", "api-key",
            "x-goog-api-key", "cookie", "x-auth-token",
        )
        val URL_PATTERN = Regex("(?i)https?://\\S+")
    }
}
