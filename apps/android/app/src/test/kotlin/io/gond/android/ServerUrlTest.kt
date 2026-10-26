package io.gond.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Mirrors the tests in apps/desktop/src-tauri/server-url, so both apps read an address the same way. */
class ServerUrlTest {
    @Test
    fun `an address with a scheme is tried as given, without its path`() {
        assertEquals(listOf("https://gond.example.com"), ServerUrl.candidates("https://gond.example.com/app/t/123"))
        assertEquals(listOf("http://192.168.1.20:3000"), ServerUrl.candidates("http://192.168.1.20:3000/"))
    }

    @Test
    fun `a public host without a scheme tries https first`() {
        assertEquals(listOf("https://gond.example.com", "http://gond.example.com"), ServerUrl.candidates("gond.example.com"))
    }

    @Test
    fun `this machine and private networks try http first`() {
        assertEquals(listOf("http://localhost:3000", "https://localhost:3000"), ServerUrl.candidates("localhost:3000"))
        assertEquals(listOf("http://192.168.1.20:3000", "https://192.168.1.20:3000"), ServerUrl.candidates("192.168.1.20:3000"))
        assertEquals(listOf("http://gond.local", "https://gond.local"), ServerUrl.candidates("gond.local"))
        assertEquals(listOf("http://nas", "https://nas"), ServerUrl.candidates("nas"))
    }

    @Test
    fun `default ports are dropped and others kept`() {
        assertEquals(listOf("http://gond.example.com"), ServerUrl.candidates("http://gond.example.com:80"))
        assertEquals(listOf("https://gond.example.com:8443"), ServerUrl.candidates("https://gond.example.com:8443"))
    }

    @Test
    fun `bad input names its reason`() {
        assertEquals(ServerUrl.Reason.EMPTY, reason("  "))
        assertEquals(ServerUrl.Reason.SCHEME, reason("ftp://gond.example.com"))
        assertEquals(ServerUrl.Reason.CREDENTIALS, reason("https://me:secret@gond.example.com"))
        assertEquals(ServerUrl.Reason.INVALID, reason("http://"))
    }

    @Test
    fun `sameOrigin compares scheme, host and port`() {
        assertTrue(ServerUrl.sameOrigin("https://gond.example.com/app", "https://gond.example.com"))
        assertTrue(ServerUrl.sameOrigin("https://GOND.example.com:443/x", "https://gond.example.com"))
        assertFalse(ServerUrl.sameOrigin("http://gond.example.com/app", "https://gond.example.com"))
        assertFalse(ServerUrl.sameOrigin("https://gond.example.com:8443/", "https://gond.example.com"))
        assertFalse(ServerUrl.sameOrigin("not a url", "https://gond.example.com"))
        assertFalse(ServerUrl.sameOrigin(null, "https://gond.example.com"))
    }

    private fun reason(input: String): ServerUrl.Reason = try {
        ServerUrl.candidates(input)
        error("expected $input to be rejected")
    } catch (failure: ServerUrl.Invalid) {
        failure.reason
    }
}
