package cn.zcode.mobile

import android.app.AlertDialog
import android.app.Activity
import android.os.Build
import android.os.Environment
import android.widget.Toast
import java.io.File
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.util.Log
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import android.webkit.JavascriptInterface
import org.json.JSONArray
import org.json.JSONObject

/**
 * 系统文件夹选择器（工作区选择的原生那一半）。
 *
 * 0.3.6 装机反馈"新建项目工作区选择还是没使用系统文件管理器"：selectDirectory() 恒回 null，
 * UI 只能用端内目录浏览器 —— 那棵树只有应用私有的 /work，真机上根本到不了"下载/Documents"。
 * 这里把 `ACTION_OPEN_DOCUMENT_TREE`（系统 DocumentsUI）接进 platform.selectDirectory()，
 * 选中的目录经 TreeBridge 挂载成 `/mnt/<名>`，读写走 DocumentFile（scoped storage 唯一合法通路）。
 *
 * 两条不能省的线：
 *  1. takePersistableUriPermission：不持久化的话冷启动后打开这个工作区就是"读取目录失败"
 *     ——表现为"能用一阵、重启就坏"。拿不到持久授权（个别 provider）时如实不挂载，别给假工作区。
 *  2. 结果回传不能走同步通道：@JavascriptInterface 是阻塞调用，发起那一次等不到 Activity 结果。
 *     所以发起同步回"started"，结果由 onActivityResult → evaluateJavascript("__zcodeWorkspacePicked")
 *     推回 JS 挂着的 Promise（platform.ts 那侧有超时兜底，任何退出路径都必须结掉它，否则
 *     "打开工作区"按钮永久转圈 —— 与 FileChooser 的 ValueCallback 是同一条纪律）。
 */
