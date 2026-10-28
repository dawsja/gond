package io.gond.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

// The vector is made by the server's own sealNotice and answerSignature (apps/api/src/phone-push.ts).
class PushCryptoTest {
    private val key = "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc"
    private val sealed = "CQkJCQkJCQkJCQkJXKfytoTB7UPUC79Ug8iZ_YTfAJhRmtXsTcwpwqxWO1iXiommzHAGMgrByTR-Fsy1DCSx4D3g8X9HQyPjN3FYtE4L1z-rWzozbDDp9ALXxZX4YXvG8fI"

    @Test
    fun opensWhatTheServerSealed() {
        assertEquals("""{"v":1,"title":"Pocket","body":"Done.","url":"/app/t/t_1","tag":"t_1"}""", PushCrypto.open(key, sealed))
    }

    @Test
    fun refusesAnotherKeyOrATamperedNotice() {
        assertNull(PushCrypto.open("CAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAg", sealed))
        assertNull(PushCrypto.open(key, sealed.dropLast(4) + "AAAA"))
        assertNull(PushCrypto.open(key, "short"))
    }

    @Test
    fun signsAnAnswerAsTheServerChecksIt() {
        assertEquals("75ae351e3b318a8a3d3c9dcd3815ca9247fb5dc75483b40416b3da4782f06ef4", PushCrypto.sign(key, "dev_1", "1761700000000", "ap_1", "allow"))
    }
}
