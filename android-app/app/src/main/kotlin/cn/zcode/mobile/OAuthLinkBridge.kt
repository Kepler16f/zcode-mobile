package cn.zcode.mobile

import android.net.Uri
import android.webkit.JavascriptInterface
import org.json.JSONObject

/**
 * 把 `zcode://oauth/callback?...` 这条深链交给 JS —— 上游 `oauthService.handleCallback(url)` 在
 * 移动端的那一半（桌面侧对应 `desktopOAuthDeepLink.ts` 的 pendingDeepLinkUrl + onRendererReady 投递）。
 *
 * 为什么必须由 App 消费这条 URL：轮询 (`/oauth/cli/poll`) 要等**网站那页把 flow 标成 ready**，而手机
 * 浏览器在把自定义 scheme 交给 App 的那一刻就把那个标签页冻结甚至回收了，页面自己的收尾没跑完 ——
 * 结果是轮询永远 pending，界面上一直转圈。桌面 Chrome 交接后标签页还活着，所以同一条代码在桌面上是好的。
 *
 * 外壳只做"存一条、给一次"，**不解析 code、不校验 state、不碰 token**：state 比对和 token 交换全在服务层
 * （`oauthService.ts:896` 用 `pending.state` 卡），所以别的 App 伪造一条 callback 也换不到登录态。
 * 深链里带着 code，所以这里既不打日志也不把它写进任何持久文件。
 */
class OAuthLinkBridge {

    @Volatile
    private var pending: String? = null
    private var offered = 0
    private var taken = 0

    /**
     * 上一次交进来的 URL。onResume 会拿着**同一个**冷启动 intent 再走一遍 deliver，
     * 不去重的话 JS 已兑过的旧 code 会被投第二次——state 已经在上一次消费时清掉，
     * 第二回必然"OAuth state 不匹配或已过期"（装机取证 2026-10-04：登录成功后 13:50/13:51/13:53
     * 三条 handleCallback-error 全是同一条 URL 的重放）。一次真实的登录用的是全新的 code+state，
     * URL 必然不同，所以"同 URL 再投"只可能是重放，直接吞掉。
     */
    @Volatile
    private var lastOfferedUrl: String? = null

    /**
     * Activity 收到 VIEW intent 时调用。只认 `zcode://oauth/callback`（含尾斜杠），
     * 其他 host/path 直接忽略 —— 上游还有 payment/workspace/share 三类深链，端侧一个都没接，
     * 交给 JS 只会多出一条没有对应处理器的路径。
     */
    fun offer(uri: Uri?): Boolean {
        if (uri == null || uri.scheme != "zcode") return false
        val host = uri.host ?: return false
        val path = (uri.path ?: "").trimEnd('/')
        if (host != "oauth" || (path != "/callback" && path != "")) return false
        val url = uri.toString()
        if (url == lastOfferedUrl) return false
        lastOfferedUrl = url
        pending = url
        offered += 1
        return true
    }

    /** 外壳自己判断"要不要叫醒 JS"用；不暴露 URL 本体。 */
    fun hasPending(): Boolean = pending != null

    /** JS 侧主动取走：取完即清空，所以重复投递最多消费一次，不会出现两条 callback 抢同一个 flow。 */
    @JavascriptInterface
    fun take(): String {
        synchronized(this) {
            val url = pending
            if (url == null) return JSONObject().put("ok", true).put("url", JSONObject.NULL).toString()
            pending = null
            taken += 1
            return JSONObject().put("ok", true).put("url", url).toString()
        }
    }

    /**
     * 取证用：`offered` 与 `taken` 的差就是"链接到了 App 但 JS 没来接"——冷启动时被浏览器
     * 拉起来、或者页面被回收后重建，正是这一种。数值里不含 URL 本身。
     */
    @JavascriptInterface
    fun stats(): String =
        JSONObject().put("ok", true).put("offered", offered).put("taken", taken).toString()
}
