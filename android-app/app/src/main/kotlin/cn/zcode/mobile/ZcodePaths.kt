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
}
