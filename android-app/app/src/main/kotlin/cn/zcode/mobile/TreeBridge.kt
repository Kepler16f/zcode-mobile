package cn.zcode.mobile

import android.content.Context
import android.database.Cursor
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.DocumentsContract
import android.util.Base64
import android.webkit.JavascriptInterface
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileNotFoundException

/**
 * 外部工作区的文件后端（zcodeTree）。SAF 树 URI 的读写口 —— FsBridge 那棵私有树被
 * `resolve()` 的 canonical 越界闸钉死在应用目录里（R11：工具不能借符号链接摸出沙箱），
 * 所以外部目录不能塞进同一棵树假装存在，只能另起一个后端、由 vfs-native 按 `/mnt/` 前缀派发。
 *
 * 为什么必须走 DocumentFile 而不是把 tree URI 还原成 `/storage/emulated/0/...` 再用 java.io.File：
 * scoped storage 下 SAF 授权只随 URI 走，File API 直接访问返回 EACCES —— 拿到路径反而是骗人的，
 * 选完目录打开就是"读取目录失败"。DocumentFile 是这条授权唯一合法的读法。
 *
 * 已知窄化，写在明处：
 *  - 没有符号链接语义：kind 只会是 file/dir，readlink/symlink 如实报 EPERM；
 *  - 跨目录 rename 不支持（DocumentFile.renameTo 只改同级名），跨父目录报 EXDEV；
 *  - readMany 在树上退化为逐文件读（DocumentsContract 没有批量口），协议形状不变。
 * 挂载点表在 SharedPreferences("zcode-trees")：冷启动后 JS 不需要重新选目录，
 * 按持久化 URI 权限（takePersistableUriPermission 的那条）现场重建 DocumentFile。
 */
class TreeBridge(private val context: Context) {

    @JavascriptInterface
    fun name(): String = "zcodeTree"

    /** WorkspaceBridge.forgetTree 释放授权后调：内存缓存里那棵必须一起清，不然 findRootDoc 会复活它。 */
    fun forget(name: String) {
        cache.remove(name)
    }

    /**
     * WorkspaceBridge 选完目录后调用：登记挂载点并返回 vfs 名（`/mnt/<name>`），失败返回空串。
     * 判据是"持久化的读授权"：只读到 read-only 树（个别 provider）照样挂载，写操作由
     * provider 当场报 EACCES —— 这比"用户选了目录但什么都没发生"诚实。
     */
    fun registerTree(uri: Uri, modeFlags: Int): String {
        val granted = context.contentResolver.persistedUriPermissions
            .any { it.uri == uri && it.isReadPermission }
        if (!granted) return ""
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val base = sanitizeName(uri)
        var name = base
        var n = 2
        // 名字撞车（两个同名文件夹）时加序号：挂载名同时是 findRoot 的键，重名会静默开错目录。
        while (prefs.contains(name) && prefs.getString(name, "") != uri.toString()) {
            name = "$base#$n"
            n++
        }
        prefs.edit().putString(name, uri.toString()).putInt("$name#mode", modeFlags).apply()
        cache.put(name, uri)
        return "/mnt/$name"
    }

