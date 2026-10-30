package cn.zcode.mobile

import android.content.Context
import android.os.Build
import android.os.Environment
import android.util.Base64
import android.webkit.JavascriptInterface
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileNotFoundException
import java.io.FileOutputStream
import java.nio.file.AccessDeniedException
import java.nio.file.FileAlreadyExistsException
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.NoSuchFileException
import java.nio.file.NotDirectoryException
import java.nio.file.StandardCopyOption
import java.nio.file.attribute.BasicFileAttributes

/**
 * 端侧文件真的落在哪 —— §1.5.4 真机数据排出来的第一条修复。
 *
 * 为什么不能用 OPFS：OPD2511 实测 `navigator.storage.getDirectory()` 直接 TypeError，
 * WebView 没把 OPFS 暴露出来（IndexedDB 与 10 GB quota 都正常）。而 node:fs 与 FileSystemPort
 * 的契约全是同步的（readFileSync/statSync/readdirSync），所以这里和 SqliteBridge 一样走
 * `@JavascriptInterface` 同步通道，单入口 `call(JSON)`。
 *
 * 落点必须和 Bash 的 cwd 是同一棵树：ExecBridge 把虚拟路径拼在 workspaceRoot() 下面，
 * 这里用同一个根、同一个拼法，`Write` 写完 `Bash` 里 `ls` 才看得见。
 *
 * 已知窄化，写在明处：
 *  - 内容整读整写、只能过字符串（base64），没有 fd / 流式语义；大文件会一次性进 JS 堆。
 *    真需要流式的是 SQLite，那条走 SqliteBridge 而不是这里。
 *  - 权限位只回传不 enforce：越界拒绝在 FileSystemPort 的 guard()（工作区之外 permission_denied），
 *    目录本身是应用私有（MODE_PRIVATE），只有本 app uid 能进（R11）。
 *  - 没有 watch/watchFile：fs 事件在 WebView 侧只能是轮询，这一版不提供，也不假装提供。
 */
class FsBridge(private val context: Context) {

    @JavascriptInterface
    fun name(): String = "zcodeFs"

    /** 同步入口：JS 线程阻塞在这里。request 形如 {"op":"read","path":"/work/a.ts"}。 */
    @JavascriptInterface
    fun call(request: String): String {
        val req = try {
            JSONObject(request)
        } catch (e: Exception) {
            return fail("EINVAL", "", "请求不是 JSON: ${e.message}")
        }
        val op = req.optString("op")
        // 出错时要把原样路径回给 JS，所以 path 在 try 外先取。
        // 协议只有一种形态：**主体永远在 `path`，目的地在 `to`，链接目标在 `target`**。
        // JS 侧（compat/vfs-native.mjs）就按这个发；这里若再接受别名，两侧就会各写一套然后漂移——
        // 真机 0.0.2 的 rename 就是这么炸的（Kotlin 读 `from`，JS 只发 `path`）。
        val path = req.optString("path")
        return try {
            when (op) {
                "stat" -> ok(statOf(resolve(req.getString("path"))))
                "statMany" -> statMany(req.getJSONArray("paths"))
                "exists" -> ok(JSONObject().put("exists", exists(resolve(req.getString("path")))))
                "read" -> read(req.getString("path"))
                "readMany" -> readMany(req.getJSONArray("paths"))
                "write" -> write(req)
                "mkdir" -> mkdir(req.getString("path"), req.optBoolean("recursive"))
                "readdir" -> readdir(req.getString("path"))
                "unlink" -> unlink(req.getString("path"))
                "rmdir" -> rmdir(req.getString("path"))
                "rm" -> rm(req)
                "rename" -> {
                    val to = resolve(req.getString("to"))
                    Files.move(resolve(req.getString("path")).toPath(), to.toPath(), StandardCopyOption.REPLACE_EXISTING)
                    ok(JSONObject().put("path", virtual(to)))
                }
                "copy" -> {
                    val from = resolve(req.getString("path")).toPath()
                    val to = resolve(req.getString("to")).toPath()
                    to.parent?.let { Files.createDirectories(it) }
                    Files.copy(from, to, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.COPY_ATTRIBUTES)
                    ok(JSONObject().put("path", virtual(to.toFile())))
                }
                "symlink" -> symlink(req.getString("target"), req.getString("path"))
                "readlink" -> {
                    val link = resolve(req.getString("path"))
                    val target = Files.readSymbolicLink(link.toPath())
                    ok(JSONObject().put("link", virtualOfReal(target.toString(), link.parentFile)))
                }
                "realpath" -> ok(JSONObject().put("path", virtual(resolve(req.getString("path")).canonicalFile)))
                "touchRoot" -> {
                    root().mkdirs()
                    ok(JSONObject().put("root", root().absolutePath))
                }
                else -> fail("EINVAL", path, "未知操作: $op")
            }
        } catch (e: NoSuchFileException) {
            fail("ENOENT", path, e.message)
        } catch (e: FileNotFoundException) {
            fail("ENOENT", path, e.message)
        } catch (e: NotDirectoryException) {
            fail("ENOTDIR", path, e.message)
        } catch (e: FileAlreadyExistsException) {
            fail("EEXIST", path, e.message)
        } catch (e: AccessDeniedException) {
            fail("EACCES", path, e.message)
        } catch (e: Exception) {
            fail(codeOf(e), path, "${e.javaClass.simpleName}: ${e.message}")
        }
    }

