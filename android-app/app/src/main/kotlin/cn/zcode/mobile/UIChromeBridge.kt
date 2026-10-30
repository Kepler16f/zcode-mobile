package cn.zcode.mobile

import android.app.Activity
import android.content.Context
import android.graphics.Color
import android.os.Build
import android.view.View
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.view.ContextThemeWrapper
import org.json.JSONObject

/**
 * 原生系统栏（状态栏 / 导航栏 / 窗口底色）跟随 App 内主题，外加 0.3.7 的状态栏沉浸。
 *
 * 为什么要有这一条：主题的唯一真相在页面里（localStorage 的 zcode-theme + 系统偏好，由
 * ui.html 首帧脚本和 entry.tsx 的 applyTheme 决出），而原生读不到 WebView 的 localStorage。
 * themes.xml 把 #161616 写死的话，用户切到浅色主题时状态栏仍是深色、启动瞬间还会露一屏黑底。
 * 所以反过来让**页面在应用主题后调这一格**，把 dark 布尔传进来，原生只照着上色。
 *
 * @JavascriptInterface 在 JavaBridge 线程回调，改 View 必须回主线程（runOnUiThread）。
 * 上一次的主题布尔存进 SharedPreferences：冷启动时 applyInitialChrome 先照它上色，
 * 消掉"浅色主题用户开 App 闪一屏深色底"那段原生窗口空窗——JS 跑起来之前就能对上。
 *
 * 沉浸（API 30+）：状态栏透明、内容画到其下，页面用 pushInsets 传来的像素做自身留边；
 * 键盘避让与留边同一条通道 —— MainActivity 把 softInputMode 设成 ADJUST_NOTHING，
 * IME 高度折进 bottom（max(导航条, 键盘)），CSS 变量是唯一来源。两条通道并存会把输入框
 * 顶两次；而 setDecorFitsSystemWindows(false) 下 ADJUST_RESIZE 的行为在厂商 ROM 上并不可靠，
 * 这正是"沉浸后键盘顶飞输入框"类回归的来源。API <30 维持 0.3.6 形状：不透明主题色条、
 * 内容不伸入、adjustResize 照常。
 */