class WorkspaceBridge(
    private val activity: Activity,
    private val treeBridge: TreeBridge,
    private val webViewProvider: () -> WebView?,
) {

    @JavascriptInterface
    fun name(): String = "zcodeWorkspace"

    // 单一选择所有者与请求 ID：超时后的旧结果不能落到下一次选择请求。
    @Volatile private var activeRequest: String? = null
    @Volatile private var pendingSafRequest: String? = null
    private var pickerDialog: AlertDialog? = null

    @JavascriptInterface
    @Synchronized
    fun pickDirectory(requestId: String): String {
        if (requestId.isBlank() || activeRequest != null || pendingSafRequest != null) {
            return JSONObject().put("started", false).put("error", "已有目录选择正在进行").toString()
        }
        activeRequest = requestId
        activity.runOnUiThread {
            if (activeRequest != requestId) return@runOnUiThread
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
                // 旧系统没有“所有文件访问”设置入口，直接使用系统文档选择器。
                startSaf(requestId)
            } else if (Environment.isExternalStorageManager()) {
                showLocalDirectory(Environment.getExternalStorageDirectory(), requestId)
            } else {
                pickerDialog = AlertDialog.Builder(UIChromeBridge.dialogContext(activity))
                    .setTitle("选择工作区目录")
                    .setMessage("本地文件夹可直接读写，无需 SAF 镜像。请先授予所有文件访问权限；也可使用系统文档提供方。")
                    .setPositiveButton("授权本地文件夹") { _, _ ->
                        deliver(null)
                        DeviceProbe(activity).openAllFilesPermission()
                        Toast.makeText(activity, "授权后请重新选择工作区", Toast.LENGTH_LONG).show()
                    }
                    .setNeutralButton("系统文档（SAF）") { _, _ -> startSaf(requestId) }
                    .setNegativeButton("取消") { _, _ -> deliver(null) }
                    .setOnCancelListener { deliver(null) }
                    .show()
            }
        }
        return JSONObject().put("started", true).toString()
    }

    @JavascriptInterface
    fun cancelDirectory(requestId: String) {
        activity.runOnUiThread {
            if (activeRequest != requestId) return@runOnUiThread
            pickerDialog?.dismiss()
            pickerDialog = null
            deliver(null)
        }
    }

    private fun showLocalDirectory(directory: File, requestId: String) {
        // 文件扫描在后台完成，目录很多时不阻塞 WebView 和原生界面。
        Thread {
            val base = runCatching { Environment.getExternalStorageDirectory().canonicalFile }.getOrNull()
            if (base == null) {
                activity.runOnUiThread { if (activeRequest == requestId) deliver(null) }
                return@Thread
            }
            val current = runCatching { directory.canonicalFile }.getOrNull()
            val children = if (current != null &&
                (current == base || current.path.startsWith(base.path + File.separator))) {
                current.listFiles()?.filter { it.isDirectory }?.sortedBy { it.name.lowercase() }
            } else null
            activity.runOnUiThread {
                if (activeRequest != requestId || activity.isFinishing) return@runOnUiThread
                if (current == null || children == null) {
                    Toast.makeText(activity, "无法读取该目录，请检查系统访问权限", Toast.LENGTH_LONG).show()
                    if (current == base || current == null) deliver(null)
                    else showLocalDirectory(base, requestId)
                    return@runOnUiThread
                }
                val parent = if (current == base) null else current.parentFile
                val labels = (if (parent != null) listOf("↑ 上一级") else emptyList()) + children.map { "📁 ${it.name}" }
                pickerDialog = AlertDialog.Builder(UIChromeBridge.dialogContext(activity))
                    .setTitle("/sdcard" + current.path.removePrefix(base.path))
                    .setItems(labels.toTypedArray()) { _, index ->
                        if (parent != null && index == 0) showLocalDirectory(parent, requestId)
                        else showLocalDirectory(children[index - if (parent != null) 1 else 0], requestId)
                    }
                    .setPositiveButton("使用此文件夹") { _, _ ->
                        deliver("/sdcard" + current.path.removePrefix(base.path))
                    }
                    .setNeutralButton("系统文档（SAF）") { _, _ -> startSaf(requestId) }
                    .setNegativeButton("取消") { _, _ -> deliver(null) }
                    .setOnCancelListener { deliver(null) }
                    .show()
            }
        }.start()
    }

    private fun startSaf(requestId: String) {
        if (activeRequest != requestId) return
        try {
            val intent = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).apply {
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION or
                    Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION)
            }
            pendingSafRequest = requestId
            activity.startActivityForResult(intent, REQUEST_CODE)
        } catch (e: Exception) {
            Log.w(TAG, "无法打开系统文档选择器", e)
            pendingSafRequest = null
            deliver(null)
        }
    }

    /**
     * Activity 的 onActivityResult 转发到这里。
     * @return true 表示这个 requestCode 是我的（调用方据此决定是否继续分发）。
     */
    fun handleResult(requestCode: Int, resultCode: Int, data: Intent?): Boolean {
        if (requestCode != REQUEST_CODE) return false
        val expectedRequest = pendingSafRequest
        pendingSafRequest = null
        if (expectedRequest == null || activeRequest != expectedRequest) return true
        if (resultCode != Activity.RESULT_OK) {
            deliver(null)
            return true
        }
        val uri = data?.data
        if (uri == null) {
            deliver(null)
            return true
        }
        val grantFlags = data.flags and
            (Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
        try {
            activity.contentResolver.takePersistableUriPermission(uri, grantFlags)
        } catch (_: Exception) {
            // 拿不到持久授权：本进程内仍可读，但重启会丢。registerTree 按"未持久化"拒绝挂载，
            // 下面会如实回 null 让用户重选，而不是给一个"打开了但重启就坏"的假工作区。
        }
        // 0.7.9（症状 2"如果我指定了本地文件夹，就不要用什么虚拟磁盘映射了"）：授予"所有文件
        // 访问"后，主存储卷的树 URI 有真实 POSIX 拼写（/sdcard/<相对路径>）——直接把它当工作区根
        // 交回 JS，不再 registerTree，不再 /mnt/<名> 虚拟根，不再有 vfs-stage 镜像/回写两拍。
        // FsBridge 的直通支（0.7.4）认这条拼写并当场读写真实文件；ExecBridge 的 cwd 映射同步
        // 放行（见 workspaceFile）。判定不成立（SD 卡/USB/其它 provider、未授权、目录不存在）时
        // 回落到旧的 SAF 挂载——scoped storage 下那是唯一合法通路，宁可用镜像也不给假路径。
        val realPath = treeBridge.realPathOfExternalTree(uri)
        if (realPath != null) {
            Log.i(TAG, "工作区走真实路径（不再挂载 /mnt）：$realPath")
            deliver(realPath)
            return true
        }
        val mounted = treeBridge.registerTree(uri, grantFlags)
        deliver(if (mounted.isEmpty()) null else mounted)
        return true
    }

    /** 已挂载的外部工作区（JS 侧启动页/侧栏可显示"工作区在设备上哪里"）。 */
    @JavascriptInterface
    fun listTrees(): String {
        val prefs = activity.getSharedPreferences(TREE_PREFS, Context.MODE_PRIVATE)
        val out = JSONArray()
        for ((key, value) in prefs.all) {
            if (key.endsWith("#mode") || value !is String) continue
            out.put(JSONObject().put("name", key).put("vfs", "/mnt/$key").put("uri", value))
        }
        return out.toString()
    }

    /** 仅升级旧本地主卷SAF授权；保留挂载名和URI供旧项目、会话继续识别。 */
    @JavascriptInterface
    fun localTreeAliases(): String {
        val prefs = activity.getSharedPreferences(TREE_PREFS, Context.MODE_PRIVATE)
        val aliases = JSONObject()
        for ((key, value) in prefs.all) {
            if (key.endsWith("#mode") || value !is String) continue
            val path = runCatching { treeBridge.realPathOfExternalTree(Uri.parse(value)) }.getOrNull() ?: continue
            aliases.put("/mnt/$key", path)
        }
        return aliases.toString()
    }

    /** 卸载挂载点：不删用户数据，只是应用放弃这棵树的授权。 */
    @JavascriptInterface
    fun forgetTree(name: String): String {
        val prefs = activity.getSharedPreferences(TREE_PREFS, Context.MODE_PRIVATE)
        val uri = prefs.getString(name, null) ?: return JSONObject().put("ok", false).toString()
        // release 必须带当初 take 时的 flags（Android SDK 的签名要求，少传编译不过）。
        val flags = prefs.getInt("$name#mode", Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
        runCatching { activity.contentResolver.releasePersistableUriPermission(Uri.parse(uri), flags) }
        prefs.edit().remove(name).remove("$name#mode").apply()
        // 内存缓存里那棵必须一起清（TreeBridge.findRootDoc 先查缓存，不清就是"已卸载还能读写"）。
        treeBridge.forget(name)
        return JSONObject().put("ok", true).toString()
    }

    private fun deliver(vfsPath: String?) {
        val requestId = activeRequest ?: return
        activeRequest = null
        pickerDialog = null
        val literal = if (vfsPath == null) "null" else JSONObject.quote(vfsPath)
        activity.runOnUiThread {
            val web = webViewProvider()
            if (web == null) {
                // 布局层级变了才会走到这里；JS 那侧由超时兜底，不永久挂住。
                Log.w(TAG, "deliver: WebView 不可用，结果只能等超时兜底: $vfsPath")
                return@runOnUiThread
            }
            web.evaluateJavascript("window.__zcodeWorkspacePicked&&window.__zcodeWorkspacePicked($literal,${JSONObject.quote(requestId)})", null)
        }
    }

    private companion object {
        const val REQUEST_CODE = 42_817
        const val TAG = "WorkspaceBridge"
        const val TREE_PREFS = "zcode-trees"
    }
}
