package io.gond.android

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import java.time.Instant

/*
 * A call with a bot, kept going while the app is in the background. Android
 * hands a backgrounded app silence for a microphone and freezes it soon after,
 * which hung up the call; a microphone service is how a call app stays live.
 * It has to start while the app is in front with the microphone granted, so
 * the page starts it once its microphone runs (`setCall` on the bridge).
 */
class CallService : Service() {
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_END) {
            // The page hangs up, then ends this through the bridge; with no page, nothing is left to end.
            if (!MainActivity.endCall()) stopSelf()
            return START_NOT_STICKY
        }
        val bot = intent?.getStringExtra(EXTRA_BOT).orEmpty()
        val since = intent?.getStringExtra(EXTRA_SINCE)?.let { runCatching { Instant.parse(it).toEpochMilli() }.getOrNull() } ?: System.currentTimeMillis()
        val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE else 0
        try {
            ServiceCompat.startForeground(this, NOTIFICATION_ID, notice(bot, since), type)
        } catch (_: RuntimeException) {
            // Refused (the microphone taken back, or the app no longer in front): the call goes on as before, until Android stops it.
            stopSelf()
        }
        return START_NOT_STICKY
    }

    private fun notice(bot: String, since: Long): android.app.Notification {
        val manager = getSystemService(NotificationManager::class.java)
        val channel = NotificationChannel(CHANNEL, getString(R.string.call_channel), NotificationManager.IMPORTANCE_LOW)
        channel.description = getString(R.string.call_channel_description)
        channel.setShowBadge(false)
        manager?.createNotificationChannel(channel)
        val open = Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        val back = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val end = PendingIntent.getService(this, 1, Intent(this, CallService::class.java).setAction(ACTION_END), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        return NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(getString(R.string.call_title, bot))
            .setContentText(getString(R.string.call_text))
            .setColor(ContextCompat.getColor(this, R.color.primary))
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setWhen(since)
            .setShowWhen(true)
            .setUsesChronometer(true)
            .setContentIntent(back)
            .addAction(0, getString(R.string.call_end), end)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .build()
    }

    companion object {
        private const val CHANNEL = "calls"
        private const val NOTIFICATION_ID = 7001
        private const val ACTION_END = "io.gond.android.END_CALL"
        private const val EXTRA_BOT = "bot"
        private const val EXTRA_SINCE = "since"

        /** A call is on with `bot` since `startedAt` (ISO), or, with no bot, it's over. */
        fun set(context: Context, bot: String, startedAt: String) {
            val intent = Intent(context, CallService::class.java)
            if (bot.isBlank()) {
                context.stopService(intent)
                return
            }
            // Without the microphone Android refuses the service, and one that never comes up crashes the app.
            if (ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) return
            intent.putExtra(EXTRA_BOT, bot).putExtra(EXTRA_SINCE, startedAt)
            try {
                ContextCompat.startForegroundService(context, intent)
            } catch (_: IllegalStateException) {
                // Not allowed from the background; the page asks only while it is in front.
            }
        }
    }
}