    /**
     * 0.7.9（症状 2"指定了本地文件夹就不要虚拟磁盘映射"）：把 SAF 树 URI 还原成**真实本地路径**
     * 的候选。三条硬条件，缺一不回 null：
     *  1. MANAGE_EXTERNAL_STORAGE 已授予 —— 没授予时 java.io.File 对 /storage 直接 EACCES，
     *     把真路径交出去等于给工具链一个"看得见摸不着"的假工作区（这正是 scoped storage 时代
     *     必须走 DocumentFile 的原因，见本文件头注）。
     *  2. 树是主存储卷（"primary"/"home" documentId、content://com.android.externalstorage
     *     权威 provider）：SD 卡 / USB / 其它 app 的 provider 没有稳定的 POSIX 拼写，回 null
     *     维持 /mnt/<名> 镜像那套。
     *  3. 目录当场存在且可列 —— 还原错了宁可退回镜像，不交一个工具链走不通的路径。
     * documentId 形态是 `volume:relative/path`（如 "primary:Download/我的项目"、"home" = 根）。
     * **返回 /sdcard 拼写**，不返回 /storage/emulated/0：FsBridge.virtual() 把外部树的结果反演成
     * /sdcard/…（0.7.4 直通支），工作区根、systemPrompt 的 "Workspace path on device"、工具回包、
     * Bash 的 cd 与 ls 输出必须是同一串拼写——模型按返回路径再读又"找不到"就是拼写漂移的代价。
     * file-system.mjs 的 guard 第一分支同样认 /sdcard。整条链不再有镜像、不再有 /mnt。
     */
    fun realPathOfExternalTree(uri: Uri): String? {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return null
        if (!Environment.isExternalStorageManager()) return null
        if (uri.authority != "com.android.externalstorage.documents") return null
        val docId = runCatching { DocumentsContract.getTreeDocumentId(uri) }.getOrNull() ?: return null
        // 只认主卷："primary"（含 "primary:<path>"）与孤立的 "home"（DocumentsUI 本地磁盘根）。
        // "home:<别的东西>" 是 home 虚拟根下的卷级 documentId（如 home:primary、home:0000-0000/…），
        // 它的 relative 段不是主卷相对路径——一律回 null 走 SAF 镜像；"0000-0000"/"usb" 等卷前缀
        // 与其它 provider 同理由不直写。
        if (docId != "home" && docId != "primary" && !docId.startsWith("primary:")) return null
        val relative = docId.substringAfter(':', "").replace('\\', '/').trim('/')
        if (relative.isNotEmpty()) {
            // 逐级防 ".."/空段逃逸；任何畸形回 null（宁可退回 /mnt 镜像，不交一个越界路径）。
            if (relative.split('/').any { it.isEmpty() || it == ".." }) return null
        }
        val base = runCatching { Environment.getExternalStorageDirectory().canonicalPath }.getOrNull()
            ?: return null
        val real = if (relative.isEmpty()) File(base) else File(base, relative.split('/').joinToString(File.separator))
        val canonical = runCatching { real.canonicalPath }.getOrDefault(real.absolutePath)
        if (canonical != base && !canonical.startsWith(base + File.separator)) return null
        if (!real.isDirectory) return null
        return if (relative.isEmpty()) "/sdcard" else "/sdcard/" + relative
    }

    @JavascriptInterface
    fun call(request: String): String {
        val req = try {
            JSONObject(request)
        } catch (e: Exception) {
            return fail("EINVAL", "", "请求不是 JSON: ${e.message}")
        }
        val path = req.optString("path")
        val op = req.optString("op")
        return try {
            when (op) {
                "touchRoot" -> ok(JSONObject().put("root", "zcodeTree"))
                "stat" -> ok(statOf(resolveDoc(path)))
                "exists" -> {
                    val doc = resolveDocOrNull(path)
                    ok(JSONObject().put("exists", doc != null))
                }
                "read" -> {
                    val doc = resolveDoc(path)
                    if (doc.isDirectory) return fail("EISDIR", path, "is a directory")
                    val bytes = context.contentResolver.openInputStream(doc.uri)?.use { it.readBytes() }
                        ?: return fail("EACCES", path, "openInputStream 返回空")
                    ok(JSONObject().put("base64", Base64.encodeToString(bytes, Base64.NO_WRAP)).put("size", bytes.size.toLong()))
                }
                "readMany" -> {
                    val items = JSONArray()
                    val paths = req.getJSONArray("paths")
                    for (i in 0 until paths.length()) {
                        val p = paths.getString(i)
                        val item = JSONObject().put("path", p)
                        try {
                            val doc = resolveDoc(p)
                            if (doc.isDirectory) {
                                item.put("ok", false).put("code", "EISDIR")
                            } else {
                                val bytes = context.contentResolver.openInputStream(doc.uri)?.use { it.readBytes() }
                                    ?: throw FileNotFoundException("openInputStream 返回空")
                                item.put("ok", true).put("base64", Base64.encodeToString(bytes, Base64.NO_WRAP))
                            }
                        } catch (e: Exception) {
                            item.put("ok", false).put("code", codeOf(e)).put("message", e.message ?: "")
                        }
                        items.put(item)
                    }
                    ok(JSONObject().put("items", items))
                }
                "write" -> write(req)
                "mkdir" -> mkdir(req.getString("path"), req.optBoolean("recursive"))
                "readdir" -> {
                    val doc = resolveDoc(path)
                    if (!doc.isDirectory) return fail("ENOTDIR", path, "不是目录")
                    val entries = JSONArray()
                    for (child in doc.listFiles().sortedBy { it.name ?: "" }) {
                        entries.put(
                            JSONObject()
                                // DocumentFile.getName 可能为 null（provider 没给），空名会让 readdirSync 的 Map 键撞在一起。
                                .put("name", child.name ?: "(unnamed)")
                                .put("kind", if (child.isDirectory) "dir" else "file"),
                        )
                    }
                    ok(JSONObject().put("entries", entries))
                }
                "unlink" -> {
                    val doc = resolveDoc(path)
                    if (doc.isDirectory) return fail("EISDIR", path, "是目录，请用 rmdir")
                    if (!doc.delete()) return fail("EACCES", path, "删除失败")
                    ok(JSONObject())
                }
                "rmdir" -> {
                    val doc = resolveDoc(path)
                    if (!doc.isDirectory) return fail("ENOTDIR", path, "不是目录")
                    if (doc.listFiles().isNotEmpty()) return fail("ENOTEMPTY", path, "目录非空")
                    if (!doc.delete()) return fail("EACCES", path, "删除失败")
                    ok(JSONObject())
                }
                "rm" -> rm(req)
                "rename" -> rename(req.getString("path"), req.getString("to"))
                "symlink", "readlink" ->
                    fail("EPERM", path, "SAF 树没有符号链接语义（不是权限问题，是 DocumentsContract 不提供）")
                "realpath" -> {
                    // 没有符号链接，规范化输入就是 canonical：identity 返回才是真话，
                    // 报 EPERM 会把 fs 垫片里每一个 realpathSync 都变成假故障。
                    val parts = split(path) ?: return fail("ENOENT", path, "不是树路径")
                    ok(JSONObject().put("path", "/mnt/" + parts.joinToString("/")))
                }
                else -> fail("EINVAL", path, "未知操作: $op")
            }
        } catch (e: Exception) {
            fail(codeOf(e), path, "${e.javaClass.simpleName}: ${e.message}")
        }
    }

