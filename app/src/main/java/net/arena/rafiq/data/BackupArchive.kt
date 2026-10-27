package net.arena.rafiq.data

import java.io.DataInputStream
import java.io.DataOutputStream
import java.io.EOFException
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.PBEKeySpec
import javax.crypto.spec.SecretKeySpec

/**
 * صيغة نسخة رفيق الأولى: مقاطع AES-256-GCM مستقلة للتحقق دون تحميل القاعدة كاملة في الذاكرة.
 * header = "RFQBACK1" + salt(16) + noncePrefix(8)
 * record = length(u32 big endian) + AES-GCM(plaintext, noncePrefix || recordIndex, AAD=header||index||length)
 * record أخير length=0 مع وسم GCM؛ يرفض الملف المبتور أو اللاحقة الزائدة أو تبديل ترتيب المقاطع.
 * لا تُخزّن عبارة المرور في القاعدة أو الملف؛ لا يمكن استعادتها إذا نُسيت.
 */
object BackupArchive {
    private val MAGIC = "RFQBACK1".toByteArray(Charsets.US_ASCII)
    private const val SALT_BYTES = 16
    private const val NONCE_PREFIX_BYTES = 8
    private const val CHUNK_BYTES = 64 * 1024
    private const val TAG_BYTES = 16
    private const val ITERATIONS = 260_000
    private const val MAX_BYTES = 512L * 1024 * 1024
    private val random = SecureRandom()

    fun encrypt(plaintext: InputStream, destination: OutputStream, password: CharArray): Long {
        checkPassword(password)
        val salt = ByteArray(SALT_BYTES).also(random::nextBytes)
        val prefix = ByteArray(NONCE_PREFIX_BYTES).also(random::nextBytes)
        val header = MAGIC + salt + prefix
        val keyBytes = derive(password, salt)
        var total = 0L
        try {
            val out = DataOutputStream(destination)
            out.write(header)
            var index = 0
            val buffer = ByteArray(CHUNK_BYTES)
            while (true) {
                val length = readChunk(plaintext, buffer)
                if (length == 0) break
                total += length
                if (total > MAX_BYTES) throw IOException("حجم النسخة يتجاوز 512 ميغابايت")
                out.writeInt(length)
                out.write(seal(keyBytes, prefix, header, index, length, buffer, length))
                index++
            }
            out.writeInt(0)
            out.write(seal(keyBytes, prefix, header, index, 0, ByteArray(0), 0))
            out.flush()
            return total
        } finally {
            keyBytes.fill(0)
        }
    }

    /** يكتمل بنجاح فقط بعد التحقق من جميع المقاطع ووسم النهاية وعدم وجود بايتات زائدة. */
    fun decrypt(archive: InputStream, destination: OutputStream, password: CharArray): Long {
        checkPassword(password)
        val input = DataInputStream(archive)
        val header = ByteArray(MAGIC.size + SALT_BYTES + NONCE_PREFIX_BYTES)
        try {
            input.readFully(header)
        } catch (_: EOFException) {
            throw IOException("ملف النسخة غير مكتمل")
        }
        if (!header.copyOfRange(0, MAGIC.size).contentEquals(MAGIC)) {
            throw IOException("هذه ليست نسخة رفيق مدعومة")
        }
        val salt = header.copyOfRange(MAGIC.size, MAGIC.size + SALT_BYTES)
        val prefix = header.copyOfRange(MAGIC.size + SALT_BYTES, header.size)
        val keyBytes = derive(password, salt)
        var total = 0L
        try {
            var index = 0
            while (true) {
                val length = try { input.readInt() } catch (_: EOFException) { throw IOException("ملف النسخة مبتور") }
                if (length !in 0..CHUNK_BYTES || total + length > MAX_BYTES) {
                    throw IOException("حجم مقطع النسخة غير صالح")
                }
                val ciphertext = ByteArray(length + TAG_BYTES)
                try {
                    input.readFully(ciphertext)
                } catch (_: EOFException) {
                    throw IOException("ملف النسخة مبتور")
                }
                val plain = try {
                    unseal(keyBytes, prefix, header, index, length, ciphertext)
                } catch (_: Exception) {
                    throw IOException("عبارة المرور غير صحيحة أو ملف النسخة تالف")
                }
                if (plain.size != length) throw IOException("حجم مقطع النسخة غير متطابق")
                if (length == 0) {
                    if (input.read() != -1) throw IOException("بيانات زائدة بعد نهاية النسخة")
                    destination.flush()
                    return total
                }
                destination.write(plain)
                total += length
                index++
            }
        } finally {
            keyBytes.fill(0)
        }
    }

    private fun checkPassword(password: CharArray) {
        require(password.size >= 12) { "عبارة النسخ الاحتياطي يجب ألا تقل عن 12 حرفاً" }
    }

    private fun derive(password: CharArray, salt: ByteArray): ByteArray {
        // PBEKeySpec قد يفسر Unicode بشكل مختلف لدى مزودي أجهزة مختلفة؛ نحوله إلى UTF-8 ثم
        // hex ASCII قبل اشتقاق المفتاح، فيبقى ملف عبارة المرور العربية قابلاً للنقل بين الأجهزة.
        val utf8 = String(password).toByteArray(Charsets.UTF_8)
        val digits = "0123456789abcdef"
        val ascii = CharArray(utf8.size * 2)
        for (i in utf8.indices) {
            val b = utf8[i].toInt() and 0xff
            ascii[i * 2] = digits[b ushr 4]
            ascii[i * 2 + 1] = digits[b and 15]
        }
        val spec = PBEKeySpec(ascii, salt, ITERATIONS, 256)
        return try {
            SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(spec).encoded
        } finally {
            spec.clearPassword()
            ascii.fill('\u0000')
            utf8.fill(0)
        }
    }

    private fun cipher(key: ByteArray, prefix: ByteArray, header: ByteArray, index: Int, length: Int, mode: Int): Cipher {
        val nonce = prefix + byteArrayOf(
            (index ushr 24).toByte(), (index ushr 16).toByte(), (index ushr 8).toByte(), index.toByte(),
        )
        return Cipher.getInstance("AES/GCM/NoPadding").apply {
            init(mode, SecretKeySpec(key, "AES"), GCMParameterSpec(TAG_BYTES * 8, nonce))
            updateAAD(header)
            updateAAD(byteArrayOf(
                (index ushr 24).toByte(), (index ushr 16).toByte(), (index ushr 8).toByte(), index.toByte(),
                (length ushr 24).toByte(), (length ushr 16).toByte(), (length ushr 8).toByte(), length.toByte(),
            ))
        }
    }

    private fun seal(key: ByteArray, prefix: ByteArray, header: ByteArray, index: Int, length: Int,
                     data: ByteArray, count: Int): ByteArray =
        cipher(key, prefix, header, index, length, Cipher.ENCRYPT_MODE).doFinal(data, 0, count)

    private fun unseal(key: ByteArray, prefix: ByteArray, header: ByteArray, index: Int,
                       length: Int, data: ByteArray): ByteArray =
        cipher(key, prefix, header, index, length, Cipher.DECRYPT_MODE).doFinal(data)

    /** بعض الموفرين يعيدون عدداً أقل من المطلوب؛ نملأ المقطع قبل تشفيره. */
    private fun readChunk(input: InputStream, buffer: ByteArray): Int {
        var count = 0
        while (count < buffer.size) {
            val n = input.read(buffer, count, buffer.size - count)
            if (n == -1) break
            if (n == 0) {
                val one = input.read()
                if (one == -1) break
                buffer[count++] = one.toByte()
            } else count += n
        }
        return count
    }
}