    // ---- 各操作 ----

    /**
     * 批量 stat：一次过桥换一批路径的 kind/mtime/size。
     * 文件监视（0.9.3）是轮询实现，逐个 stat 会变成 N 次同步往返、每次都阻塞 WebView 主线程；
     * 一次批量把整目录的签名取回来，轮询才有意义。
     *
     * 形状与 readMany 一致：外层 ok:true，每项自带 ok，失败项不影响其余项。
     */
    private fun statMany(paths: JSONArray): String {
        val items = JSONArray()
        for (i in 0 until paths.length()) {
            val path = paths.optString(i)
            items.put(try {
                statOf(resolve(path)).put("ok", true)
            } catch (e: Exception) {
                JSONObject().put("path", path).put("ok", false).put("code", codeOf(e)).put("message", "${e.javaClass.simpleName}: ${e.message}")
            })
        }
        return JSONObject().put("ok", true).put("items", items).toString()
    }

    private fun statOf(file: File): JSONObject {
        val out = JSONObject().put("path", virtual(file))
        val attrs = runCatching {
            Files.readAttributes(file.toPath(), BasicFileAttributes::class.java, LinkOption.NOFOLLOW_LINKS)
        }.getOrNull() ?: return out.put("exists", false)
        out.put("exists", true)
            .put("kind", when {
                attrs.isSymbolicLink -> "link"
                attrs.isDirectory -> "dir"
                attrs.isRegularFile -> "file"
                else -> "other"
            })
            .put("size", attrs.size())
            .put("mtimeMs", attrs.lastModifiedTime().toMillis())
            // 权限位取自 File，够 stat 回显用；不 enforce（见类注释）。
            .put("mode", modeOf(file))
            .put("isFile", attrs.isRegularFile)
            .put("isDirectory", attrs.isDirectory)
            .put("isSymbolicLink", attrs.isSymbolicLink)
        return out
    }

    private fun modeOf(file: File): Int {
        // Kotlin 没有八进制字面量，"755".toInt(8) 比 0x1ED 好读。
        // 这里只求"看起来对"：私有目录的实际权限由 app uid 决定，mode 只是回显。
        val base = if (file.isDirectory) "755".toInt(8) else "644".toInt(8)
        return if (file.canExecute()) base or "111".toInt(8) else base
    }

    /**
     * 单个读取的形状。`read` 和 `readMany` 共用这一个函数而不是各写一遍：批量那条要是自己再判一次
     * 存在性、再编一次 base64，两侧就会在"目录算 EISDIR 还是 ENOENT"这种地方漂开。
     */
    private fun readItem(path: String): JSONObject {
        val file = resolve(path)
        if (file.isDirectory) return JSONObject().put("path", path).put("ok", false).put("code", "EISDIR").put("message", "is a directory")
        if (!exists(file)) return JSONObject().put("path", path).put("ok", false).put("code", "ENOENT").put("message", "no such file or directory")
        val bytes = file.readBytes()
        return JSONObject()
            .put("path", path)
            .put("ok", true)
            .put("base64", Base64.encodeToString(bytes, Base64.NO_WRAP))
            .put("size", bytes.size.toLong())
            .put("mtimeMs", file.lastModified())
    }

    private fun read(path: String): String = readItem(path).toString()

