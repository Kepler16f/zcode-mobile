package cn.zcode.mobile

import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.IBinder
import androidx.core.app.NotificationCompat
import java.io.File

/**
 * 后台下载 APK 的前台服务（0.11.1）。
 *
 * 为什么必须是前台服务：应用退到后台以后进程随时可能被回收，下载会半途断掉；
 * 前台服务 + 通知栏进度条是系统明确给"用户可见的长任务"留的路。顺带白送一条能力：
 * 用户在别的界面也能看到"正在下载"，点一下通知就能装。
 *
 * 前台服务类型 dataSync（targetSdk 34 的硬要求）：
 *   - 清单里 <service android:foregroundServiceType="dataSync">；
 *   - 清单里声明 FOREGROUND_SERVICE 与 FOREGROUND_SERVICE_DATA_SYNC 两个权限。
 *
 * 生命周期：
 *   onStartCommand → 立刻 startForeground（系统要求 5 秒内）→ 后台线程下载 →
 *   进度刷新通知 → 成功发"可安装"通知（点它直接进安装器）/ 失败发"下载失败"通知 → stopSelf。
 *   onDestroy → 还没下完就把 job 取消掉（别让线程在服务没了之后还在写文件）。
 */
class UpdateDownloadService : Service() {

    private var worker: Thread? = null

    /** 当前正在跑的那一单（服务被停时用它取消下载）。 */
    private var currentJob: UpdateJob? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        NotifyChannels.ensure(this)
        val jobId = intent?.getStringExtra(EXTRA_JOB_ID).orEmpty()
        val url = intent?.getStringExtra(EXTRA_URL).orEmpty()
        if (jobId.isEmpty() || url.isEmpty()) {
            stopSelf(startId)
            return START_NOT_STICKY
        }
        // 桥那边已经建好 job（这样 jobId 能立刻回给 JS）；进程被杀后重来才自己补一个。
        val job = UpdateJobs.find(jobId) ?: UpdateJobs.create(jobId, url)
        currentJob = job

        // 同一单已经在跑就别再起一条线程（重复 startService 会重发 onStartCommand）。
        if (worker != null && worker!!.isAlive) return START_NOT_STICKY

        startForeground(NOTIFY_ID, buildProgressNotification(job))

        val thread = Thread({
            runUpdateDownload(this, job) { downloaded, total -> refreshProgress(job, downloaded, total) }
            worker = null
            if (job.state == UpdateJob.STATE_DONE) {
                postReadyNotification(job)
            } else {
                postFailedNotification(job)
            }
            stopSelf(startId)
        }, "zcode-update-svc")
        thread.isDaemon = true
        worker = thread
        thread.start()
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        // 服务没了（被停/被系统收）→ 正在跑的那一单也停掉，别留个孤儿线程写文件。
        val job = currentJob
        if (job != null && job.state == UpdateJob.STATE_RUNNING) {
            job.cancelled.set(true)
            job.state = UpdateJob.STATE_FAILED
            job.error = "下载被中断"
        }
        worker = null
        super.onDestroy()
    }

    /** 进度通知：百分比 + 已下载/总量。 */
    private fun buildProgressNotification(job: UpdateJob): Notification {
        val builder = NotificationCompat.Builder(this, NotifyChannels.UPDATE)
            .setSmallIcon(android.R.drawable.stat_sys_download)
            .setContentTitle("正在下载更新")
            .setContentText(progressText(job.downloaded, job.total))
            .setOngoing(true)
            .setAutoCancel(false)
            .setOnlyAlertOnce(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setContentIntent(NotificationBridge.mainActivityPendingIntent(this))
        val total = job.total
        if (total > 0) {
            val percent = ((job.downloaded * 100) / total).toInt().coerceIn(0, 100)
            builder.setProgress(100, percent, false)
        } else {
            builder.setProgress(0, 0, true)
        }
        return builder.build()
    }

    /** 下载过程中刷新进度（限流由 runUpdateDownload 负责，这里只负责写通知）。 */
    private fun refreshProgress(job: UpdateJob, downloaded: Long, total: Long) {
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        runCatching { manager.notify(NOTIFY_ID, buildProgressNotification(job)) }
    }

    /** 下完了：通知点一下直接进安装器。 */
    private fun postReadyNotification(job: UpdateJob) {
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        val file = File(job.filePath)
        val install = installPendingIntent(file)
        val builder = NotificationCompat.Builder(this, NotifyChannels.UPDATE)
            .setSmallIcon(android.R.drawable.stat_sys_upload_done)
            .setContentTitle("更新已下载")
            .setContentText("点击安装 aZCode 新版本")
            .setAutoCancel(true)
            .setOnlyAlertOnce(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setContentIntent(install)
        runCatching {
            // 通知留在通知栏里（detach），停服务时不要把它一起收掉。
            @Suppress("DEPRECATION")
            stopForeground(STOP_FOREGROUND_DETACH)
            manager.notify(NOTIFY_ID, builder.build())
        }
    }

    /** 失败了：如实说失败，别留一条"正在下载"的假进度。 */
    private fun postFailedNotification(job: UpdateJob) {
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        val builder = NotificationCompat.Builder(this, NotifyChannels.UPDATE)
            .setSmallIcon(android.R.drawable.stat_notify_error)
            .setContentTitle("更新下载失败")
            .setContentText(job.error.ifEmpty { "未知错误" })
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setContentIntent(NotificationBridge.mainActivityPendingIntent(this))
        runCatching {
            @Suppress("DEPRECATION")
            stopForeground(STOP_FOREGROUND_DETACH)
            manager.notify(NOTIFY_ID, builder.build())
        }
    }

    /**
     * 点通知装 APK。
     *
     * 没拿到"允许此来源安装应用"授权时（Android 8+），点通知改为拉起那个系统设置页——
     * 直接弹安装器会被系统拦下（"For your security, your phone is not allowed to install
     * unknown apps"），用户会以为应用坏了。
     */
    private fun installPendingIntent(file: File): PendingIntent {
        val canInstall = packageManager.canRequestPackageInstalls()
        val intent = if (canInstall && file.isFile) {
            UpdateBridge.buildInstallIntent(this, file)
        } else {
            Intent(
                android.provider.Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                Uri.parse("package:" + packageName),
            ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        return PendingIntent.getActivity(
            this,
            REQUEST_INSTALL,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    /** "12.3 MB / 45.0 MB" 这样的一行进度。 */
    private fun progressText(downloaded: Long, total: Long): String {
        val done = formatBytes(downloaded)
        return if (total > 0) "$done / ${formatBytes(total)}" else "$done / 未知大小"
    }

    private fun formatBytes(bytes: Long): String {
        if (bytes <= 0) return "0 B"
        val mb = bytes / 1024.0 / 1024.0
        return if (mb >= 1.0) String.format("%.1f MB", mb) else String.format("%.0f KB", bytes / 1024.0)
    }

    companion object {
        /** startService 的 action（区分"起下载"）。 */
        const val ACTION_DOWNLOAD = "cn.zcode.mobile.action.DOWNLOAD_UPDATE"

        /** 目标 jobId（Extra）。 */
        const val EXTRA_JOB_ID = "jobId"

        /** 下载直链（Extra）。 */
        const val EXTRA_URL = "url"

        /** 下载进度那条通知的系统 id。 */
        const val NOTIFY_ID = 0x5A80

        /** 安装 PendingIntent 的 requestCode。 */
        const val REQUEST_INSTALL = 0x5A81
    }
}
