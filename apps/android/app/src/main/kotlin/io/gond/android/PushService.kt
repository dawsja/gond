package io.gond.android

import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import org.json.JSONException
import org.json.JSONObject

/*
 * Push from the person's Gond, through the relay and Firebase. Each notice is
 * sealed for this phone alone (`PushCrypto`), so neither of them can read it.
 */
class PushService : FirebaseMessagingService() {
    override fun onNewToken(token: String) {
        Prefs.setPushToken(this, token)
        MainActivity.pushChanged()
    }

    override fun onMessageReceived(message: RemoteMessage) {
        val sealed = message.data["d"] ?: return
        val device = Prefs.pushDevice(this) ?: return
        val notice = PushCrypto.open(device.seal, sealed)?.let { json ->
            try {
                JSONObject(json)
            } catch (_: JSONException) {
                null
            }
        } ?: return
        val withdraw = notice.optString("withdraw")
        if (withdraw.isNotEmpty()) return Notifications.cancel(this, withdraw)
        // Only a path on the person's own Gond opens; anything else opens the app.
        val url = notice.optString("url").takeIf { it.startsWith("/") && !it.startsWith("//") } ?: "/app"
        val card = notice.optJSONObject("card")?.let { Notifications.Card(it.optString("id"), it.optString("allow", "Allow"), it.optString("deny", "Deny")) }?.takeIf { it.id.isNotEmpty() }
        Notifications.show(this, notice.optString("title").ifBlank { getString(R.string.app_name) }, notice.optString("body"), url, notice.optString("tag").ifBlank { url }, card)
    }
}
