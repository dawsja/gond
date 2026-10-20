package io.gond.android

import java.net.URI

/*
 * The same rules as the desktop app's server-url crate: Gond serves the web
 * app and /api from one origin, so the path is dropped; without a scheme,
 * https is tried first, except for this machine and private networks,
 * where a plain-http install is the norm.
 */
object ServerUrl {
    private val LOCAL_HOST = Regex(
        "^(localhost|127(\\.\\d{1,3}){3}|\\[::1]|10(\\.\\d{1,3}){3}|192\\.168(\\.\\d{1,3}){2}|172\\.(1[6-9]|2\\d|3[01])(\\.\\d{1,3}){2}|[^.]+\\.local|[^.]+)$",
        RegexOption.IGNORE_CASE,
    )
    private val HAS_SCHEME = Regex("^[a-z][a-z\\d+.-]*://", RegexOption.IGNORE_CASE)

    class Invalid(val reason: Reason) : IllegalArgumentException(reason.name)

    enum class Reason { EMPTY, INVALID, SCHEME, CREDENTIALS }

    fun candidates(input: String?): List<String> {
        val raw = input?.trim().orEmpty()
        if (raw.isEmpty()) throw Invalid(Reason.EMPTY)
        val urls = if (HAS_SCHEME.containsMatchIn(raw)) {
            listOf(raw)
        } else {
            val host = raw.split('/', ':', '?', '#').firstOrNull().orEmpty()
            if (LOCAL_HOST.matches(host)) listOf("http://$raw", "https://$raw") else listOf("https://$raw", "http://$raw")
        }
        return urls.map { value ->
            val uri = try {
                URI(value)
            } catch (_: Exception) {
                throw Invalid(Reason.INVALID)
            }
            val scheme = uri.scheme?.lowercase()
            if (scheme != "http" && scheme != "https") throw Invalid(Reason.SCHEME)
            if (uri.rawUserInfo != null) throw Invalid(Reason.CREDENTIALS)
            origin(uri) ?: throw Invalid(Reason.INVALID)
        }
    }

    fun origin(url: String): String? = try {
        origin(URI(url))
    } catch (_: Exception) {
        null
    }

    private fun origin(uri: URI): String? {
        val scheme = uri.scheme?.lowercase() ?: return null
        val host = uri.host?.lowercase() ?: return null
        val default = if (scheme == "https") 443 else 80
        val port = if (uri.port == -1 || uri.port == default) "" else ":${uri.port}"
        return "$scheme://$host$port"
    }

    fun sameOrigin(url: String?, origin: String?): Boolean {
        if (url == null || origin == null) return false
        return origin(url) == origin
    }
}
