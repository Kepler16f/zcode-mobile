package cn.zcode.mobile

import android.Manifest
import android.app.Activity
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.IBinder
import android.webkit.JavascriptInterface
import androidx.core.app.ActivityCompat
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import org.json.JSONObject

/**
 * 通知面（0.11.1，用户点名"有了通知权限以后给出通知保活，遇到出错误也发通知提醒"）。
 *
 * 挂名 "zcodeNotify"，四个方法与 JS 侧（mobile-runtime/ui/app-notify.ts）逐字对齐：
 *   requestPermission(): String                  → {"ok":true,"granted":true|false}
 *   hasPermission(): Boolean
 *   notify(id, title, text, ongoing): String     → {"ok":true}
 *   setKeepAlive(enabled): String                → {"ok":true}
 *
 * 纪律：
 *  - 权限请求**只由调用方显式触发**（JS 侧设置页），本桥自己不弹框；
 *  - 12 以下（Android 12 及更早）通知权限是安装期给的，直接视为已授权；
 *  - 13+ 的运行时权限走 ActivityCompat.requestPermissions，结果由 MainActivity
 *    的 onRequestPermissionsResult 转回来（见 handlePermissionResult）。
 */
class NotificationBridge(
    private val context: Context,
    private val activityProvider: () -> Activity?,
) {

    /**
     * 请求通知权限。
     * 返回 {"ok":true,"granted":true|false}。
     *
     * 已经授权 → granted:true。13+ 未授权 → 弹系统框，此刻 granted:false
     * （真正的结果稍后由 handlePermissionResult 收到；JS 侧在设置页里再读一次即可）。
     */
    @JavascriptInterface
    fun requestPermission(): String {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            return JSONObject().put("ok", true).put("granted", true).toString()
        }
        if (hasPermission()) {
            return JSONObject().put("ok", true).put("granted", true).toString()
        }
        val activity = activityProvider()
            ?: return JSONObject().put("ok", true).put("granted", false).toString()
        return try {
            ActivityCompat.requestPermissions(
                activity,
                arrayOf(Manifest.permission.POST_NOTIFICATIONS),
                REQUEST_CODE_NOTIFICATIONS,
            )
            JSONObject().put("ok", true).put("granted", false).toString()
        } catch (e: Exception) {
            JSONObject()
                .put("ok", false)
                .put("granted", false)
                .put("error", "${e.javaClass.simpleName}: ${e.message}")
                .toString()
        }
    }

    /** 通知权限是否已授予（12 以下恒为 true）。 */
    @JavascriptInterface
    fun hasPermission(): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return true
        return ContextCompat.checkSelfPermission(
            context,
            Manifest.permission.POST_NOTIFICATIONS,
        ) == PackageManager.PERMISSION_GRANTED
    }

    /**
     * 发一条通知。
     * 返回 {"ok":true} / {"ok":false,"error":"..."}。
     *
     * id 是字符串（JS 侧用语义化 id，如 "zcode-turn-error"），这里取它的 hash 当系统通知 id：
     * 同一条 id 反复调用是**更新**同一条通知，不刷屏。
     * ongoing=true 的通知用户划不掉（常驻通知走这条路）。
     */
    @JavascriptInterface
    fun notify(id: String, title: String, text: String, ongoing: Boolean): String {
        return try {
            NotifyChannels.ensure(context)
            val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            val notification = NotificationCompat.Builder(context, NotifyChannels.ALERTS)
                .setSmallIcon(android.R.drawable.stat_notify_more)
                .setContentTitle(title)
                .setContentText(text)
                .setStyle(NotificationCompat.BigTextStyle().bigText(text))
                .setOngoing(ongoing)
                .setAutoCancel(!ongoing)
                .setOnlyAlertOnce(true)
                .setContentIntent(mainActivityPendingIntent(context))
                .build()
            manager.notify(notifyIdOf(id), notification)
            JSONObject().put("ok", true).toString()
        } catch (e: Exception) {
            JSONObject().put("ok", false).put("error", "${e.javaClass.simpleName}: ${e.message}").toString()
        }
    }

    /**
     * 常驻通知开关。
     *
     * 开：起前台服务 KeepAliveService（渠道 zcode_keepalive，IMPORTANCE_MIN，ongoing，用户划不掉）。
     * 关：停服务并收掉那条通知。
     * 返回 {"ok":true} / {"ok":false,"error":"..."}。
     */
    @JavascriptInterface
    fun setKeepAlive(enabled: Boolean): String {
        return try {
            NotifyChannels.ensure(context)
            if (enabled) {
                context.startForegroundService(Intent(context, KeepAliveService::class.java))
            } else {
                context.stopService(Intent(context, KeepAliveService::class.java))
                val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
                manager.cancel(KEEPALIVE_NOTIFY_ID)
            }
            JSONObject().put("ok", true).toString()
        } catch (e: Exception) {
            JSONObject().put("ok", false).put("error", "${e.javaClass.simpleName}: ${e.message}").toString()
        }
    }

    /**
     * MainActivity.onRequestPermissionsResult 的转发口。
     * 返回 true 表示"这一条是我发的请求"，调用方就不用再往下传。
     */
    fun handlePermissionResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray,
    ): Boolean {
        if (requestCode != REQUEST_CODE_NOTIFICATIONS) return false
        lastPermissionGranted = grantResults.isNotEmpty() &&
            grantResults[0] == PackageManager.PERMISSION_GRANTED
        return true
    }

    /** 最近一次权限请求的结果（供 UI 在回到前台时读一眼）。 */
    @Volatile
    var lastPermissionGranted: Boolean = false
        private set

    companion object {
        /** 请求 POST_NOTIFICATIONS 用的 requestCode。 */
        const val REQUEST_CODE_NOTIFICATIONS = 0x5A7E

        /** 常驻通知的系统通知 id。 */
        const val KEEPALIVE_NOTIFY_ID = 0x5A7F

        /** 字符串 id → 系统通知 id（正数，同一 id 落同一条通知）。 */
        fun notifyIdOf(id: String): Int = id.hashCode() and 0x7fffffff

        /** 点通知回主界面。 */
        fun mainActivityPendingIntent(context: Context): PendingIntent {
            val intent = Intent(context, MainActivity::class.java).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
            }
            return PendingIntent.getActivity(
                context.applicationContext,
                0,
                intent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
        }
    }
}