    // ---- 路径 → DocumentFile ----

    private class Doc(val file: androidx.documentfile.provider.DocumentFile, val vfs: String) {
        // 派发分支直接按 DocumentFile 用（isDirectory/uri/delete/listFiles），别每处写 .file.。
        val uri: Uri get() = file.uri
        val isDirectory: Boolean get() = file.isDirectory
        fun listFiles(): Array<androidx.documentfile.provider.DocumentFile> = file.listFiles()
        fun delete(): Boolean = file.delete()
        fun exists(): Boolean = file.exists()
    }

    /**
     * `"/mnt/<name>/a/b"` → 从挂载根逐级 findFile 的 Doc。中间任何一级不存在就抛
     * FileNotFoundException（上层折成 ENOENT）；`"/mnt/<name>"` 本身是挂载根。
     */
    private fun resolveDocOrNull(path: String): Doc? {
        val parts = split(path) ?: return null
        val root = findRootDoc(parts[0]) ?: return null
        var cur = root
        for (seg in parts.drop(1)) {
            cur = cur.findFile(seg) ?: return null
        }
        return Doc(cur, path)
    }

    private fun resolveDoc(path: String): Doc =
        resolveDocOrNull(path) ?: throw FileNotFoundException("树里没有这个路径: $path")

    /** 返回 [挂载名, ...段]；不是 /mnt 下的合法形状就 null（调用方折成 ENOENT，不越到别的树里去找）。 */
    private fun split(path: String): List<String>? {
        val cleaned = path.trimStart('/')
        if (!cleaned.startsWith("mnt/")) return null
        val segs = cleaned.split("/").filter { it.isNotEmpty() && it != "." }
        if (segs.firstOrNull() != "mnt") return null
        val rest = segs.drop(1)
        // ".." 在这里不能当 Node 的 norm 语义用：JS 侧 norm 已经把 `..` 折掉了，能漏到这里就是异常形状。
        if (rest.isEmpty() || rest.any { it == ".." }) return null
        return rest
    }

    private fun findRootDoc(name: String): androidx.documentfile.provider.DocumentFile? {
        cache[name]?.let { return androidx.documentfile.provider.DocumentFile.fromTreeUri(context, it) }
        val uri = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(name, null)
            ?: return null
        val parsed = Uri.parse(uri)
        // 授权可能已被用户撤销：persistedUriPermissions 里没有就是没有，如实 ENOENT。
        val granted = context.contentResolver.persistedUriPermissions.any { it.uri == parsed }
        if (!granted) return null
        cache[name] = parsed
        return androidx.documentfile.provider.DocumentFile.fromTreeUri(context, parsed)
    }

