package cn.zcode.mobile

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebView

/**
 * 附件选择的原生那一半。
 *
 * 为什么必须写这个：UI 在 `canSelectFilePath=false` 的平台上走的是隐藏 `<input type="file" multiple>`
 * （packages/ui/src/v4/composer/useComposerAttachments.ts:711），按钮一直是渲染的 —— 手机上点了没反应，
 * 不是因为 UI 藏了它，而是因为 **WebView 默认不处理文件选择**：`WebChromeClient.onShowFileChooser`
 * 不实现时，Chromium 直接把这个请求丢掉。所以这一格是外壳的活，不是界面的活。
 *
 * 一条必须记住的坑：`onShowFileChooser` 给的 `ValueCallback` **每次都必须被调用一次**，取消也要
 * （回 null）。留着不回调，Chromium 会认为上一次选择还没结束，之后这个页面里所有文件输入都永久失灵
 * —— 那种失灵在真机上表现为"点附件按钮偶尔有用、点过一次取消之后就再也没反应"，极难从日志里看出来。
 */
class FileChooser(private val activity: Activity) : WebChromeClient() {

    private var pending: ValueCallback<Array<Uri>>? = null

    override fun onShowFileChooser(
        view: WebView,
        filePathCallback: ValueCallback<Array<Uri>>,
        params: FileChooserParams,
    ): Boolean {
        // 上一次没回调完就先补掉，绝不能让两个 pending 并存（第二个永远等不到结果）。
        pending?.onReceiveValue(null)
        pending = filePathCallback

        // 在 Chromium 给的 intent 上做两件事：改成 OPEN_DOCUMENT（SAF 选择器，返回的 content:// 在
        // 这次进程里稳定可读，跨目录多选也靠它），并把多选显式打开。
        // 不去问"有没有 activity 接这个 intent"：Android 11 的包可见性限制会让 resolveActivity 对
        // 系统文档选择器也返回 null，那样等于每次都退化。直接发起，接不住就走下面的 catch。
        val intent = params.createIntent().apply {
            action = Intent.ACTION_OPEN_DOCUMENT
            addCategory(Intent.CATEGORY_OPENABLE)
            putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
        }
        return try {
            activity.startActivityForResult(Intent.createChooser(intent, null), REQUEST_CODE)
            true
        } catch (e: Exception) {
            // 手机上没装任何能选文件的组件（工作资料/极简 ROM 真有这样的）。
            // 这里必须当场回 null 把 pending 结掉，否则就是上面那条"永久失灵"。
            closeWith(null)
            false
        }
    }

    /**
     * Activity 的 `onActivityResult` 转发到这里。
     * @return true 表示这个 requestCode 是我的（调用方据此决定是否继续分发）。
     */
    fun handleResult(requestCode: Int, resultCode: Int, data: Intent?): Boolean {
        if (requestCode != REQUEST_CODE) return false
        val callback = pending
        pending = null
        if (callback == null) return true
        if (resultCode != Activity.RESULT_OK) {
            callback.onReceiveValue(null)
            return true
        }
        val uris = extract(data)
        callback.onReceiveValue(if (uris.isEmpty()) null else uris.toTypedArray())
        return true
    }

    private fun extract(data: Intent?): List<Uri> {
        val picked = mutableListOf<Uri>()
        data?.clipData?.let { clip ->
            for (i in 0 until clip.itemCount) picked += clip.getItemAt(i).uri
        }
        data?.data?.let { picked += it }
        // 有些实现在 EXTRA_STREAM 里给结果，且没有 clipData。
        if (picked.isEmpty()) {
            (data?.extras?.get(Intent.EXTRA_STREAM) as? Uri)?.let { picked += it }
        }
        return picked.distinct()
    }

    private fun closeWith(value: Array<Uri>?) {
        pending?.onReceiveValue(value)
        pending = null
    }

    private companion object {
        const val REQUEST_CODE = 42_713
    }
}
