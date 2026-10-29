package cn.zcode.mobile

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import org.json.JSONObject

/**
 * 内置浏览器（0.6.0，用户点名"接入内置浏览器功能"）。
 *
 * 桌面的 browser 是 CUA（Playwright 连真 Chrome）；端上没有那个运行时，这里的等价物是
 * **app 自己的 WebView 页面 + 一条同步桥**：Browser 工具（tool-engine 注册）经 zcodeBrowser
 * 打开/跳转/读取页面，用户全程看得见、随时可以自己接管点按。读页面的 evaluateJavascript
 * 必须在主线程执行，桥线程用 latch 等结果——@JavascriptInterface 调用跑在 JavaBridge 线程，
 * 阻塞它不冻 UI（与 SqliteBridge 的同步契约同一模式）。
 *
 * 约束：
 *  - 单例页面：同一时刻只有一个 BrowserActivity；navigate 复用它（用户视角是"浏览器开着一个标签"）。
 *  - read 返回 title + URL + 纯文本（body.innerText，截断），不让模型拿 HTML——token 又贵又噪。
 *  - 所有等待都有超时（默认 20s）：页面挂死时工具如实报错，模型换姿势，不无限挂。
 */
class BrowserBridge(private val context: Context) {
    private val jobs = AsyncBridgeJobs()

    @JavascriptInterface
    fun start(request: String): String = jobs.start { job ->
        val worker = Thread.currentThread()
        job.onCancel { worker.interrupt() }
        val input = JSONObject(request)
        val text = when (input.getString("action")) {
            "open" -> open(JSONObject().put("url", input.getString("url")).toString())
            "back" -> back()
            "read" -> read()
            "close" -> close()
            else -> throw IllegalArgumentException("未知浏览器操作")
        }
        JSONObject().put("content", text).toString()
    }

    @JavascriptInterface
    fun poll(id: String): String = jobs.poll(id)

    @JavascriptInterface
    fun cancel(id: String): Boolean = jobs.cancel(id)

    companion object {
        /** 当前活动的浏览器页；navigate/read 复用它，null = 没开过或用户已关。 */
        @Volatile
        var activity: BrowserActivity? = null
        const val DEFAULT_TIMEOUT_MS = 20_000L
        const val MAX_READ_CHARS = 12_000
    }

    private fun ensureOpen(url: String?): BrowserActivity? {
        val existing = activity
        if (existing != null && !existing.isFinishing) {
            if (url != null) existing.navigate(url)
            return existing
        }
        val intent = Intent(context, BrowserActivity::class.java)
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        url?.let { intent.putExtra("url", it) }
        context.startActivity(intent)
        // 等 BrowserActivity 自己注册进来（onCreate 里 set）。
        val deadline = System.currentTimeMillis() + DEFAULT_TIMEOUT_MS
        while (activity == null && System.currentTimeMillis() < deadline) {
            Thread.sleep(50)
        }
        return activity
    }

    /** 等页面加载完成（onPageFinished 会放行 latch）。返回 false = 超时。 */
    private fun awaitLoad(page: BrowserActivity, timeoutMs: Long): Boolean {
        val latch = page.awaitNextLoad()
        return try {
            latch.await(timeoutMs, TimeUnit.MILLISECONDS)
        } catch (_: InterruptedException) {
            false
        }
    }

    private fun readPage(page: BrowserActivity): String {
        val result = AtomicReference<String>("")
        val done = CountDownLatch(1)
        page.runOnUi {
            page.webView.evaluateJavascript(
                "JSON.stringify({title: document.title, url: location.href, text: (document.body ? document.body.innerText : '')})",
            ) { value -> result.set(value ?: ""); done.countDown() }
        }
        if (!done.await(DEFAULT_TIMEOUT_MS, TimeUnit.MILLISECONDS)) return ""
        // evaluateJavascript 回的是 JSON 字符串字面量（带引号转义），剥一层再交给 JSON 解析。
        val raw = result.get()
        val unquoted = if (raw.length >= 2 && raw.startsWith("\"") && raw.endsWith("\"")) {
            raw.substring(1, raw.length - 1)
                .replace("\\\"", "\"")
                .replace("\\\\", "\\")
                .replace("\\n", "\n")
                .replace("\\r", "\r")
                .replace("\\t", "\t")
        } else raw
        return unquoted
    }