    /** 父链（不含叶子）。父不存在时按 op 语义创建或报错，由调用方决定。 */
    private fun parentOf(path: String): Triple<Doc, String, String> {
        val parts = split(path) ?: throw IllegalArgumentException("不是树路径: $path")
        if (parts.size < 2) throw IllegalArgumentException("挂载根不可改动: $path")
        val parentPath = "/mnt/" + parts.dropLast(1).joinToString("/")
        val parent = resolveDoc(parentPath)
        return Triple(parent, parts.last(), parentPath)
    }

    private fun statOf(doc: Doc): JSONObject {
        val out = JSONObject().put("path", doc.vfs)
        val f = doc.file
        out.put("exists", true)
            .put("kind", if (f.isDirectory) "dir" else "file")
            .put("size", f.length())
            .put("mtimeMs", f.lastModified())
            .put("mode", if (f.isDirectory) "755".toInt(8) else "644".toInt(8))
            .put("isFile", f.isFile)
            .put("isDirectory", f.isDirectory)
            .put("isSymbolicLink", false)
        return out
    }

    private fun write(req: JSONObject): String {
        val path = req.getString("path")
        val bytes = Base64.decode(req.getString("base64"), Base64.DEFAULT)
        val append = req.optBoolean("append")
        val leaf = path.substringAfterLast('/')
        val parent = parentOf(path).first
        var target = parent.file.findFile(leaf)
        if (target == null) {
            target = parent.file.createFile(guessMime(leaf), leaf)
                ?: return fail("EACCES", path, "createFile 失败（provider 拒绝新建 ${guessMime(leaf)}）")
        } else if (target.isDirectory) {
            return fail("EISDIR", path, "is a directory")
        }
        // append 语义：先读旧内容再整体重写 —— DocumentsContract 没有随机写/追加的流模式，
        // "假装 append"（只写尾部、丢旧内容）比多读一遍更糟。
        if (append && target.exists()) {
            val old = context.contentResolver.openInputStream(target.uri)?.use { it.readBytes() } ?: ByteArray(0)
            val merged = old + bytes
            context.contentResolver.openOutputStream(target.uri, "w")?.use { it.write(merged) }
                ?: return fail("EACCES", path, "openOutputStream 返回空")
            return ok(JSONObject())
        }
        context.contentResolver.openOutputStream(target.uri, "w")?.use { it.write(bytes) }
            ?: return fail("EACCES", path, "openOutputStream 返回空")
        return ok(JSONObject())
    }

    private fun mkdir(path: String, recursive: Boolean): String {
        val parts = split(path) ?: return fail("ENOENT", path, "不是树路径")
        if (parts.size < 2) return ok(JSONObject()) // 挂载根：本来就在
        var cur = findRootDoc(parts[0]) ?: return fail("ENOENT", path, "挂载点不存在（授权可能被撤销）")
        for ((i, seg) in parts.drop(1).withIndex()) {
            val existing = cur.findFile(seg)
            if (existing != null) {
                if (!existing.isDirectory) return fail("ENOTDIR", "/mnt/" + parts.take(i + 2).joinToString("/"), "已存在但不是目录")
                cur = existing
            } else {
                // 非 recursive 时只许差一级：中间段缺失要给 ENOENT（与 FsBridge/内存盘同一语义）。
                if (!recursive && i < parts.size - 2) return fail("ENOENT", "/mnt/" + parts.take(i + 2).joinToString("/"), "父目录不存在")
                cur = cur.createDirectory(seg) ?: return fail("EACCES", path, "createDirectory 失败")
            }
        }
        return ok(JSONObject())
    }

    private fun rm(req: JSONObject): String {
        val path = req.getString("path")
        val doc = resolveDocOrNull(path)
        if (doc == null) {
            return if (req.optBoolean("force")) ok(JSONObject()) else fail("ENOENT", path, "no such file")
        }
        if (doc.file.isDirectory && doc.file.listFiles().isNotEmpty() && !req.optBoolean("recursive")) {
            return fail("ENOTEMPTY", path, "目录非空")
        }
        if (doc.file.isDirectory && req.optBoolean("recursive")) {
            deleteTree(doc.file)?.let { return fail("EACCES", path, it) }
            return ok(JSONObject())
        }
        if (!doc.file.delete()) return fail("EACCES", path, "删除失败")
        return ok(JSONObject())
    }

