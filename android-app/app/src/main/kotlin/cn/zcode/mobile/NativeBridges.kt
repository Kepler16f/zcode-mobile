package cn.zcode.mobile

import android.content.Context

/**
 * 进程级的原生通道持有者。
 *
 * 为什么不能挂在 Activity 上：Activity 被重建时（系统回收后重建、渲染进程被回收后的自愈重建），
 * onDestroy 会把正在跑的命令与模型请求 cancelAll 掉——用户看到的���"一锁屏/切后台，工作流就被掐断"。
 * 这些任务本身跑在**应用进程**里，与哪个 Activity 无关；挂在进程上，重建后的 Activity 拿到的
 * 还是同一个桥，能接着轮询同一批任务。
 *
 * 任务本身有存活上限（AsyncBridgeJobs 的保留期），进程真正退出时线程一并结束，不需要在这里取消。
 */
internal object NativeBridges {
    @Volatile private var execBridge: ExecBridge? = null
    @Volatile private var gitHttpBridge: GitHttpBridge? = null
    @Volatile private var modelHttpBridge: ModelHttpBridge? = null

    fun exec(context: Context): ExecBridge = execBridge ?: synchronized(this) {
        execBridge ?: ExecBridge(context.applicationContext).also { execBridge = it }
    }

    fun gitHttp(): GitHttpBridge = gitHttpBridge ?: synchronized(this) {
        gitHttpBridge ?: GitHttpBridge().also { gitHttpBridge = it }
    }

    fun modelHttp(): ModelHttpBridge = modelHttpBridge ?: synchronized(this) {
        modelHttpBridge ?: ModelHttpBridge().also { modelHttpBridge = it }
    }
}
