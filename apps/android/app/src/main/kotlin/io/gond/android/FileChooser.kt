package io.gond.android

import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/** Helpers for routing WebView file inputs to the camera and managing temporary photo files. */
object FileChooser {
    private const val MAX_CACHE_AGE_MS = 24L * 60 * 60 * 1000
    private val IMAGE_EXTENSIONS = setOf(".jpg", ".jpeg", ".png", ".webp", ".gif", ".heic", ".heif")

    // Whether a WebView file chooser asks to capture a photo with the camera
    // (for example, `<input type="file" accept="image/*" capture="environment">`).
    fun wantsCameraPhoto(captureEnabled: Boolean, acceptTypes: Array<String>?): Boolean {
        if (!captureEnabled) return false
        val types = acceptTypes
            ?.flatMap { it.split(',') }
            ?.map { it.trim().lowercase(Locale.US) }
            ?.filter { it.isNotEmpty() }
            .orEmpty()
        if (types.isEmpty()) return true
        return types.any { it == "*/*" || it.startsWith("image/") || it in IMAGE_EXTENSIONS }
    }

    /** A unique JPEG file inside `directory` for a newly captured camera photo. */
    fun photoFile(directory: File, now: Date = Date(), timeZone: TimeZone = TimeZone.getDefault()): File {
        val stamp = SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US).apply { this.timeZone = timeZone }.format(now)
        var candidate = File(directory, "Photo-$stamp.jpg")
        var suffix = 2
        while (candidate.exists()) {
            candidate = File(directory, "Photo-$stamp-$suffix.jpg")
            suffix += 1
        }
        return candidate
    }

    /** Removes temporary camera photos older than `maxAgeMillis`, leaving recent drafts intact. */
    fun pruneOldPhotos(directory: File, nowMillis: Long = System.currentTimeMillis(), maxAgeMillis: Long = MAX_CACHE_AGE_MS) {
        val cutoff = nowMillis - maxAgeMillis
        directory.listFiles()?.forEach { file ->
            if (file.isFile && file.lastModified() < cutoff) file.delete()
        }
    }
}
