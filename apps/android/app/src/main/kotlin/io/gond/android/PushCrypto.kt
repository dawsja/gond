package io.gond.android

import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/*
 * The phone's half of `apps/api/src/phone-push.ts`: a notice comes sealed
 * with AES-256-GCM under the phone's own key (twelve bytes of IV, then the
 * ciphertext and its tag), and an answer to a card is signed with HMAC-SHA256
 * under its answer key. Both keys came from the server when the phone signed up.
 */
object PushCrypto {
    private fun bytes(base64url: String): ByteArray = Base64.getUrlDecoder().decode(base64url)

    /** The notice's JSON, or null when it wasn't sealed for this key. */
    fun open(key: String, sealed: String): String? = try {
        val raw = bytes(sealed)
        if (raw.size < 12 + 16) null
        else {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(bytes(key), "AES"), GCMParameterSpec(128, raw, 0, 12))
            String(cipher.doFinal(raw, 12, raw.size - 12), Charsets.UTF_8)
        }
    } catch (_: Exception) {
        null
    }

    fun sign(key: String, device: String, at: String, approvalId: String, decision: String): String {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(bytes(key), "HmacSHA256"))
        return mac.doFinal(listOf(device, at, approvalId, decision).joinToString("\n").toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
    }
}
