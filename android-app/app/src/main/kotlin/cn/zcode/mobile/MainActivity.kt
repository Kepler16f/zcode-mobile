package cn.zcode.mobile

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.graphics.Color
import android.os.Bundle
import android.util.TypedValue
import android.view.Gravity
import android.view.WindowManager
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.TextView
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebSettingsCompat

class MainActivity : Activity() {

    private lateinit var webView: WebView
    private lateinit var pageSwitch: TextView
    private val oauthLink = OAuthLinkBridge()
    private val fileChooser by lazy { FileChooser(this) }
    // 外部工作区（SAF 树）：TreeBridge 管读写，WorkspaceBridge 管系统选择器。
    // 顺序上 tree 先建 —— WorkspaceBridge.handleResult 选完目录当场要 registerTree。
    private val treeBridge by lazy { TreeBridge(applicationContext) }
    private val workspaceBridge by lazy { WorkspaceBridge(this, treeBridge) { if (::webView.isInitialized) webView else null } }
    // 系统栏主题 + 沉浸 insets（0.3.7）：webViewProvider 用 lambda，注册发生在 webView 建好之后。
    private val uiChrome by lazy { UIChromeBridge(this) { if (::webView.isInitialized) webView else null } }

    // ES module 在 file:// 下会被 CORS 拒绝，因此用 https://appassets 虚拟域加载 assets。
    // lazy：onCreate 与 onRenderProcessGone 的重建路径共用同一份 handler。
    private val assetLoader by lazy {
        WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // 冷启动先照上次存的主题把窗口/状态栏上色（消掉浅色主题用户开 App 闪一屏深色底）。
        UIChromeBridge.applyInitialChrome(this)
        // 状态栏沉浸（0.3.7，用户点名）：API 30+ 才开，见 installImmersiveChrome。
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.R) {
            installImmersiveChrome()
        }

        webView = buildWebView()