    private fun payload(page: BrowserActivity, note: String): String {
        val json = readPage(page)
        fun group(pattern: String, dotAll: Boolean = false): String {
            val regex = if (dotAll) Regex(pattern, RegexOption.DOT_MATCHES_ALL) else Regex(pattern)
            return regex.find(json)?.groupValues?.getOrNull(1) ?: ""
        }
        val title = group("\"title\":\"((?:[^\"\\\\]|\\\\.)*)\"")
        val url = group("\"url\":\"((?:[^\"\\\\]|\\\\.)*)\"")
        val text = group("\"text\":\"((?:[^\"\\\\]|\\\\.)*)\"", dotAll = true)
        val clipped = if (text.length > MAX_READ_CHARS) text.take(MAX_READ_CHARS) + "…(已截断)" else text
        return listOf(
            if (note.isNotEmpty()) note else null,
            "页面标题：${title.ifEmpty { "（无）" }}",
            "地址：${url.ifEmpty { "（未知）" }}",
            "正文：",
            clipped.ifEmpty { "（页面没有可见文本）" },
        ).filterNotNull().joinToString("\n")
    }

    @JavascriptInterface
    fun open(request: String): String {
        val json = runCatching { org.json.JSONObject(request) }.getOrNull()
            ?: return fail("Browser.open 入参不是 JSON")
        val url = json.optString("url")
        if (!url.startsWith("http://") && !url.startsWith("https://")) {
            return fail("只支持 http/https 地址：$url")
        }
        val page = ensureOpen(url) ?: return fail("浏览器页面没能打开")
        return if (awaitLoad(page, json.optLong("timeoutMs", DEFAULT_TIMEOUT_MS))) {
            payload(page, "")
        } else {
            payload(page, "（加载 ${json.optLong("timeoutMs", DEFAULT_TIMEOUT_MS)}ms 内未完成，以下是当前内容）")
        }
    }

    @JavascriptInterface
    fun navigate(request: String): String = open(request)

    @JavascriptInterface
    fun back(): String {
        val page = activity ?: return fail("浏览器没有打开")
        var done = false
        page.runOnUi {
            if (page.webView.canGoBack()) page.webView.goBack()
            done = true
        }
        return if (awaitLoad(page, DEFAULT_TIMEOUT_MS) || done) payload(page, "") else fail("返回上一页超时")
    }

    @JavascriptInterface
    fun read(): String {
        val page = activity ?: return fail("浏览器没有打开")
        return payload(page, "")
    }

    @JavascriptInterface
    fun close(): String {
        val page = activity ?: return "浏览器本来就没开。"
        page.runOnUi { page.finish() }
        activity = null
        return "浏览器已关闭。"
    }

    private fun fail(message: String): String = JSONObjectError.wrap(message)
}

/** JSONObject import 的窄封装（Kotlin 里 org.json 在 JVM 侧可用）。 */
private object JSONObjectError {
    fun wrap(message: String): String = """{"error":${org.json.JSONObject.quote(message)}}"""
}

/**
 * 内置浏览器的可见页面：系统状态栏下面一条地址栏 + WebView。用户随时可以自己点——
 * 工具的 read 拿的是用户操作后的最新状态。
 */
class BrowserActivity : Activity() {

    lateinit var webView: WebView
    private val loadLatch = AtomicReference<CountDownLatch>(CountDownLatch(1))

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: android.os.Bundle?) {
        super.onCreate(savedInstanceState)
        val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        val address = TextView(this).apply {
            setPadding(24, 16, 24, 16)
            setTextSize(android.util.TypedValue.COMPLEX_UNIT_SP, 13f)
        }
        webView = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.mixedContentMode = android.webkit.WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
            webViewClient = object : WebViewClient() {
                override fun onPageFinished(view: WebView, url: String) {
                    address.text = url
                    loadLatch.getAndSet(CountDownLatch(1)).countDown()
                }

                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean = false
            }
        }
        root.addView(address, LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT))
        root.addView(webView, LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f))
        setContentView(root)

        BrowserBridge.activity = this
        val url = intent?.getStringExtra("url") ?: "https://www.google.com"
        webView.loadUrl(url)
    }

    fun navigate(url: String) {
        runOnUi { webView.loadUrl(url) }
    }

    fun awaitNextLoad(): CountDownLatch = loadLatch.get()

    fun runOnUi(block: () -> Unit) {
        runOnUiThread { block() }
    }

    override fun onDestroy() {
        if (BrowserBridge.activity === this) BrowserBridge.activity = null
        super.onDestroy()
    }
}
