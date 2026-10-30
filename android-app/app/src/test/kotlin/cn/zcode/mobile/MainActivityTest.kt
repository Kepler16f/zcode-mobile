package cn.zcode.mobile

import android.content.Context
import android.graphics.Color
import android.os.Looper
import android.view.ViewGroup
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebView
import android.widget.FrameLayout
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowEnvironment

/** 执行真正的 Activity.onCreate；JS 冒烟和 assemble 均无法发现 lateinit 初始化顺序错误。 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [26, 30, 34])
class MainActivityTest {
    @Before
    fun installExternalStorageVolume() {
        ShadowEnvironment.addExternalDir("primary")
    }

    private fun webView(activity: MainActivity): WebView =
        ((activity.findViewById<ViewGroup>(android.R.id.content).getChildAt(0) as FrameLayout)
            .getChildAt(0) as WebView)

    @Test
    fun coldStartLoadsUiAndHidesSelfcheck() {
        Robolectric.buildActivity(MainActivity::class.java).use { controller ->
            val activity = controller.setup().get()
            val web = webView(activity)
            assertEquals("https://appassets.androidplatform.net/assets/ui/ui.html", web.url)
            assertSame(NativeBridges.exec(activity), shadowOf(web).getJavascriptInterface("zcodeExec"))
            assertSame(NativeBridges.modelHttp(), shadowOf(web).getJavascriptInterface("zcodeModelHttp"))
            assertSame(NativeBridges.gitHttp(), shadowOf(web).getJavascriptInterface("zcodeGitHttp"))
            val root = web.parent as FrameLayout
            assertEquals(android.view.View.GONE, root.getChildAt(1).visibility)
        }
    }

    @Test
    fun rendererRecoveryReplacesViewAndKeepsProcessBridges() {
        Robolectric.buildActivity(MainActivity::class.java).use { controller ->
            val activity = controller.setup().get()
            val oldWeb = webView(activity)
            val exec = NativeBridges.exec(activity)
            val model = NativeBridges.modelHttp()
            val git = NativeBridges.gitHttp()
            val detail = object : RenderProcessGoneDetail() {
                override fun didCrash() = true
                override fun rendererPriorityAtExit() = WebView.RENDERER_PRIORITY_IMPORTANT
            }
            assertTrue(oldWeb.webViewClient.onRenderProcessGone(oldWeb, detail))
            val replacement = webView(activity)
            assertNotSame(oldWeb, replacement)
            assertNull(oldWeb.parent)
            assertEquals("https://appassets.androidplatform.net/assets/ui/ui.html", replacement.url)
            assertSame(exec, NativeBridges.exec(activity))
            assertSame(model, NativeBridges.modelHttp())
            assertSame(git, NativeBridges.gitHttp())
            assertSame(exec, shadowOf(replacement).getJavascriptInterface("zcodeExec"))
            assertSame(model, shadowOf(replacement).getJavascriptInterface("zcodeModelHttp"))
            assertSame(git, shadowOf(replacement).getJavascriptInterface("zcodeGitHttp"))
        }
    }

    @Test
    fun backgroundResumeKeepsViewAndBridges() {
        Robolectric.buildActivity(MainActivity::class.java).use { controller ->
            val activity = controller.setup().get()
            val web = webView(activity)
            val model = NativeBridges.modelHttp()
            controller.pause().stop()
            controller.restart().start().resume()
            assertSame(web, webView(activity))
            assertSame(model, shadowOf(web).getJavascriptInterface("zcodeModelHttp"))
            assertEquals("https://appassets.androidplatform.net/assets/ui/ui.html", web.url)
        }
    }

    @Test
    fun activityRecreationKeepsProcessBridges() {
        Robolectric.buildActivity(MainActivity::class.java).use { controller ->
            val before = controller.setup().get()
            val exec = NativeBridges.exec(before)
            val model = NativeBridges.modelHttp()
            controller.recreate()
            val after = controller.get()
            assertNotSame(before, after)
            assertNotNull(webView(after))
            assertSame(exec, NativeBridges.exec(after))
            assertSame(model, NativeBridges.modelHttp())
        }
    }

    @Test
    fun dialogsFollowAppThemeAndBridgeUpdatesRunOnMainThread() {
        Robolectric.buildActivity(MainActivity::class.java).use { controller ->
            val activity = controller.setup().get()
            val bridge = UIChromeBridge(activity) { webView(activity) }
            for (dark in listOf(false, true)) {
                Thread { bridge.setThemeDark(dark) }.apply { start(); join() }
                shadowOf(Looper.getMainLooper()).idle()
                assertEquals(if (dark) UIChromeBridge.DARK else UIChromeBridge.LIGHT, activity.window.navigationBarColor)
                val context = UIChromeBridge.dialogContext(activity)
                val attributes = context.obtainStyledAttributes(intArrayOf(android.R.attr.textColorPrimary))
                try {
                    assertEquals(dark, Color.luminance(attributes.getColorStateList(0)!!.defaultColor) > 0.5)
                } finally {
                    attributes.recycle()
                }
                assertEquals(dark, activity.getSharedPreferences("zcode-ui-chrome", Context.MODE_PRIVATE)
                    .getBoolean(UIChromeBridge.KEY_DARK, !dark))
            }
        }
    }
}
