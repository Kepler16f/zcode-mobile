package cn.zcode.mobile

import org.json.JSONObject
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean

/** 原生任务是状态的唯一持有者，JS 只通过 ID 读取或取消；完成结果至多取走一次。 */
internal class AsyncBridgeJobs {
    internal class Job {
        val cancelled = AtomicBoolean(false)
        @Volatile var result: String? = null
        @Volatile var completedAt: Long = 0
        private var cancelAction: (() -> Unit)? = null

        @Synchronized fun onCancel(action: () -> Unit) {
            cancelAction = action
            if (cancelled.get()) runCancelAction(action)
        }

        @Synchronized fun cancel() {
            if (!cancelled.compareAndSet(false, true)) return
            cancelAction?.let(::runCancelAction)
        }

        private fun runCancelAction(action: () -> Unit) {
            // disconnect/销毁进程不能占住 WebView 的 JSInterface 线程。
            Thread { runCatching { action() } }.apply { isDaemon = true; start() }
        }
    }

    private val jobs = ConcurrentHashMap<String, Job>()

    @Synchronized fun start(operation: (Job) -> String): String {
        val now = System.currentTimeMillis()
        jobs.entries.removeAll { (_, job) -> job.completedAt != 0L && now - job.completedAt > RETENTION_MS }
        if (jobs.size >= MAX_JOBS) return JSONObject().put("error", "原生任务过多，请稍后重试").toString()
        val id = UUID.randomUUID().toString()
        val job = Job()
        jobs[id] = job
        Thread {
            job.result = try {
                operation(job)
            } catch (e: Exception) {
                JSONObject().put("error", "${e.javaClass.simpleName}: ${e.message}").toString()
            }
            job.completedAt = System.currentTimeMillis()
        }.apply { isDaemon = true; start() }
        return JSONObject().put("id", id).toString()
    }

    fun poll(id: String): String {
        val job = jobs[id] ?: return JSONObject().put("error", "原生任务不存在或已被读取").toString()
        val result = job.result ?: return JSONObject().put("done", false).toString()
        if (!jobs.remove(id, job)) return JSONObject().put("error", "原生任务结果已被读取").toString()
        return JSONObject().put("done", true).put("result", JSONObject(result)).toString()
    }

    fun cancel(id: String): Boolean {
        // 取消后调用方仍需等任务收口，才能安全回写文件；poll 取走结果时再移出表。
        val job = jobs[id] ?: return false
        job.cancel()
        return true
    }

    fun cancelAll() { jobs.values.forEach { it.cancel() } }

    private companion object {
        const val MAX_JOBS = 64
        const val RETENTION_MS = 10 * 60 * 1000L
    }
}