    /**
     * 批量读：一次过桥换一批文件，这是 §7 R23 的修法（真机 grep 3000 个文件要 3063 次同步往返，
     * 1231.8 ms；其中多少是往返、多少是那 16 MB base64 的序列化，只有装机能判，见 §1.5.10）。
     *
     * 外层永远 `ok:true`，每个文件的成功失败在自己的 item 里：一个不存在的路径不能把整批打折退回，
     * 否则调用方拿到"整批失败"只能退回逐文件读，批量就白做了。
     */
    private fun readMany(paths: JSONArray): String {
        val items = JSONArray()
        for (i in 0 until paths.length()) {
            val path = paths.optString(i)
            items.put(try {
                readItem(path)
            } catch (e: Exception) {
                JSONObject().put("path", path).put("ok", false).put("code", codeOf(e)).put("message", "${e.javaClass.simpleName}: ${e.message}")
            })
        }
        return JSONObject().put("ok", true).put("items", items).toString()
    }

    private fun write(req: JSONObject): String {
        val path = req.getString("path")
        val file = resolve(path)
        val bytes = Base64.decode(req.optString("base64"), Base64.NO_WRAP)
        if (file.isDirectory) return fail("EISDIR", path, "is a directory")
        // parentFile 在类型上是可空的（JDK 只在路径没有父目录时返回 null）。这里即使 resolve
        // 保证了不会拿到根目录，也不让它以 NPE 的形式穿过 @JavascriptInterface 变成 JS 侧的未知异常。
        val parent = file.parentFile ?: return fail("EINVAL", path, "没有父目录: $path")
        if (req.optBoolean("createParents", true)) {
            if (!parent.isDirectory) parent.mkdirs()
        }
        if (!parent.isDirectory) {
            return fail(if (parent.exists()) "ENOTDIR" else "ENOENT", path, "父目录不存在: ${parent.absolutePath}")
        }
        FileOutputStream(file, req.optBoolean("append")).use { it.write(bytes) }
        return ok(JSONObject().put("bytesWritten", bytes.size.toLong()).put("mtimeMs", file.lastModified()))
    }

    private fun mkdir(path: String, recursive: Boolean): String {
        val file = resolve(path)
        if (file.isDirectory) return ok(JSONObject())
        if (exists(file)) return fail("EEXIST", path, "已存在但不是目录")
        if (!recursive) {
            val parent = file.parentFile ?: return fail("EINVAL", path, "没有父目录: $path")
            if (!parent.isDirectory) {
                return fail(if (parent.exists()) "ENOTDIR" else "ENOENT", path, "父目录不存在")
            }
        }
        if (!file.mkdirs()) return fail("EACCES", path, "mkdirs 失败")
        return ok(JSONObject())
    }

    private fun readdir(path: String): String {
        val file = resolve(path)
        if (!exists(file)) return fail("ENOENT", path, "no such directory")
        if (!file.isDirectory) return fail("ENOTDIR", path, "不是目录")
        val children = file.listFiles() ?: return fail("EACCES", path, "无法列出目录")
        val entries = JSONArray()
        for (child in children.sortedBy { it.name }) {
            entries.put(
                JSONObject()
                    .put("name", child.name)
                    .put("kind", if (Files.isSymbolicLink(child.toPath())) "link" else if (child.isDirectory) "dir" else "file"),
            )
        }
        return ok(JSONObject().put("entries", entries))
    }

    private fun unlink(path: String): String {
        val file = resolve(path)
        if (!exists(file)) return fail("ENOENT", path, "no such file")
        if (file.isDirectory) return fail("EISDIR", path, "是目录，请用 rmdir")
        if (!file.delete()) return fail("EACCES", path, "删除失败")
        return ok(JSONObject())
    }

    private fun rmdir(path: String): String {
        val file = resolve(path)
        if (!exists(file)) return fail("ENOENT", path, "no such directory")
        if (!file.isDirectory) return fail("ENOTDIR", path, "不是目录")
        if ((file.list()?.size ?: 0) > 0) return fail("ENOTEMPTY", path, "目录非空")
        if (!file.delete()) return fail("EACCES", path, "删除失败")
        return ok(JSONObject())
    }