    /** 深度优先删整棵子树：provider 对"非空目录 delete"一律拒绝，只能自底向上。 */
    private fun deleteTree(dir: androidx.documentfile.provider.DocumentFile): String? {
        for (child in dir.listFiles()) {
            if (child.isDirectory) {
                deleteTree(child)?.let { return it }
            } else if (!child.delete()) {
                return "删除失败 ${child.name}"
            }
        }
        return if (dir.delete() || !dir.exists()) null else "删除失败 ${dir.name}"
    }

    private fun rename(from: String, to: String): String {
        val fromParts = split(from) ?: return fail("EINVAL", from, "不是树路径")
        val toParts = split(to) ?: return fail("EINVAL", to, "不是树路径")
        if (fromParts.take(1) != toParts.take(1)) {
            return fail("EXDEV", from, "SAF 树之间不支持移动（每棵树是独立的授权根）")
        }
        if (fromParts.dropLast(1) != toParts.dropLast(1)) {
            return fail("EXDEV", from, "同一挂载内的跨目录移动不支持（DocumentsContract 只给同级改名）")
        }
        val doc = resolveDoc(from)
        if (doc.file.isDirectory) return fail("EISDIR", from, "目录同级改名在 SAF 上没有可靠接口，先别假装成功")
        val targetName = toParts.last()
        val parent = resolveDoc("/mnt/" + toParts.dropLast(1).joinToString("/"))
        if (parent.file.findFile(targetName) != null) return fail("EEXIST", to, "目标已存在")
        if (!doc.file.renameTo(targetName)) return fail("EACCES", from, "renameTo 失败")
        return ok(JSONObject().put("path", to))
    }

    private fun guessMime(name: String): String {
        val ext = name.substringAfterLast('.', "").lowercase()
        return MIME_BY_EXT[ext] ?: "application/octet-stream"
    }

    private fun codeOf(e: Exception): String = when {
        e is FileNotFoundException -> "ENOENT"
        e is UnsupportedOperationException -> "EPERM"
        e is SecurityException -> "EACCES"
        e is IllegalArgumentException -> "EINVAL"
        e.javaClass.name.contains("AccessDenied") -> "EACCES"
        else -> "EIO"
    }

    private fun sanitizeName(uri: Uri): String {
        // 挂载名要进路径段：过滤掉 `/`、`..`、空白与空结果，保底 "tree"。
        val raw = runCatching {
            var name: String? = null
            context.contentResolver.query(uri, arrayOf(DocumentsContract.Document.COLUMN_DISPLAY_NAME), null, null, null)
                ?.use { c: Cursor -> if (c.moveToFirst()) name = c.getString(0) }
            name
        }.getOrNull().orEmpty()
        // 0.4.8（装机"项目显示的不是文件夹名称，而是 tree"）：个别 provider 对树根的
        // DISPLAY_NAME 查询返回空——保底改用树 URI 的 documentId 尾段（"primary:Foo/Bar"
        // 形态，最后一段就是所选文件夹名），仍取不到才退 "tree"。已挂载的旧名不迁移：
        // 换名等于换 findRoot 的键，重选一次目录即得新名。
        val fromDocId = if (raw.isBlank()) {
            runCatching {
                DocumentsContract.getTreeDocumentId(uri).substringAfterLast('/').substringAfter(':')
            }.getOrNull().orEmpty()
        } else ""
        val cleaned = (raw.ifBlank { fromDocId }).replace(Regex("[\\\\/:*?\"<>|#]"), "").trim().take(40)
        return cleaned.ifEmpty { "tree" }
    }

    private companion object {
        const val PREFS = "zcode-trees"
        val cache = HashMap<String, Uri>()
        val MIME_BY_EXT = mapOf(
            "txt" to "text/plain", "md" to "text/markdown", "json" to "application/json",
            "ts" to "text/plain", "tsx" to "text/plain", "js" to "text/javascript", "mjs" to "text/javascript",
            "kt" to "text/plain", "java" to "text/plain", "py" to "text/x-python", "html" to "text/html",
            "css" to "text/css", "png" to "image/png", "jpg" to "image/jpeg", "jpeg" to "image/jpeg",
            "gif" to "image/gif", "svg" to "image/svg+xml", "pdf" to "application/pdf",
            "zip" to "application/zip", "mp4" to "video/mp4",
        )
    }
}

/** 与 FsBridge 对齐的最小 ok/fail 形状（fs 派发层按同一协议读）。 */
private fun ok(payload: JSONObject): String = payload.put("ok", true).toString()

private fun fail(code: String, path: String, message: String?): String =
    JSONObject().put("ok", false).put("code", code).put("path", path).put("message", message ?: "").toString()
