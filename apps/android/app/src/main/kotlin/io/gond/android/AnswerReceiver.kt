package io.gond.android

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/*
 * Approve or Deny on a card's notification: the answer goes straight to the
 * person's Gond, signed with this phone's answer key, since there is no
 * session cookie outside the WebView. On a failure the notification says so
 * and opens the card in the app.
 */
class AnswerReceiver : BroadcastReceiver() {
    companion object {
        const val EXTRA_APPROVAL = "io.gond.android.approval"
        const val EXTRA_DECISION = "io.gond.android.decision"
        const val EXTRA_TAG = "io.gond.android.tag"
    }

    override fun onReceive(context: Context, intent: Intent) {
        val approval = intent.getStringExtra(EXTRA_APPROVAL) ?: return
        val decision = intent.getStringExtra(EXTRA_DECISION)?.takeIf { it == "allow" || it == "deny" } ?: return
        val tag = intent.getStringExtra(EXTRA_TAG) ?: return
        val url = intent.getStringExtra(Notifications.EXTRA_URL) ?: "/app"
        val pending = goAsync()
        Thread {
            try {
                val problem = send(context, approval, decision)
                if (problem == null) Notifications.cancel(context, tag)
                else Notifications.show(context, context.getString(R.string.answer_failed), problem, url, tag)
            } finally {
                pending.finish()
            }
        }.start()
    }

    /** Null when the card took the answer; otherwise what to tell the person. */
    private fun send(context: Context, approval: String, decision: String): String? {
        val server = Prefs.server(context) ?: return context.getString(R.string.answer_open)
        val device = Prefs.pushDevice(context) ?: return context.getString(R.string.answer_open)
        val at = System.currentTimeMillis().toString()
        return try {
            val connection = (URL("$server/api/push/answer").openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                connectTimeout = 15_000
                readTimeout = 15_000
                doOutput = true
                setRequestProperty("content-type", "application/json")
                setRequestProperty("x-gond-device", device.id)
                setRequestProperty("x-gond-time", at)
                setRequestProperty("x-gond-signature", PushCrypto.sign(device.answer, device.id, at, approval, decision))
            }
            connection.outputStream.use { it.write(JSONObject().put("approvalId", approval).put("decision", decision).toString().toByteArray(Charsets.UTF_8)) }
            val code = connection.responseCode
            if (code in 200..299) {
                connection.inputStream.close()
                return null
            }
            // The server's words are written for the person ("That card was already answered or ran out of time").
            val said = connection.errorStream?.bufferedReader()?.use { it.readText() }?.let { runCatching { JSONObject(it).optString("error") }.getOrNull() }
            said?.takeIf { it.isNotBlank() } ?: context.getString(R.string.answer_open)
        } catch (_: Exception) {
            context.getString(R.string.answer_offline)
        }
    }
}
