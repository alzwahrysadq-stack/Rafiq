package net.arena.rafiq.domain

import java.security.MessageDigest
import java.security.SecureRandom
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.PBEKeySpec

/**
 * تخزين رموز الدخول: PBKDF2-HMAC-SHA256 مع ملح عشوائي لكل رمز.
 * الصيغة: pbkdf2$<تكرارات>$<ملح hex>$<تجزئة hex>
 * الرموز القديمة (نص عادي) تُقبل مرة، ثم تُرقّى إلى التجزئة عند أول دخول ناجح.
 */
object PinHasher {
    const val ITERATIONS = 120_000
    private const val PREFIX = "pbkdf2\$"
    private val random = SecureRandom()

    fun isValidFormat(pin: String): Boolean = Regex("^[0-9]{4}$").matches(pin)

    fun isHashed(stored: String): Boolean = stored.startsWith(PREFIX)

    fun hash(pin: String): String {
        val salt = ByteArray(16).also { random.nextBytes(it) }
        val digest = derive(pin, salt, ITERATIONS)
        return "$PREFIX$ITERATIONS\$${toHex(salt)}\$${toHex(digest)}"
    }

    fun verify(stored: String, pin: String): Boolean {
        if (!isHashed(stored)) {
            return MessageDigest.isEqual(stored.toByteArray(), pin.toByteArray())
        }
        val parts = stored.split('$')
        if (parts.size != 4) return false
        val iterations = parts[1].toIntOrNull() ?: return false
        val salt = fromHex(parts[2]) ?: return false
        val expected = fromHex(parts[3]) ?: return false
        return MessageDigest.isEqual(derive(pin, salt, iterations), expected)
    }

    private fun derive(pin: String, salt: ByteArray, iterations: Int): ByteArray {
        val spec = PBEKeySpec(pin.toCharArray(), salt, iterations, 256)
        return SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(spec).encoded
    }

    private fun toHex(bytes: ByteArray): String = bytes.joinToString("") { "%02x".format(it) }

    private fun fromHex(hex: String): ByteArray? {
        if (hex.length % 2 != 0 || !hex.all { it in '0'..'9' || it in 'a'..'f' }) return null
        return ByteArray(hex.length / 2) { hex.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
    }
}
