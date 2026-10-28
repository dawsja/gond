package io.gond.android

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat

/*
 * Notices arrive as push (`PushService`) once the phone has signed up for it.
 * Until then, or on a phone without Google Play services, the web app asks
 * for one through the bridge on the API's `notify` live event instead.
 */
object Notifications {
    const val CHANNEL = "bots"
    const val EXTRA_URL = "io.gond.android.url"

    /** A card the notice can answer from the lock screen, its buttons named as on the card. */
    data class Card(val id: String, val allow: String, val deny: String)

    fun ensureChannel(context: Context) {
        val manager = context.getSystemService(NotificationManager::class.java) ?: return
        val channel = NotificationChannel(CHANNEL, context.getString(R.string.notifications_channel), NotificationManager.IMPORTANCE_HIGH)
        channel.description = context.getString(R.string.notifications_channel_description)
        manager.createNotificationChannel(channel)
    }

    /** "granted", "denied" or "prompt", as the web app's notifications card shows it. */
    fun state(context: Context): String {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) {
                return if (NotificationManagerCompat.from(context).areNotificationsEnabled()) "granted" else "denied"
            }
            return "prompt"
        }
        return if (NotificationManagerCompat.from(context).areNotificationsEnabled()) "granted" else "denied"
    }

    fun show(context: Context, title: String, body: String, url: String, tag: String, card: Card? = null) {
        if (state(context) != "granted") return
        val open = Intent(context, MainActivity::class.java).apply {
            action = Intent.ACTION_VIEW
            putExtra(EXTRA_URL, url)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        }
        val pending = PendingIntent.getActivity(context, tag.hashCode(), open, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val builder = NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setColor(ContextCompat.getColor(context, R.color.primary))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setAutoCancel(true)
            .setContentIntent(pending)
        if (card != null) {
            builder.addAction(answer(context, card, "allow", card.allow, tag, url))
            builder.addAction(answer(context, card, "deny", card.deny, tag, url))
        }
        val notification = builder.build()
        try {
            // One notification per conversation, the newest replacing the last.
            NotificationManagerCompat.from(context).notify(tag, 0, notification)
        } catch (_: SecurityException) {
            // Permission revoked between the check and the call.
        }
    }

    fun cancel(context: Context, tag: String) {
        NotificationManagerCompat.from(context).cancel(tag, 0)
    }

    // A yes from a locked phone would let anyone holding it approve, so the phone is unlocked first.
    private fun answer(context: Context, card: Card, decision: String, label: String, tag: String, url: String): NotificationCompat.Action {
        val intent = Intent(context, AnswerReceiver::class.java).apply {
            putExtra(AnswerReceiver.EXTRA_APPROVAL, card.id)
            putExtra(AnswerReceiver.EXTRA_DECISION, decision)
            putExtra(AnswerReceiver.EXTRA_TAG, tag)
            putExtra(EXTRA_URL, url)
        }
        val pending = PendingIntent.getBroadcast(context, "$tag/$decision".hashCode(), intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        return NotificationCompat.Action.Builder(0, label, pending).setAuthenticationRequired(true).build()
    }
}