class UIChromeBridge(
    private val activity: Activity,
    private val webViewProvider: () -> WebView? = { null },
) {

    @JavascriptInterface
    fun name(): String = "zcodeUi"

    /** dark=true 走深色系统栏（浅色图标压在深色底上），false 走浅色栏 + 深色图标。 */
    @JavascriptInterface
    fun setThemeDark(dark: Boolean) {
        prefs().edit().putBoolean(KEY_DARK, dark).apply()
        activity.runOnUiThread { applyChrome(dark) }
    }

    /**
     * 系统当前的夜间模式（Configuration 的真值）。
     *
     * 为什么页面要问原生而不是自己 matchMedia("(prefers-color-scheme: dark)")：
     * 外壳设了 setAlgorithmicDarkeningAllowed(false)（防 ColorOS 对 CSS 二次反色），
     * 这条同时也把 WebView 的 prefers-color-scheme 钉死在"应用的明暗"上——用户选
     * "跟随系统"时它读到的是 light，永远判成浅色（0.3.5 装机反馈"跟随系统无效"
     * 夜间模式切换会走 Activity 重建，重建后首帧脚本重新读这里，链路是通的。
     */
    @JavascriptInterface
    fun systemDark(): Boolean {
        val nightMode = activity.resources.configuration.uiMode and android.content.res.Configuration.UI_MODE_NIGHT_MASK
        return nightMode == android.content.res.Configuration.UI_MODE_NIGHT_YES
    }

    /**
     * 最近一次派发的窗口内边距（JSON：{top,right,bottom,left,ime}，设备像素）。
     * JS 冷启动先读这里落位（system-insets.ts），避免"等第一次推送才不跳版"；
     * 之后每次 insets 变化由 pushInsets 主动 evaluateJavascript 推给 __zcodeInsets。
     * 单位是设备像素：换算成 CSS px 用 window.devicePixelRatio，只有页面自己知道。
     */
    @JavascriptInterface
    fun safeInsets(): String = lastInsetsJson

    /**
     * 抽屉开合状态（0.4.9，用户点名"从边缘滑动触发返回键也是收起"）：
     * JS 侧 web-mobile-shell 的 sync() 是唯一知道抽屉真实状态的一方，每次开合变化推过来。
     * MainActivity.onBackPressed 读这个布尔决定"返回=收起抽屉"还是默认行为（退出）。
     * @Volatile：JS 桥线程写、主线程读，无锁可见性。
     */
    @Volatile
    var drawerOpen: Boolean = false
        private set

    @JavascriptInterface
    fun setDrawerOpen(open: Boolean) {
        drawerOpen = open
    }

    private fun prefs() = activity.getSharedPreferences("zcode-ui-chrome", Context.MODE_PRIVATE)

    private fun applyChrome(dark: Boolean) {
        val surface = if (dark) DARK else LIGHT
        // 30+ 的沉浸：状态栏透明（页面自己垫色），导航条保持主题色。低版本维持 0.3.6 的形状：
        // 不透明主题色条 + 内容不伸入 —— 那条路径上 insets 派发在旧 WebView 上各家行为不一，
        // 没装机验证过的沉浸不发版。
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            activity.window.statusBarColor = Color.TRANSPARENT
        } else {
            activity.window.statusBarColor = surface
        }
        activity.window.navigationBarColor = surface
        activity.window.decorView.setBackgroundColor(surface)
        // WebView 自身的底色也要跟着主题：0.3.8 起留边是 WebView 自己的 padding，
        // 状态栏/键盘那条带露出来的就是这块色 —— 不跟的话浅色主题下状态栏底下是一条 #161616 深带。
        webViewProvider()?.setBackgroundColor(surface)
        val flags = activity.window.decorView.systemUiVisibility
        activity.window.decorView.systemUiVisibility = if (dark) {
            flags and LIGHT_STATUS_BAR.inv()
        } else {
            flags or LIGHT_STATUS_BAR
        }
    }

    /**
     * MainActivity 的 insets 监听器调这里：缓存 + 推给 JS。
     * 四个值都已是设备像素、且 bottom 已折进键盘（max(导航条, IME)）—— 页面拿到的就是"要垫多高"，
     * 不需要再判键盘，也就不存在两条通道叠加。
     */
    fun pushInsets(top: Int, right: Int, bottom: Int, left: Int) {
        val json = JSONObject()
            .put("top", top).put("right", right).put("bottom", bottom).put("left", left)
            .toString()
        if (json == lastInsetsJson) return
        lastInsetsJson = json
        val web = webViewProvider()
        if (web == null) {
            // WebView 还没就绪（冷启动监听在内容挂载前后各派发一次）：JS 起来后自己读 safeInsets()。
            return
        }
        web.evaluateJavascript("window.__zcodeInsets&&window.__zcodeInsets($json)", null)
    }

    @Volatile
    private var lastInsetsJson = "{\"top\":0,\"right\":0,\"bottom\":0,\"left\":0}"

    companion object {
        const val KEY_DARK = "theme-dark"
        val DARK = 0xFF161616.toInt()
        val LIGHT = 0xFFFFFFFF.toInt()
        val LIGHT_STATUS_BAR = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M)
            View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR else 0

        /** 冷启动在 onCreate 里调一次：读上次存的布尔，抢在 JS 之前把窗口/状态栏对上主题。 */
        fun applyInitialChrome(activity: Activity) {
            val dark = activity.getSharedPreferences("zcode-ui-chrome", Context.MODE_PRIVATE)
                .getBoolean(KEY_DARK, true) // 无记录 = 出厂默认深色（与 ui.html 的 zai-dark 兜底一致）
            UIChromeBridge(activity).applyChrome(dark)
        }

        /**
         * 原生弹窗用的上下文：主题跟**应用内**的深浅色走，不跟系统走。
         *
         * 为什么不用 Activity 本身：Activity 的主题是 DeviceDefault，跟系统深浅色。
         * 用户在应用设置里选浅色、系统仍是深色时，文件选择弹窗就会是深色的（用户报的问题）。
         * 应用主题的布尔就存在 zcode-ui-chrome 里（页面每次 applyTheme 后调 setThemeDark 写进来），
         * 这里读同一份事实，不另造状态。
         */
        fun dialogContext(context: Context): Context {
            val dark = context.getSharedPreferences("zcode-ui-chrome", Context.MODE_PRIVATE)
                .getBoolean(KEY_DARK, true)
            val theme = if (dark) R.style.Theme_ZcodeMobile_Dialog_Dark else R.style.Theme_ZcodeMobile_Dialog_Light
            return ContextThemeWrapper(context, theme)
        }
    }
}