    private fun rm(req: JSONObject): String {
        val path = req.getString("path")
        val file = resolve(path)
        if (!exists(file)) {
            return if (req.optBoolean("force")) ok(JSONObject()) else fail("ENOENT", path, "no such file")
        }
        if (!file.isDirectory) {
            if (!file.delete()) return fail("EACCES", path, "删除失败")
            return ok(JSONObject())
        }
        val children = file.listFiles() ?: return fail("EACCES", path, "无法列出目录")
        if (children.isNotEmpty() && !req.optBoolean("recursive")) return fail("ENOTEMPTY", path, "目录非空")
        for (child in children) {
            val nested = removeTree(child)
            if (nested != null) return fail(nested.first, path, nested.second)
        }
        if (!file.delete()) return fail("EACCES", path, "删除失败")
        return ok(JSONObject())
    }

    /** 递归删除：返回 null 表示成功，否则是 (错误码, 说明)。 */
    private fun removeTree(file: File): Pair<String, String>? {
        if (file.isDirectory && !Files.isSymbolicLink(file.toPath())) {
            val children = file.listFiles() ?: return "EACCES" to "无法列出目录 ${file.name}"
            for (child in children) removeTree(child)?.let { return it }
        }
        return if (file.delete()) null else "EACCES" to "删除失败 ${file.absolutePath}"
    }

    private fun symlink(target: String, path: String): String {
        val link = resolve(path)
        if (exists(link)) return fail("EEXIST", path, "已存在")
        link.parentFile?.mkdirs()
        // 目标是虚拟路径时映射回真实路径；相对目标相对链接所在目录解释。
        val realTarget = if (target.startsWith("/")) resolve(target).absolutePath
        else File(link.parentFile, target).absolutePath
        Files.createSymbolicLink(link.toPath(), java.nio.file.Paths.get(realTarget))
        return ok(JSONObject().put("path", virtual(link)))
    }

    // ---- 路径映射 ----

    /** 与 ExecBridge 同一个根：Bash 的工具和文件工具必须看到同一棵树。 */
    private fun root(): File = ZcodePaths.workspaceRoot(context)

    /**
     * 外部存储根（0.7.3"全部文件管理权限"）：只有 MANAGE_EXTERNAL_STORAGE 已授予时
     * /ext/<相对路径> 这一支才存在；没授予时 resolve 抛"未授予"（上层回 EACCES），
     * 行为与旧版一致——**声明权限 ≠ 拥有权限**，这里就是那道"没批就不能碰"的闸。
     * 只映射公共目录树（getExternalStorageDirectory = /sdcard，含 Download/DCIM/Documents），
     * Android/data 等其它 app 的私有区即便该权限也够不着（系统层限制，不是这里设的）。
     */
    private fun externalRootIfGranted(): File? {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return null
        if (!Environment.isExternalStorageManager()) return null
        val dir = Environment.getExternalStorageDirectory()
        return if (dir.isDirectory && dir.canRead()) dir else null
    }

    /** 用户点名的"直接操作本地文件"（0.7.4）：外部存储树判定，供正向解析与反向映射共用。
     *  0.7.9：规则收进 ZcodePaths.isExternalStorageSpelling —— ExecBridge 的 cwd 映射必须与这里
     *  同一条判据，否则"文件工具在 /sdcard/… 读写、Bash 却 cd 进私有盘假目录"两侧各说各话。 */
    private fun isExternalSpelling(path: String): Boolean =
        ZcodePaths.isExternalStorageSpelling(path)

