package cn.zcode.mobile

import android.annotation.SuppressLint
import android.app.Activity
import android.app.Application
import android.app.Dialog
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.util.TypedValue
import android.view.Gravity
import android.view.ViewGroup
import android.view.Window
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
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
class BrowserBridge(
    private val context: Context,
    private val activityProvider: () -> Activity? = { null },
) {
    private val jobs = AsyncBridgeJobs()
    @Volatile
    private var activeCaptchaSession: CaptchaDialogSession? = null

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
     * 拉起阿里云官方滑动/拼图安全验证小浮窗（对齐桌面客户端无感优先策略）：
     *  - 先以全透明不挡触控态静默运行 `startTracelessVerification()`，无感通过时零弹窗闪烁；
     *  - 仅在阿里云要求滑块/拼图二次核验时渐显居中圆角小窗口，由用户本人完成核验（绝不自动绕过），
     *    并通过 [pollCaptchaResult] 返回真实的一次性 `X-Aliyun-Captcha-Verify-Param`。
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

        val hostActivity = (activityProvider() ?: activity)?.takeIf { !it.isFinishing && !it.isDestroyed }
            ?: return fail("当前界面不可用，请返回主窗口重试")

        val challengeId = UUID.randomUUID().toString()
        BrowserActivity.captchaResults[challengeId] = JSONObject().apply { put("done", false) }
        val html = BrowserActivity.buildCaptchaHtml(prefix, sceneId, region, lang, theme)
        val dark = theme != "light"
        hostActivity.runOnUiThread {
            if (hostActivity.isFinishing || hostActivity.isDestroyed) {
                BrowserActivity.captchaResults[challengeId] = JSONObject().apply {
                    put("done", true)
                    put("ok", false)
                    put("cancelled", true)
                }
                return@runOnUiThread
            }
            activeCaptchaSession?.close()
            val session = CaptchaDialogSession(
                activity = hostActivity,
                challengeId = challengeId,
                html = html,
                dark = dark,
                lang = lang,
            ) { finished ->
                if (activeCaptchaSession === finished) {
                    activeCaptchaSession = null
                }
            }
            activeCaptchaSession = session
            session.start()
        }
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
            val fg = if (dark) "#e5e7eb" else "#0f172a"
            val muted = if (dark) "#9ca3af" else "#475569"
            val hint = if (lang == "en") {
                "Slide or tap below to complete security verification."
            } else {
                "请完成下方安全验证以继续操作"
            }
            val btnLabel = if (lang == "en") "Start Verification" else "点击唤起安全验证"
            val loadingLabel = if (lang == "en") "Loading verification..." else "正在加载验证组件..."
            val quotedRegion = JSONObject.quote(region)
            val quotedPrefix = JSONObject.quote(prefix)
            val quotedSceneId = JSONObject.quote(sceneId)
            val quotedLang = JSONObject.quote(lang)
            return """<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<style>html,body{margin:0;padding:0;width:100%;height:100%;background:transparent;color:$fg;font-family:system-ui,-apple-system,sans-serif;overflow:hidden}
.wrap{width:100%;height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:8px 14px 14px;box-sizing:border-box}
p.hint{margin:0 0 10px;font-size:12px;color:$muted;line-height:1.45;text-align:center}
#captcha-box{min-height:8px;width:100%;display:flex;align-items:center;justify-content:center}
#captcha-trigger{width:100%;max-width:280px;height:40px;border:0;border-radius:10px;background:#2563eb;color:#fff;font-size:13px;font-weight:600;cursor:pointer}
#captcha-trigger:disabled{opacity:.65;cursor:default}
#status{margin-top:8px;font-size:12px;color:$muted;text-align:center}
#err{margin-top:8px;font-size:12px;color:#ef4444;display:none;word-break:break-word;text-align:center}
#aliyunCaptcha-mask{background:transparent!important}
#aliyunCaptcha-window-popup{box-shadow:none!important;max-width:100%!important}</style>
<script>window.AliyunCaptchaConfig = { region: $quotedRegion, prefix: $quotedPrefix };</script>
<script src="https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js"></script></head>
<body><div class="wrap"><p class="hint" id="hint">$hint</p><div id="captcha-box"></div><button id="captcha-trigger" type="button" disabled>$loadingLabel</button><div id="status"></div><div id="err"></div></div>
<script>
(function(){
  var prefix = $quotedPrefix;
  var sceneId = $quotedSceneId;
  var region = $quotedRegion;
  var lang = $quotedLang;
  var btn = document.getElementById('captcha-trigger');
  var hintEl = document.getElementById('hint');
  var statusEl = document.getElementById('status');
  var errEl = document.getElementById('err');
  var submitted = false;
  var interactiveNotified = false;
  var autoPopupClicked = false;
  function notifyInteractive(){
    if(submitted || interactiveNotified) return;
    interactiveNotified = true;
    if(window.ZCodeCaptchaBridge && typeof window.ZCodeCaptchaBridge.onInteractive === 'function'){
      window.ZCodeCaptchaBridge.onInteractive();
    }
  }
  function isPopupVisible(){
    var popup = document.getElementById('aliyunCaptcha-window-popup');
    if(popup){
      var st = window.getComputedStyle(popup);
      if(st.display !== 'none' && st.visibility !== 'hidden' && Number(st.opacity || '1') > 0.05 && popup.offsetWidth > 40 && popup.offsetHeight > 40){
        return true;
      }
    }
    var box = document.getElementById('captcha-box');
    if(box && box.children){
      for(var i = 0; i < box.children.length; i++){
        var c = box.children[i];
        var cs = window.getComputedStyle(c);
        if(cs.display !== 'none' && cs.visibility !== 'hidden' && c.offsetWidth > 60 && c.offsetHeight > 60){
          return true;
        }
      }
    }
    return false;
  }
  var watchTimer = setInterval(function(){
    if(submitted){ clearInterval(watchTimer); return; }
    if(isPopupVisible()){
      btn.style.display = 'none';
      hintEl.style.display = 'none';
      notifyInteractive();
    } else if(interactiveNotified){
      btn.style.display = 'block';
      hintEl.style.display = 'block';
    }
  }, 100);
  var fallbackRevealTimer = setTimeout(function(){
    if(!submitted){ notifyInteractive(); }
  }, 1800);
  function showErr(m){ notifyInteractive(); errEl.style.display='block'; errEl.textContent=m; }
  function clearErr(){ errEl.style.display='none'; errEl.textContent=''; }
  function mount(){
    if(typeof window.initAliyunCaptcha !== 'function'){
      btn.disabled = true;
      showErr(lang === 'en' ? 'Failed to load verification SDK. Check your network and retry.' : '验证码组件加载失败，请检查网络后重试');
      return;
    }
    // 严格对齐官方桌面端 AliyunCaptcha V3 前后端分离模式（immediate: true）：
    // 先静默执行 startTracelessVerification()，无感通过则直接回传且不显示小窗；
    // 需滑块/拼图二次验证时立即通知原生层渐显居中紧凑浮窗。
    window.initAliyunCaptcha({
      SceneId: sceneId,
      prefix: prefix,
      mode: 'popup',
      element: '#captcha-box',
      button: '#captcha-trigger',
      language: lang,
      region: region,
      showErrorTip: false,
      getInstance: function(instance){
        btn.disabled = false;
        btn.textContent = ${JSONObject.quote(btnLabel)};
        setTimeout(function(){
          if(submitted) return;
          clearErr();
          try {
            if(instance && typeof instance.startTracelessVerification === 'function'){
              instance.startTracelessVerification();
            } else {
              notifyInteractive();
              btn.click();
            }
          } catch(e) {
            notifyInteractive();
            try { btn.click(); } catch(_) {}
          }
        }, 60);
      },
      success: function(captchaVerifyParam){
        var param = String(captchaVerifyParam || '').trim();
        if(!param){
          btn.disabled = false;
          showErr(lang === 'en' ? 'Empty verification result. Tap the button to retry.' : '安全验证未返回有效凭证，请点击按钮重试');
          return;
        }
        submitted = true;
        clearInterval(watchTimer);
        clearTimeout(fallbackRevealTimer);
        clearErr();
        statusEl.textContent = lang === 'en' ? 'Verified, submitting...' : '验证通过，正在提交...';
        if(window.ZCodeCaptchaBridge){ window.ZCodeCaptchaBridge.onVerified(param, region); }
      },
      fail: function(result){
        if(submitted) return;
        var code = result && typeof result.verifyCode === 'string' ? result.verifyCode : '';
        if(code === 'T006' || (result && result.verifyResult === true)){
          return;
        }
        notifyInteractive();
        btn.disabled = false;
        btn.textContent = ${JSONObject.quote(btnLabel)};
        if(!autoPopupClicked && !isPopupVisible()){
          autoPopupClicked = true;
          try { btn.click(); } catch(_) {}
        }
        statusEl.textContent = lang === 'en'
          ? 'Please complete the puzzle verification.'
          : '请完成滑块/拼图验证，若未弹出可点击按钮唤起';
      },
      onError: function(err){
        if(submitted) return;
        btn.disabled = false;
        btn.textContent = ${JSONObject.quote(btnLabel)};
        var msg = err && (err.msg || err.message) ? (err.msg || err.message) : String(err || 'unknown');
        showErr((lang === 'en' ? 'Verification init failed: ' : '验证初始化失败: ') + msg);
      }
    });
  }
  if(document.readyState==='complete'){ mount(); } else { window.addEventListener('load', mount); }
})();
</script></body></html>"""
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
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        claimMode = intent?.getBooleanExtra("claim", false) == true
        val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        val address = TextView(this).apply {
            setPadding(24, 16, 24, 16)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
        }
        webView = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
            if (claimMode) addJavascriptInterface(ClaimShim(), "zcodeBridge")
            webViewClient = object : WebViewClient() {
                override fun onPageStarted(view: WebView, url: String, favicon: android.graphics.Bitmap?) {
                    injectClaimScript(url)
                }

                override fun onPageFinished(view: WebView, url: String) {
                    address.text = url
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
        if (claimMode) {
            // 领取页写进 localStorage 的登录凭据不能留在磁盘上。
            claimScript = null
            android.webkit.WebStorage.getInstance().deleteAllData()
        }
        super.onDestroy()
    }
}

/**
 * 居中轻量安全验证小浮窗会话：挂载在当前 Activity 之上（无全屏跳转、无地址栏），
 * 仅暴露 [CaptchaShim]（无文件/命令/凭据接口），关闭即销毁独立 WebView。
 */
private class CaptchaDialogSession(
    private val activity: Activity,
    private val challengeId: String,
    private val html: String,
    private val dark: Boolean,
    private val lang: String,
    private val onFinished: (CaptchaDialogSession) -> Unit,
) {
    private var dialog: Dialog? = null
    private var webView: WebView? = null
    private var cardLayout: LinearLayout? = null
    private var interactiveShown = false
    private var closed = false

    private val lifecycleCallbacks = object : Application.ActivityLifecycleCallbacks {
        override fun onActivityCreated(a: Activity, savedInstanceState: Bundle?) {}
        override fun onActivityStarted(a: Activity) {}
        override fun onActivityResumed(a: Activity) {}
        override fun onActivityPaused(a: Activity) {}
        override fun onActivityStopped(a: Activity) {}
        override fun onActivitySaveInstanceState(a: Activity, outState: Bundle) {}
        override fun onActivityDestroyed(a: Activity) {
            if (a === activity) close()
        }
    }

    /** 阿里云安全验证回传桥：无感通过直接回调关闭，需交互拼图时回调显现小浮窗。 */
    private inner class CaptchaShim {
        @JavascriptInterface
        fun onVerified(param: String?, region: String?) {
            val trimmed = param?.trim().orEmpty()
            if (trimmed.isNotEmpty()) {
                BrowserActivity.captchaResults[challengeId] = JSONObject().apply {
                    put("done", true)
                    put("ok", true)
                    put("captchaVerifyParam", trimmed)
                    put("region", region?.trim().orEmpty().ifEmpty { "cn" })
                }
            }
            activity.runOnUiThread { close() }
        }

        @JavascriptInterface
        fun onInteractive() {
            activity.runOnUiThread { revealInteractive() }
        }
    }

    private fun dp(value: Int): Int =
        (value * activity.resources.displayMetrics.density).toInt()

    @SuppressLint("SetJavaScriptEnabled")
    fun start() {
        activity.application.registerActivityLifecycleCallbacks(lifecycleCallbacks)
        val metrics = activity.resources.displayMetrics
        val cardWidth = minOf(metrics.widthPixels - dp(32), dp(360)).coerceAtLeast(dp(280))

        val cardBg = GradientDrawable().apply {
            shape = GradientDrawable.RECTANGLE
            cornerRadius = dp(18).toFloat()
            setColor(Color.parseColor(if (dark) "#1B1F27" else "#FFFFFF"))
            setStroke(dp(1).coerceAtLeast(1), Color.parseColor(if (dark) "#2E3440" else "#E2E8F0"))
        }

        val header = LinearLayout(activity).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(16), dp(12), dp(10), dp(4))
        }
        val titleView = TextView(activity).apply {
            text = if (lang == "en") "Security Verification" else "安全验证"
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
            typeface = Typeface.DEFAULT_BOLD
            setTextColor(Color.parseColor(if (dark) "#F3F4F6" else "#0F172A"))
        }
        val closeBtn = TextView(activity).apply {
            text = "✕"
            gravity = Gravity.CENTER
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
            setTextColor(Color.parseColor(if (dark) "#9CA3AF" else "#64748B"))
            isClickable = true
            setOnClickListener { close() }
        }
        header.addView(titleView, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
        header.addView(closeBtn, LinearLayout.LayoutParams(dp(32), dp(32)))

        val captchaWebView = WebView(activity).apply {
            setBackgroundColor(Color.TRANSPARENT)
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.allowFileAccess = false
            settings.allowContentAccess = false
            settings.mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
            addJavascriptInterface(CaptchaShim(), "ZCodeCaptchaBridge")
            webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean = true
            }
        }
        webView = captchaWebView

        val card = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            background = cardBg
            elevation = dp(12).toFloat()
            clipToOutline = true
            alpha = 0f
            addView(header, LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT,
            ))
            addView(captchaWebView, LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                dp(360),
            ))
        }
        cardLayout = card

        val wrapper = FrameLayout(activity).apply {
            addView(card, FrameLayout.LayoutParams(
                cardWidth,
                FrameLayout.LayoutParams.WRAP_CONTENT,
                Gravity.CENTER,
            ))
        }

        val dlg = Dialog(activity).apply {
            requestWindowFeature(Window.FEATURE_NO_TITLE)
            setContentView(wrapper)
            setCancelable(false)
            setCanceledOnTouchOutside(false)
            window?.apply {
                setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT))
                setLayout(WindowManager.LayoutParams.WRAP_CONTENT, WindowManager.LayoutParams.WRAP_CONTENT)
                setGravity(Gravity.CENTER)
                clearFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND)
                addFlags(
                    WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE or
                        WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE,
                )
            }
            setOnDismissListener { cleanup() }
        }
        dialog = dlg
        dlg.show()
        captchaWebView.loadDataWithBaseURL("https://zcode.z.ai/", html, "text/html", "utf-8", null)
    }

    private fun revealInteractive() {
        if (closed || interactiveShown) return
        val dlg = dialog ?: return
        if (!dlg.isShowing) return
        interactiveShown = true
        dlg.setCancelable(true)
        dlg.setCanceledOnTouchOutside(true)
        dlg.window?.apply {
            clearFlags(
                WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE or
                    WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE,
            )
            addFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND)
            setDimAmount(0.48f)
        }
        cardLayout?.animate()?.alpha(1f)?.setDuration(150L)?.start()
    }

    fun close() {
        if (closed) return
        val dlg = dialog
        if (dlg != null && dlg.isShowing && !activity.isFinishing && !activity.isDestroyed) {
            runCatching { dlg.dismiss() }
        }
        cleanup()
    }

    private fun cleanup() {
        if (closed) return
        closed = true
        runCatching { activity.application.unregisterActivityLifecycleCallbacks(lifecycleCallbacks) }
        val cur = BrowserActivity.captchaResults[challengeId]
        if (cur == null || !cur.optBoolean("done", false)) {
            BrowserActivity.captchaResults[challengeId] = JSONObject().apply {
                put("done", true)
                put("ok", false)
                put("cancelled", true)
            }
        }
        webView?.let { wv ->
            runCatching {
                wv.stopLoading()
                wv.removeJavascriptInterface("ZCodeCaptchaBridge")
                (wv.parent as? ViewGroup)?.removeView(wv)
                wv.destroy()
            }
        }
        webView = null
        cardLayout = null
        dialog = null
        onFinished(this)
    }
}
