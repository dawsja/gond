package io.gond.android

import android.content.Context
import com.google.firebase.FirebaseApp
import com.google.firebase.messaging.FirebaseMessaging
import org.json.JSONException
import org.json.JSONObject

/*
 * This phone's push: its Firebase token, and the id and keys the person's Gond
 * gave it when the web app signed it up (`setPushDevice` on the bridge). A
 * build without google-services.json, or a phone without Google Play services,
 * never gets a token, and the web app keeps showing notices itself.
 */
object Push {
    fun refresh(context: Context, changed: () -> Unit) {
        if (FirebaseApp.getApps(context).isEmpty()) return
        try {
            FirebaseMessaging.getInstance().token.addOnSuccessListener { token ->
                if (token.isNullOrEmpty() || token == Prefs.pushToken(context)) return@addOnSuccessListener
                Prefs.setPushToken(context, token)
                changed()
            }
        } catch (_: Exception) {
            // No Firebase on this phone.
        }
    }

    /** What the web app reads to sign this phone up: `{ token, device }`, each null until there is one. */
    fun state(context: Context): String =
        JSONObject().put("token", Prefs.pushToken(context) ?: JSONObject.NULL).put("device", Prefs.pushDevice(context)?.id ?: JSONObject.NULL).toString()

    /** The server's answer to signing up (`{ id, seal, answer }`), or nothing to sign this phone out. */
    fun save(context: Context, json: String?) {
        if (json.isNullOrBlank()) return Prefs.setPushDevice(context, null)
        try {
            val o = JSONObject(json)
            Prefs.setPushDevice(context, Prefs.PushDevice(o.getString("id"), o.getString("seal"), o.getString("answer")))
        } catch (_: JSONException) {
            // Not what the server sends; keep what was there.
        }
    }
}
