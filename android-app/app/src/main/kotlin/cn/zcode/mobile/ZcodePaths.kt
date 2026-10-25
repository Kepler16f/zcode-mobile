package cn.zcode.mobile

import android.content.Context
import java.io.File

/**
 * 应用私有工作区的唯一入口。
 *
 * 之所以要单独拎出来：`zcodeFs`（文件工具）和 `zcodeExec`（Bash 工具）必须落在同一棵树上，
 * 否则 `Write` 写完文件、`Bash` 里 `ls` 看不到，端侧 Agent 的自洽性当场就破。
 * 两条桥各自算各的路径早晚会漂移，所以只允许这一处定义。
 *
 * 用 getDir(MODE_PRIVATE) 而不是外部存储：见 §7 R11（源码不出设备，也不需要任何存储权限）。
 */
object ZcodePaths {

    fun zcodeDir(context: Context): File = File(context.filesDir, "zcode")

    fun workspaceRoot(context: Context): File = File(zcodeDir(context), "workspace").apply { mkdirs() }

    fun databasesRoot(context: Context): File = File(zcodeDir(context), "databases").apply { mkdirs() }

    /**
     * 0.7.9：共享存储的真实拼写（工作区根 / cwd）判定，FsBridge 与 ExecBridge 共用一条规则。
     * 0.7.4 让文件工具直通 /sdcard、/storage（MANAGE_EXTERNAL_STORAGE 授予后就是它自己），但
     * ExecBridge.workspaceFile 一直把**一切** vfs 路径折进私有盘 —— 工作区根选成 /sdcard/… 时，
     * Bash 的 cwd 落到 workspaceRoot()/sdcard/…（不存在）→ 当场"工作目录不存在"，工具引擎整个
     * Bash 面瘫在入口。两处各自判各自的早晚会漂开（本文件的存在理由），所以规则只在这定义一次。
     *
     * 注意只认**真实拼写**，不认 /ext：/ext 是 0.7.3 的别名前缀，它对应的真路径在这里判不出来
     * （要 externalRootIfGranted），模型文档里已写明"优先真实路径"，/ext 工作区继续维持私有映射。
     */
    fun isExternalStorageSpelling(path: String): Boolean {
        val first = path.trimStart('/').substringBefore('/', "")
        return first == "sdcard" || first == "storage"
    }
}