/**
 * 通知渠道。渠道只能建一次，且**建完不能改重要度**（系统会忽略后来的改动），
 * 所以这里按需创建、已存在就跳过。
 */
internal object NotifyChannels {
    /** 应用提醒（出错提醒等）。 */
    const val ALERTS = "zcode_alerts"

    /** 常驻通知（保活）。 */
    const val KEEPALIVE = "zcode_keepalive"

    /** 应用更新（下载进度、可安装）。 */
    const val UPDATE = "zcode_update"

    fun ensure(context: Context) {
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager ?: return
        if (manager.getNotificationChannel(ALERTS) == null) {
            manager.createNotificationChannel(
                NotificationChannel(ALERTS, "应用提醒", NotificationManager.IMPORTANCE_DEFAULT),
            )
        }
        if (manager.getNotificationChannel(KEEPALIVE) == null) {
            manager.createNotificationChannel(
                NotificationChannel(KEEPALIVE, "常驻通知", NotificationManager.IMPORTANCE_MIN),
            )
        }
        if (manager.getNotificationChannel(UPDATE) == null) {
            manager.createNotificationChannel(
                NotificationChannel(UPDATE, "应用更新", NotificationManager.IMPORTANCE_LOW),
            )
        }
    }
}

/**
 * 常驻通知的前台服务（"通知保活"）。
 *
 * 为什么必须是前台服务：一条 ongoing 通知背后若没有前台服务，系统会在几分钟内
 * 把它收掉（后台进程随时可被回收），"常驻"就成了空话。
 * 前台服务类型用 dataSync（targetSdk 34 的要求，清单里已声明
 * FOREGROUND_SERVICE_DATA_SYNC 与 foregroundServiceType="dataSync"）。
 */
class KeepAliveService : Service() {

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        NotifyChannels.ensure(this)
        startForeground(NotificationBridge.KEEPALIVE_NOTIFY_ID, buildNotification())
        // START_STICKY：进程被回收后系统会把它拉回来（"保活"要的就是这个）。
        return START_STICKY
    }

    private fun buildNotification(): Notification {
        val builder = NotificationCompat.Builder(this, NotifyChannels.KEEPALIVE)
            .setSmallIcon(android.R.drawable.stat_notify_more)
            .setContentTitle("aZCode 正在运行")
            .setContentText("常驻通知已开启，点此回到应用")
            .setOngoing(true)
            .setAutoCancel(false)
            .setShowWhen(false)
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .setContentIntent(NotificationBridge.mainActivityPendingIntent(this))
        return builder.build()
    }
}
