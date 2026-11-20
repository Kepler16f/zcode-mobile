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
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
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
    fun ack(id: String): Boolean = jobs.ack(id)

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

    /**
     * 领取/购买页（Start Plan 赠送额度的领取入口）：桌面端用 Electron `<webview>` 承载
     * zcode.z.ai/coding-plan 并注入登录凭据，Android WebView 没有这个标签，领取页因此根本打不开。
     * 这里用同一个 BrowserActivity 承载，并在**可信源**（https://zcode.z.ai）的页面里注入
     * 上游生成的登录脚本；非可信源一概不注入。不阻塞等待加载，调用方立即返回。
     */
    @JavascriptInterface
    fun openClaimPage(request: String): String {
        val json = runCatching { JSONObject(request) }.getOrNull() ?: return fail("入参不是 JSON")
        val url = json.optString("url")
        if (!BrowserActivity.isTrustedClaimUrl(url)) return fail("领取页地址不可信：$url")
        BrowserActivity.claimScript = json.optString("script").takeIf { it.isNotBlank() }
        val existing = activity
        if (existing != null && !existing.isFinishing) {
            existing.navigate(url)
        } else {
            val intent = Intent(context, BrowserActivity::class.java)
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            intent.putExtra("url", url)
            intent.putExtra("claim", true)
            context.startActivity(intent)
        }
        return """{"ok":true}"""
    }

    /**
     * 拉起阿里云官方滑动/拼图安全验证页，由用户在 WebView 中亲自完成核验（绝不自动绕过），
     * 并通过 [pollCaptchaResult] 返回真实的一次性 `X-Aliyun-Captcha-Verify-Param`。
     */
    @JavascriptInterface
    fun openCaptchaChallenge(request: String): String {
        val json = runCatching { JSONObject(request) }.getOrNull() ?: return fail("入参不是 JSON")
        val prefix = json.optString("prefix").trim()
        val sceneId = json.optString("sceneId").trim()
        val region = json.optString("region").trim().ifEmpty { "cn" }
        val lang = json.optString("lang").trim().ifEmpty { "cn" }
        val theme = json.optString("theme").trim().ifEmpty { "dark" }
        if (prefix.isEmpty() || sceneId.isEmpty()) return fail("缺少验证码配置 prefix/sceneId")

        val challengeId = UUID.randomUUID().toString()
        BrowserActivity.captchaResults[challengeId] = JSONObject().apply { put("done", false) }
        val html = BrowserActivity.buildCaptchaHtml(prefix, sceneId, region, lang, theme)
        val intent = Intent(context, BrowserActivity::class.java).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            putExtra("captchaId", challengeId)
            putExtra("captchaHtml", html)
        }
        context.startActivity(intent)
        return JSONObject().apply {
            put("ok", true)
            put("id", challengeId)
        }.toString()
    }

    @JavascriptInterface
    fun pollCaptchaResult(id: String): String {
        val obj = BrowserActivity.captchaResults[id]
            ?: return """{"done":true,"ok":false,"error":"captcha session not found"}"""
        if (obj.optBoolean("done", false)) {
            BrowserActivity.captchaResults.remove(id)
        }
        return obj.toString()
    }

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
    private var claimMode = false
    private var captchaId: String? = null

    companion object {
        /** 领取页登录脚本：只存在内存里，页面关闭即清。 */
        @Volatile
        var claimScript: String? = null

        val captchaResults = ConcurrentHashMap<String, JSONObject>()

        fun isTrustedClaimUrl(url: String?): Boolean {
            val uri = runCatching { android.net.Uri.parse(url ?: "") }.getOrNull() ?: return false
            return uri.scheme == "https" && uri.host == "zcode.z.ai"
        }

        fun buildCaptchaHtml(
            prefix: String,
            sceneId: String,
            region: String,
            lang: String,
            theme: String,
        ): String {
            val dark = theme != "light"
            val bg = if (dark) "#111318" else "#f8fafc"
            val card = if (dark) "#1b1f27" else "#ffffff"
            val fg = if (dark) "#e5e7eb" else "#0f172a"
            val muted = if (dark) "#9ca3af" else "#475569"
            val title = if (lang == "en") "Security Verification" else "安全验证"
            val hint = if (lang == "en") {
                "Complete the verification below to claim your Start Plan promotional tokens."
            } else {
                "请完成下方安全验证，以领取 Start Plan 活动赠送额度。"
            }
            val btnLabel = if (lang == "en") "Start Verification" else "点击开始安全验证"
            val loadingLabel = if (lang == "en") "Loading security verification..." else "正在加载安全验证..."
            val quotedRegion = JSONObject.quote(region)
            val quotedPrefix = JSONObject.quote(prefix)
            val quotedSceneId = JSONObject.quote(sceneId)
            val quotedLang = JSONObject.quote(lang)
            return """<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:$bg;color:$fg;font-family:system-ui,-apple-system,sans-serif;padding:16px;box-sizing:border-box}
.card{width:100%;max-width:420px;background:$card;border-radius:14px;padding:20px;box-shadow:0 8px 28px rgba(0,0,0,.22)}
h2{margin:0 0 8px;font-size:18px}p{margin:0 0 16px;font-size:13px;color:$muted;line-height:1.5}
#captcha-box{min-height:16px}
#captcha-trigger{width:100%;height:44px;border:0;border-radius:10px;background:#2563eb;color:#fff;font-size:14px;font-weight:600;cursor:pointer}
#captcha-trigger:disabled{opacity:.65;cursor:default}
#status{margin-top:10px;font-size:12px;color:$muted;text-align:center}
#err{margin-top:12px;font-size:12px;color:#ef4444;display:none;word-break:break-word}</style>
<script>window.AliyunCaptchaConfig = { region: $quotedRegion, prefix: $quotedPrefix };</script>
<script src="https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js"></script></head>
<body><div class="card"><h2>$title</h2><p>$hint</p><div id="captcha-box"></div><button id="captcha-trigger" type="button" disabled>$loadingLabel</button><div id="status"></div><div id="err"></div></div>
<script>
(function(){
  var prefix = $quotedPrefix;
  var sceneId = $quotedSceneId;
  var region = $quotedRegion;
  var lang = $quotedLang;
  var btn = document.getElementById('captcha-trigger');
  var statusEl = document.getElementById('status');
  var submitted = false;
  function showErr(m){ var el=document.getElementById('err'); el.style.display='block'; el.textContent=m; }
  function mount(){
    if(typeof window.initAliyunCaptcha !== 'function'){
      btn.disabled = true;
      showErr('验证码组件加载失败，请检查网络后重试');
      return;
    }
    window.initAliyunCaptcha({
      SceneId: sceneId,
      prefix: prefix,
      mode: 'popup',
      element: '#captcha-box',
      button: '#captcha-trigger',
      language: lang,
      region: region,
      getInstance: function(instance){
        btn.disabled = false;
        btn.textContent = ${JSONObject.quote(btnLabel)};
        setTimeout(function(){
          if(!submitted){
            try { btn.click(); } catch(e) {}
          }
        }, 250);
      },
      captchaVerifyCallback: function(param){
        submitted = true;
        statusEl.textContent = lang === 'en' ? 'Verified, submitting...' : '验证通过，正在提交...';
        if(window.ZCodeCaptchaBridge){ window.ZCodeCaptchaBridge.onVerified(String(param || ''), region); }
        return { captchaResult: true, bizResult: true };
      },
      onBizResultCallback: function(){},
      onError: function(err){
        btn.disabled = false;
        btn.textContent = ${JSONObject.quote(btnLabel)};
        var msg = err && (err.msg || err.message) ? (err.msg || err.message) : String(err || 'unknown');
        showErr('验证初始化失败: ' + msg);
      }
    });
  }
  if(document.readyState==='complete'){ mount(); } else { window.addEventListener('load', mount); }
})();
</script></body></html>"""
        }
    }

    /** 阿里云安全验证回传桥：用户亲自完成拼图验证后把 verifyParam 带回应用并自动关闭。 */
    private inner class CaptchaShim {
        @JavascriptInterface
        fun onVerified(param: String?, region: String?) {
            val id = captchaId ?: return
            val trimmed = param?.trim().orEmpty()
            if (trimmed.isNotEmpty()) {
                BrowserActivity.captchaResults[id] = JSONObject().apply {
                    put("done", true)
                    put("ok", true)
                    put("captchaVerifyParam", trimmed)
                    put("region", region?.trim().orEmpty().ifEmpty { "cn" })
                }
            }
            runOnUiThread { finish() }
        }
    }

    /** 领取页给官网用的桥：官网购买/领取成功后调用，关闭页面回到 App。 */
    private inner class ClaimShim {
        @JavascriptInterface
        fun notifyPurchaseComplete(payload: String?) {
            runOnUiThread { finish() }
        }

        @JavascriptInterface
        fun getLang(): String = "zh-CN"
    }

    private fun injectClaimScript(url: String?) {
        val script = claimScript ?: return
        // 凭据只注入到可信源；支付页/第三方跳转页一概不注入。
        if (!isTrustedClaimUrl(url)) return
        webView.evaluateJavascript(script, null)
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: android.os.Bundle?) {
        super.onCreate(savedInstanceState)
        claimMode = intent?.getBooleanExtra("claim", false) == true
        captchaId = intent?.getStringExtra("captchaId")?.takeIf { it.isNotBlank() }
        val captchaHtml = intent?.getStringExtra("captchaHtml")?.takeIf { it.isNotBlank() }
        val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        val address = TextView(this).apply {
            setPadding(24, 16, 24, 16)
            setTextSize(android.util.TypedValue.COMPLEX_UNIT_SP, 13f)
        }
        webView = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.mixedContentMode = android.webkit.WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
            if (claimMode) addJavascriptInterface(ClaimShim(), "zcodeBridge")
            if (captchaId != null) addJavascriptInterface(CaptchaShim(), "ZCodeCaptchaBridge")
            webViewClient = object : WebViewClient() {
                override fun onPageStarted(view: WebView, url: String, favicon: android.graphics.Bitmap?) {
                    injectClaimScript(url)
                }

                override fun onPageFinished(view: WebView, url: String) {
                    address.text = if (captchaId != null) "https://zcode.z.ai" else url
                    injectClaimScript(url)
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
        if (captchaHtml != null) {
            webView.loadDataWithBaseURL("https://zcode.z.ai/", captchaHtml, "text/html", "utf-8", null)
        } else {
            val url = intent?.getStringExtra("url") ?: "https://www.google.com"
            webView.loadUrl(url)
        }
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
        val cid = captchaId
        if (cid != null) {
            val cur = BrowserActivity.captchaResults[cid]
            if (cur == null || !cur.optBoolean("done", false)) {
                BrowserActivity.captchaResults[cid] = JSONObject().apply {
                    put("done", true)
                    put("ok", false)
                    put("cancelled", true)
                }
            }
        }
        if (claimMode) {
            // 领取页写进 localStorage 的登录凭据不能留在磁盘上。
            claimScript = null
            android.webkit.WebStorage.getInstance().deleteAllData()
        }
        super.onDestroy()
    }
}
