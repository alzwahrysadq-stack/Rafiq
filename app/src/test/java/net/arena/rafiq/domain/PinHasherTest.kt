package net.arena.rafiq.domain

import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class PinHasherTest {

    @Test
    fun hashVerifiesOnlyTheRightPin() {
        val h = PinHasher.hash("4821")
        assertTrue(PinHasher.isHashed(h))
        assertTrue(PinHasher.verify(h, "4821"))
        assertFalse(PinHasher.verify(h, "4822"))
        assertFalse(PinHasher.verify(h, ""))
    }

    @Test
    fun sameInputGivesDifferentHashesBecauseOfSalt() {
        assertNotEquals(PinHasher.hash("1111"), PinHasher.hash("1111"))
    }

    @Test
    fun hashDoesNotContainThePin() {
        val h = PinHasher.hash("9137")
        assertFalse(h.contains("9137"))
    }

    @Test
    fun legacyPlainValueStillVerifiesOnce() {
        assertTrue(PinHasher.verify("2222", "2222"))
        assertFalse(PinHasher.isHashed("2222"))
    }

    @Test
    fun malformedHashIsRejected() {
        assertFalse(PinHasher.verify("pbkdf2\$abc\$zz\$zz", "1234"))
        assertFalse(PinHasher.verify("pbkdf2\$120000\$00", "1234"))
    }

    @Test
    fun pinFormatIsFourDigits() {
        assertTrue(PinHasher.isValidFormat("0000"))
        assertTrue(PinHasher.isValidFormat("9876"))
        assertFalse(PinHasher.isValidFormat("123"))
        assertFalse(PinHasher.isValidFormat("12345"))
        assertFalse(PinHasher.isValidFormat("12a4"))
        assertFalse(PinHasher.isValidFormat(" 1234"))
    }
}