    /**
     * 虚拟绝对路径 → 真实 File。`..` 直接拒绝（JS 侧 norm 已经折过一遍，这里是第二道闸），
     * 拼完再用 canonicalPath 复核一次，防止符号链接把路径带出根目录。
     * /ext 前缀（0.7.3）在逐级检查外同样复核——两棵树各有各的围栏，别把它们混成一条根。
     * **0.7.4 直通真实路径**：授予"所有文件访问"后，`/sdcard/…`、`/storage/…` 就是它自己
     * （不再是私有树里的镜像）——用户点名"别搞虚拟磁盘映射这一套，我要直接改本地文件、
     * 要能找到下载文件夹"。未授予时抛带引导的 EACCES；`/work` 等其余前缀维持私有映射不变。
     */
    private fun resolve(path: String): File {
        val cleaned = path.replace('\\', '/')
        require(cleaned.startsWith("/") || cleaned.isEmpty()) { "必须是 vfs 内的绝对路径: $path" }
        val parts = cleaned.split("/").filter { it.isNotEmpty() && it != "." }
        require(parts.none { it == ".." }) { "路径越出 vfs 根: $path" }
        if (parts.firstOrNull() == "ext") {
            val ext = externalRootIfGranted()
                ?: throw SecurityException("未授予\"所有文件访问\"权限，/ext 不可用（去设置页授权后重试）")
            val extBase = ext.canonicalPath
            var file = ext
            for (seg in parts.drop(1)) {
                file = File(file, seg)
                val canonical = runCatching { file.canonicalPath }.getOrDefault(file.absolutePath)
                require(canonical == extBase || canonical.startsWith(extBase + File.separator)) { "路径越出 /ext 根: $path" }
            }
            return file
        }
        // 直通支：外部存储的真实拼写（/sdcard、/storage）在授予后原样落盘。
        if (isExternalSpelling(cleaned)) {
            externalRootIfGranted()
                ?: throw SecurityException(
                    "未授予\"所有文件访问\"权限，无法直接读写 $path（应用内 设置 → 全部文件管理权限 → 去系统授权，或首次启动的弹窗）",
                )
            val direct = File(cleaned)
            val canonical = runCatching { direct.canonicalPath }.getOrDefault(direct.absolutePath)
            // 链接逃逸只针对私有树；外部树本身就允许跨目录，但仍拒绝把 .. 玩回根外的畸形目标。
            require(!canonical.contains("/../")) { "路径异常: $path" }
            return direct
        }
        val base = root().canonicalPath
        var file = root()
        for (seg in parts) {
            file = File(file, seg)
            // 逐级检查，避免 root/a(->../../)b 这种链接逃逸。
            val canonical = runCatching { file.canonicalPath }.getOrDefault(file.absolutePath)
            require(canonical == base || canonical.startsWith(base + File.separator)) { "路径越出 vfs 根: $path" }
        }
        return file
    }

    /** 真实 File → 虚拟路径；落在根外就原样返回绝对路径（断链的 symlink 目标会走到这支）。 */
    private fun virtual(file: File): String {
        val base = root().absolutePath
        val absolute = file.absolutePath
        if (absolute == base) return "/"
        if (absolute.startsWith(base + "/")) return "/" + absolute.removePrefix(base + "/")
        // 外部树的真实路径反演成 /sdcard 拼写（/storage/emulated/0/… → /sdcard/…），
        // 让 readdir/stat 回来的路径与模型写进去的一致——不然它下一步按返回路径再读又"找不到"。
        externalRootIfGranted()?.let { ext ->
            val extBase = ext.absolutePath
            if (absolute == extBase) return "/sdcard"
            if (absolute.startsWith(extBase + "/")) return "/sdcard/" + absolute.removePrefix(extBase + "/")
        }
        return absolute
    }

    /** readlink 的返回值可能指向根外的真实路径，先按链接所在目录还原成虚拟相对路径。 */
    private fun virtualOfReal(target: String, linkParent: File?): String {
        val base = root().absolutePath
        if (target.startsWith(base)) return virtual(File(target))
        if (linkParent != null) {
            val relative = runCatching {
                java.nio.file.Paths.get(linkParent.canonicalPath).relativize(java.nio.file.Paths.get(File(linkParent, target).canonicalPath)).toString()
            }.getOrDefault("")
            if (relative.isNotEmpty() && !relative.startsWith("..")) return relative
        }
        return target
    }

    private fun exists(file: File): Boolean =
        file.exists() || Files.isSymbolicLink(file.toPath())

    private fun codeOf(e: Exception): String = when {
        e is FileNotFoundException -> "ENOENT"
        // 越根/未授权（require、SecurityException）是"围栏拒了"，不是 IO 坏了——
        // 回 EACCES 让端上如实显示"未授予所有文件访问/越界"，而不是一个含糊的 EIO。
        e is SecurityException -> "EACCES"
        e.javaClass.name.contains("DirectoryNotEmpty") -> "ENOTEMPTY"
        e.javaClass.name.contains("AccessDenied") || e.message?.contains("read-only") == true -> "EACCES"
        e.javaClass.name.contains("IllegalArgument") -> "EACCES"
        else -> "EIO"
    }

    private fun ok(payload: JSONObject): String = payload.put("ok", true).toString()

    private fun fail(code: String, path: String, message: String?): String =
        JSONObject().put("ok", false).put("code", code).put("path", path).put("message", message ?: "").toString()
}
