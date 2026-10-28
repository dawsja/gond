package io.gond.android

import android.content.Context
import androidx.core.content.edit

object Prefs {
    private const val FILE = "gond"
    private const val SERVER = "server"
    private const val SIGN_IN_VERIFIER = "sign_in_verifier"
    private const val SIGN_IN_NEXT = "sign_in_next"
    private const val PUSH_TOKEN = "push_token"
    private const val PUSH_DEVICE = "push_device"

    fun server(context: Context): String? = context.getSharedPreferences(FILE, Context.MODE_PRIVATE).getString(SERVER, null)

    fun setServer(context: Context, origin: String) {
        val prefs = context.getSharedPreferences(FILE, Context.MODE_PRIVATE)
        // The push keys belong to the server the phone signed up with; another one signs it up afresh.
        val changed = prefs.getString(SERVER, null) != origin
        prefs.edit {
            putString(SERVER, origin)
            if (changed) remove(PUSH_DEVICE)
        }
    }

    fun pushToken(context: Context): String? = context.getSharedPreferences(FILE, Context.MODE_PRIVATE).getString(PUSH_TOKEN, null)

    fun setPushToken(context: Context, token: String) {
        context.getSharedPreferences(FILE, Context.MODE_PRIVATE).edit { putString(PUSH_TOKEN, token) }
    }

    /** This phone as the server knows it for push: its id and the two keys the server gave it. */
    data class PushDevice(val id: String, val seal: String, val answer: String)

    fun pushDevice(context: Context): PushDevice? {
        val wrapped = context.getSharedPreferences(FILE, Context.MODE_PRIVATE).getString(PUSH_DEVICE, null) ?: return null
        val json = Vault.unwrap(wrapped) ?: return null
        return try {
            val o = org.json.JSONObject(json)
            PushDevice(o.getString("id"), o.getString("seal"), o.getString("answer"))
        } catch (_: org.json.JSONException) {
            null
        }
    }

    fun setPushDevice(context: Context, device: PushDevice?) {
        val wrapped = device?.let { Vault.wrap(org.json.JSONObject().put("id", it.id).put("seal", it.seal).put("answer", it.answer).toString()) }
        context.getSharedPreferences(FILE, Context.MODE_PRIVATE).edit {
            if (wrapped == null) remove(PUSH_DEVICE) else putString(PUSH_DEVICE, wrapped)
        }
    }

    /** Kept here because the app may be stopped while the sign-in is in the browser. */
    fun setPendingSignIn(context: Context, verifier: String, next: String) {
        context.getSharedPreferences(FILE, Context.MODE_PRIVATE).edit { putString(SIGN_IN_VERIFIER, verifier).putString(SIGN_IN_NEXT, next) }
    }

    /** The pending sign-in, forgotten as it is read: a verifier is good for one try. */
    fun takePendingSignIn(context: Context): Pair<String, String>? {
        val prefs = context.getSharedPreferences(FILE, Context.MODE_PRIVATE)
        val verifier = prefs.getString(SIGN_IN_VERIFIER, null) ?: return null
        val next = prefs.getString(SIGN_IN_NEXT, null) ?: "/app"
        prefs.edit { remove(SIGN_IN_VERIFIER).remove(SIGN_IN_NEXT) }
        return verifier to next
    }
}
