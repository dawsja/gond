package io.gond.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.util.Date
import java.util.TimeZone

class FileChooserTest {
    @Test
    fun `camera capture is used only when capture is enabled and images are accepted`() {
        assertTrue(FileChooser.wantsCameraPhoto(true, arrayOf("image/*")))
        assertTrue(FileChooser.wantsCameraPhoto(true, arrayOf("image/jpeg, image/png")))
        assertTrue(FileChooser.wantsCameraPhoto(true, arrayOf(".jpg")))
        assertTrue(FileChooser.wantsCameraPhoto(true, arrayOf("*/*")))
        assertTrue(FileChooser.wantsCameraPhoto(true, arrayOf("")))
        assertTrue(FileChooser.wantsCameraPhoto(true, null))

        assertFalse(FileChooser.wantsCameraPhoto(false, arrayOf("image/*")))
        assertFalse(FileChooser.wantsCameraPhoto(true, arrayOf("audio/*")))
        assertFalse(FileChooser.wantsCameraPhoto(true, arrayOf("video/*")))
        assertFalse(FileChooser.wantsCameraPhoto(true, arrayOf("application/pdf")))
    }

    @Test
    fun `photoFile names photos cleanly and avoids collisions in the same second`() {
        val dir = Files.createTempDirectory("gond-camera-test").toFile()
        try {
            val utc = TimeZone.getTimeZone("UTC")
            val at = Date(1_795_306_530_000L) // 2026-11-22 00:15:30 UTC
            val first = FileChooser.photoFile(dir, at, utc)
            assertEquals("Photo-20261122-001530.jpg", first.name)
            first.createNewFile()

            val second = FileChooser.photoFile(dir, at, utc)
            assertEquals("Photo-20261122-001530-2.jpg", second.name)
        } finally {
            dir.deleteRecursively()
        }
    }

    @Test
    fun `pruneOldPhotos deletes stale files and keeps recent ones`() {
        val dir = Files.createTempDirectory("gond-camera-prune").toFile()
        try {
            val now = 2_000_000_000_000L
            val stale = File(dir, "old.jpg").apply {
                createNewFile()
                setLastModified(now - 25L * 60 * 60 * 1000)
            }
            val fresh = File(dir, "new.jpg").apply {
                createNewFile()
                setLastModified(now - 60L * 1000)
            }
            FileChooser.pruneOldPhotos(dir, nowMillis = now)
            assertFalse(stale.exists())
            assertTrue(fresh.exists())
        } finally {
            dir.deleteRecursively()
        }
    }
}