        // 自检页必须一直够得着：装机复测的回收路径就是"打开自检 → 复制报告"，
        // 而它不该占用真界面的视觉，所以做成贴角的小牌，默认只有一行小字。
        pageSwitch = TextView(this).apply {
            text = TEXT_SELFCHECK
            setTextColor(Color.parseColor("#9A9A9A"))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 11f)
            setBackgroundColor(0x66000000)
            setPadding(dp(8), dp(3), dp(8), dp(3))
            gravity = Gravity.CENTER
            isClickable = true
            setOnClickListener {
                val target = if (webView.url?.startsWith(UI_PAGE) == true) SELFCHECK_PAGE else UI_PAGE
                webView.loadUrl(target)
            }
        }

        val root = FrameLayout(this).apply {
            addView(webView, matchParent())
            addView(pageSwitch, FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.WRAP_CONTENT,
                FrameLayout.LayoutParams.WRAP_CONTENT,
            ).apply {
                gravity = Gravity.BOTTOM or Gravity.START
                marginStart = dp(8)
                bottomMargin = dp(8)
            })
        }
        setContentView(root)
        // 沉浸 insets（0.3.8 起按用户要求走安卓原生接口）：监听挂在内容根上，
        // **原生直接给 WebView 容器 setPadding** —— 留边不再经过 JS，也就不存在
        // "垫片没跑/跑晚了/被缓存顶掉"这类失效面（0.3.7 装机"状态栏还是遮挡"的两条成因之一）。
        // IME 高度折进 bottom：键盘沿就是 composer 该停的位置，通道只有这一条。
        // 自检小牌是原生 View，垫边单独算。
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.R) {
            installImmersiveInsetsDispatch(root)
        }
        // 边缘滑动的系统手势让位（0.4.7）：见方法注释。挂点选这里而不是 insets 监听里：
        // 排除区与键盘/insets 无关，只跟 WebView 的宽高有关。
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.Q) {
            installGestureExclusionBand()
        }
        // 冷启动也可能是深链拉起来的（用户在浏览器里点"返回应用"时 App 还没活着）。
        // 这条 URL 此刻没人能接，先存着，等 JS 注册 onOAuthCallback 之后自己来 take()。
        deliverOAuthLink(intent)
        // 首次安装索要文件权限（0.7.4，用户点名"首次安装时请向用户索要文件权限"）。
        maybeAskAllFilesPermission()
    }

    /**
     * 首启文件权限引导（0.7.4）：Android 11+ 的"所有文件访问"是助手能直接读写手机本地文件
     * （下载/文档等）的前提。对话框走原生（WebView 还没渲染完时 JS 侧不可依赖），文案讲清
     * "要这个权限干什么"；去授权复用 DeviceProbe 的系统页跳转。无论选哪边都记"已问过"——
     * 反复冷启动追着用户要权限是骚扰；用户改主意走 设置→全部文件管理权限。
     */
    private fun maybeAskAllFilesPermission() {
        if (android.os.Build.VERSION.SDK_INT < android.os.Build.VERSION_CODES.R) return
        if (android.os.Environment.isExternalStorageManager()) return
        val prefs = getSharedPreferences("zcode-mobile", android.content.Context.MODE_PRIVATE)
        if (prefs.getBoolean("all-files-asked", false)) return
        prefs.edit().putBoolean("all-files-asked", true).apply()
        android.app.AlertDialog.Builder(this)
            .setTitle("允许管理文件？")
            .setMessage(
                "aZCode 的助手要读写你手机上的本地文件（下载、文档等）需要「所有文件访问」权限。" +
                    "没有它，助手只能待在自己的工作区里。现在去系统设置开启，或以后在 设置 → 全部文件管理权限 里再开。",
            )
            .setPositiveButton("去开启") { _, _ ->
                DeviceProbe(applicationContext).openAllFilesPermission()
            }
            .setNegativeButton("暂不") { d, _ -> d.dismiss() }
            .setCancelable(false)
            .show()
    }

    /**
     * 构建主 WebView：settings、client、桥清单、首屏 URL 全在这——onCreate 与
     * 渲染进程死亡（onRenderProcessGone）的重建路径共用这一份，两处永不漂移。
     */
    @SuppressLint("SetJavaScriptEnabled")
    private fun buildWebView(): WebView =
        WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.databaseEnabled = true
            settings.cacheMode = WebSettings.LOAD_NO_CACHE
            // 装机复现（0.3.8）：assets 文件名不带 hash（entry.js / zcode-core.mobile.js 是固定 URL），
            // LOAD_DEFAULT 的启发式缓存会**跨 APK 安装**复用旧 JS —— 装 0.3.7 后页面里跑的还是
            // 0.3.6 那份（顶栏被透明化后旧 JS 不懂垫边 ⇒ "状态栏还是遮挡"；旧 JS 的命名参数还没修
            // ⇒ "侧栏还是空"，两条症状一次解释）。端侧没有网络资源可缓存，整条 HTTP 缓存都是
            // 过期风险，直接关死：每次读的都是 APK 里这份，装机即最新。
            settings.mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
            // R11：本地页面不需要、也不该顺手摸应用私有目录里的其它文件，所以 file:// 访问与
            // 新窗口一律关掉。
            settings.allowFileAccess = false
            settings.javaScriptCanOpenWindowsAutomatically = false
            settings.setSupportMultipleWindows(false)
            // 深色模式（§1.5.19）：主题由页面 CSS + .dark class 自己管，禁止 WebView 再叠一层
            // 算法反色 —— 两层同时作用时深浅色切一半、图片颜色漂移（OPPO ColorOS 会把强制深色
            // 推给用户，浅色 App 也照样被"优化"）。关掉后深浅色只认页面自己。
            WebSettingsCompat.setAlgorithmicDarkeningAllowed(settings, false)
            // 附件选择（§1.5.17）要求 allowContentAccess 是 **true**：系统选择器交回来的是
            // `content://` URI，Chromium 用 ContentResolver 读它来构造 File 对象。应用私有目录
            // （凭据密文、会话库）只能经 file:// 到达，那条被 allowFileAccess=false 关着。
            settings.allowContentAccess = true

            webViewClient = object : WebViewClient() {
                override fun shouldInterceptRequest(
                    view: WebView,
                    request: WebResourceRequest,
                ): WebResourceResponse? = assetLoader.shouldInterceptRequest(request.url)

                override fun onPageFinished(view: WebView, url: String) {
                    syncSwitchLabel(url)
                }

                // 渲染进程死亡自救（0.6.0，装机"授权弹窗切出去回来会话停了 + 整个应用卡死"）：
                // Android 会回收后台 Activity 的渲染进程（内存压力下连前台缓存态也会杀）。渲染进程
                // 一死，WebView 就是白屏/冻结，默认行为（不覆写本方法）是系统把整个 Activity 干掉——
                // 用户看到的"回来 app 死了/卡死"就是这条。这里原地重建 WebView（同一套桥、同一 URL），
                // 会话层本来就持久化在 sqlite，页面重载后 restore 会把没跑完的轮次如实标成 interrupted。
                override fun onRenderProcessGone(view: WebView, detail: android.webkit.RenderProcessGoneDetail): Boolean {
                    if (view !== webView) return false
                    rebuildWebView()
                    return true // 已自救：不告诉系统去杀 Activity
                }
            }
            // 不装这个，`<input type="file">` 在 WebView 里是死的：Chromium 把选择请求直接丢掉。
            webChromeClient = fileChooser

            // 沉浸后状态栏/键盘那条带露出来的是 WebView 自己的 padding 底，所以这块必须跟主题：
            // 0.3.7 写死 #161616，浅色主题就会在状态栏底下压一条深带。读上次存的主题布尔
            // （applyInitialChrome 同一条路，冷启动时 webView 还没建好、applyChrome 那次没刷到它）。
            setBackgroundColor(
                if (getSharedPreferences("zcode-ui-chrome", MODE_PRIVATE)
                        .getBoolean(UIChromeBridge.KEY_DARK, true)
                ) UIChromeBridge.DARK else UIChromeBridge.LIGHT,
            )
            // 名字注入是**同步**通道：SqliteBridge 正是靠这一点满足 node:sqlite DatabaseSync
            // 的同步契约，从而复用桌面 store 而不必把整库读进 WASM 堆（§7 R16）。
            addJavascriptInterface(SqliteBridge(applicationContext), "zcodeSqlite")
            addJavascriptInterface(DeviceProbe(applicationContext), "zcodeDevice")
            // L1 执行能力：真机自检已证明这个 WebView 能派生 /system/bin/sh，这里把它接上
            // ExecutionPort。argv 形态不经过 shell，参数拼不出第二条命令。
            addJavascriptInterface(ExecBridge(applicationContext), "zcodeExec")
            // 真盘文件桥：真机实测这个 WebView 没有 OPFS（navigator.storage.getDirectory() 抛
            // TypeError），vfs 只能落到应用私有目录，否则 Write/Edit 的结果重启就没了。
            addJavascriptInterface(FsBridge(applicationContext), "zcodeFs")
            // 外部工作区（0.3.7）：系统选择器 + SAF 授权树的读写口，两条桥配套注册。
            // 名字必须和 JS 侧（compat/vfs-tree.mjs、platform.ts）读的那两个全局一致。
            addJavascriptInterface(treeBridge, "zcodeTree")
            addJavascriptInterface(workspaceBridge, "zcodeWorkspace")
            // 凭据层（M6）：登录换来的 token 用 AndroidKeyStore 里不可导出的 AES-256-GCM 密钥加密，
            // 落 noBackupFilesDir。桌面垫片故意不给 createCipheriv，这条路只能走这里。
            addJavascriptInterface(CredentialBridge(applicationContext), "zcodeCredentials")
            // 登录深链（§1.5.15 的移动端那一半）：只递"有一条 URL 可以取了"这个信号，URL 由 JS 自己
            // take() 走 —— 不把 code 拼进 evaluateJavascript 的源码里，免得它在崩溃日志里露头。
            addJavascriptInterface(oauthLink, "zcodeOAuthLink")
            // 系统栏主题（§1.5.19）：页面应用主题后调 setThemeDark 把布尔传进来，状态栏/导航/窗口底色
            // 跟着深浅色，不再被 themes.xml 写死成深色。
            addJavascriptInterface(uiChrome, "zcodeUi")
            // 内置浏览器（0.6.0）：Browser 工具的 open/navigate/back/read/close 走这条桥。
            addJavascriptInterface(BrowserBridge(applicationContext), "zcodeBrowser")
            // Git 传输 HTTP 桥（0.6.7）：isomorphic-git 的 fetch 传输在 WebView 里被 CORS
            // 全拦（git 端点普遍不答 CORS，GitHub 也是），改走原生 HttpURLConnection。
            addJavascriptInterface(GitHttpBridge(), "zcodeGitHttp")
            loadUrl(UI_PAGE)
        }

    /** 渲染进程死亡后的原地重建：摘掉死 WebView、按同一份配置造新的、回到原 URL。 */
    private fun rebuildWebView() {
        if (!::webView.isInitialized) return
        val stale = webView
        val parent = stale.parent as? android.view.ViewGroup ?: return
        val url = stale.url ?: UI_PAGE
        parent.removeView(stale)
        stale.destroy()
        webView = buildWebView()
        // index 0：WebView 在自检小牌（后 add 的）下面，与 onCreate 的装配次序一致。
        parent.addView(webView, 0, matchParent())
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.Q) {
            installGestureExclusionBand()
        }
        webView.loadUrl(url)
    }

    /**
     * 状态栏沉浸的窗口那一半（API 30+，调用方已判 SDK）：edge-to-edge 让内容画到状态栏底下，
     * 留边由 installImmersiveInsetsDispatch 直接给 WebView setPadding（0.3.8：安卓原生接口，
     * 见用户点名"按照安卓原生接口修复"）。低版本维持 0.3.6：不透明主题色条、内容不伸入 ——
     * 那台 WebView 的 insets 派发各家行为不一，没装机验证过的沉浸不发版。
     */
    @SuppressLint("NewApi")
    private fun installImmersiveChrome() {
        window.setDecorFitsSystemWindows(false)
        // 全面屏手势适配（0.4.7，装机反馈"全面屏手势也没适配"）：系统条一律透明。
        // 此前主题里 statusBarColor/navigationBarColor 是实色 #161616 —— 在"三键导航"
        // 时代它是底下一条不显眼的深带，在手势导航时代它就是悬在屏幕底部的黑条（浅色主题
        // 尤其扎眼）。透明之后这两条带露出的是 WebView 自己的背景色，而那块由
        // UIChromeBridge.applyChrome 随主题上色 —— 深浅色都跟得上，不再写死。
        // 只在 ≥30 的沉浸分支改：低版本没开 setDecorFitsSystemWindows(false)，
        // 透明条等于把内容直接画进系统栏底下，那是 0.3.6 明确不发版的形态。
        window.statusBarColor = Color.TRANSPARENT
        window.navigationBarColor = Color.TRANSPARENT
        // ADJUST_NOTHING：窗口不再被键盘顶小/上移，键盘几何完全由 insets 派发（IME 折进 bottom），
        // 页面是唯一决定"composer 怎么让"的地方 —— 两条通道并存会把输入框顶两次。
        // 这条与 manifest 的 adjustResize 的关系：代码里后设的生效，写在这而不是 manifest，
        // 是为了"只有开了沉浸的分支才换通道"——低版本分支保持 manifest 原样。
        window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_NOTHING)
    }

    /**
     * 左缘手势排除区（API 29+；0.4.7 装机"侧滑呼出/收起侧边栏没有实现"的根因通道）：
     * 全面屏手势的系统"返回"占用屏幕**最外缘**的竖条（各家 ROM 约 20–50px），触摸序列被
     * 系统先截 —— 端侧 JS 的左缘带（0–28 CSS px）在同一条带上，装机表现为"划了没反应"。
     * setSystemGestureExclusionRects（View，API 29）正是系统为"App 自己有水平手势"留的显式通道：被排除的区域
     * 优先交还应用（各 ROM 兑现程度不一，Android 12+ 用户仍可从最边缘强制触发，属预期行为）；
     * 三键导航设备完全不受影响。24dp 覆盖 JS 侧 28 CSS px 的起点带（dpr≥1 时 24dp ≥ 24 CSS px，
     * 与带基本同宽；宁可贴着带画，不额外吞系统手势区）。
     *
     * 0.4.9 只排除**左缘**（呼出抽屉的方向）：右缘还给系统——用户从右缘滑触发返回手势时，
     * onBackPressed 拦截（抽屉开=收起，见上），这正是用户要的"从边缘滑动触发返回键也是收起"。
     * 两侧都排除的话，抽屉关着时用户从右缘划回去连"返回"都没有了。
     */
    @SuppressLint("NewApi")
    private fun installGestureExclusionBand() {
        val update = {
            val w = webView.width
            val h = webView.height
            if (w > 0 && h > 0) {
                val band = (resources.displayMetrics.density * 24).toInt().coerceAtMost(w / 3)
                webView.setSystemGestureExclusionRects(
                    mutableListOf(
                        android.graphics.Rect(0, 0, band, h),
                    ),
                )
            }
        }
        webView.addOnLayoutChangeListener { v, _, _, _, _, _, _, _, _ ->
            // 旋转/分屏会改 WebView 尺寸；exclusion rects 是视图坐标，必须跟着重画。
            if (v === webView) update()
        }
        update()
    }

    /** insets 派发（API 30+）：见 onCreate 调用点的注释。0.3.8：留边直接给 WebView setPadding。 */
    @SuppressLint("NewApi")
    private fun installImmersiveInsetsDispatch(root: FrameLayout) {
        val badgeLp = pageSwitch.layoutParams as FrameLayout.LayoutParams
        root.setOnApplyWindowInsetsListener { _, insets ->
            val bars = insets.getInsets(
                android.view.WindowInsets.Type.systemBars() or
                    android.view.WindowInsets.Type.displayCutout(),
            )
            val ime = insets.getInsets(android.view.WindowInsets.Type.ime()).bottom
            val bottom = maxOf(bars.bottom, ime)
            // 安卓原生的 edge-to-edge 留边：内容（页面）从 padding 里开始画，状态栏/刘海/导航条
            // 底下的那条带显示的是 WebView 自己的背景色（applyChrome 把它刷成当前主题色）。
            // 这条路不经过 JS —— 0.3.7 装机"状态栏还是遮挡"里 JS 垫边被旧缓存/时序顶掉的失效面整个消掉。
            // clipToPadding=false：键盘收起动画那一帧不被新 padding 裁出跳变。
            if (::webView.isInitialized) {
                webView.setPadding(bars.left, bars.top, bars.right, bottom)
            }
            // JS 侧读数保留（CSS 变量 + 自检 M9）：垫边不再归它管，只报"通道活着"。
            uiChrome.pushInsets(bars.top, bars.right, bottom, bars.left)
            badgeLp.bottomMargin = dp(8) + bottom
            badgeLp.marginStart = dp(8) + bars.left
            pageSwitch.layoutParams = badgeLp
            insets
        }
        root.requestApplyInsets()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        // 不 setIntent 的话，getIntent() 还停在第一条冷启动 intent 上。
        setIntent(intent)
        deliverOAuthLink(intent)
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        // 附件选择的结果从这里回给 WebView。没接住的那一半表现是"选完文件回到 App，输入框是空的"。
        if (fileChooser.handleResult(requestCode, resultCode, data)) return
        // 工作区目录选择同理：接不住的那一半是"选完文件夹回来，UI 里没有任何反应"。
        if (workspaceBridge.handleResult(requestCode, resultCode, data)) return
    }

    override fun onResume() {
        super.onResume()
        // 从浏览器回来的第一现场：页面可能在后台被冻结过，错过了推送到 __zcodeOAuthLink 的那一下。
        deliverOAuthLink(intent)
    }

    /** 通知 JS "有一条 callback 可以取了"。URL 本体留在桥里由 JS take()，不进 JS 源码、不进日志。 */
    private fun deliverOAuthLink(intent: Intent?) {
        val arrived = oauthLink.offer(intent?.data)
        if (!arrived && !oauthLink.hasPending()) return
        webView.evaluateJavascript("window.__zcodeOAuthLink&&window.__zcodeOAuthLink()", null)
    }

    private fun syncSwitchLabel(url: String?) {
        pageSwitch.text = if (url != null && !url.startsWith(UI_PAGE)) TEXT_BACK else TEXT_SELFCHECK
    }

    private fun dp(value: Int): Int =
        (value * resources.displayMetrics.density).toInt()

    private fun matchParent() = FrameLayout.LayoutParams(
        FrameLayout.LayoutParams.MATCH_PARENT,
        FrameLayout.LayoutParams.MATCH_PARENT,
    )

    override fun onBackPressed() {
        // 0.4.9 三级返回（用户点名"从边缘滑动触发返回键也是收起"）：
        // ①竖屏抽屉展开 → 收起抽屉（移动端抽屉标准语义，也是"卡住没法回去"的第三条退路）；
        // ②WebView 有页面历史 → goBack（SPA 内部导航）；
        // ③默认（退出应用）。
        if (uiChrome.drawerOpen && ::webView.isInitialized) {
            webView.evaluateJavascript(
                "document.querySelector('[data-testid=\"web-sidebar-toggle\"]')?.click()",
                null,
            )
            return
        }
        // WebView.goBack() 返回 Unit，条件要用 canGoBack()。
        if (webView.canGoBack()) webView.goBack() else @Suppress("DEPRECATION") super.onBackPressed()
    }

    private companion object {
        const val ASSET_ROOT = "https://appassets.androidplatform.net/assets"
        const val UI_PAGE = "$ASSET_ROOT/ui/ui.html"
        const val SELFCHECK_PAGE = "$ASSET_ROOT/mobile/selfcheck.html"
        const val TEXT_SELFCHECK = "自检"
        const val TEXT_BACK = "返回界面"
    }
}
