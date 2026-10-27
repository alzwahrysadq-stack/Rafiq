package net.arena.rafiq.data

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream

class BackupArchiveTest {
    private fun password() = "عبارة قوية للتجربة 2026".toCharArray()
    private val sample = ByteArray(150_123) { (it * 37).toByte() }

    private fun backup(bytes: ByteArray = sample): ByteArray = ByteArrayOutputStream().also { out ->
        assertEquals(bytes.size.toLong(), BackupArchive.encrypt(ByteArrayInputStream(bytes), out, password()))
    }.toByteArray()

    private fun unpack(bytes: ByteArray, pass: CharArray = password()): ByteArray = ByteArrayOutputStream().also { out ->
        BackupArchive.decrypt(ByteArrayInputStream(bytes), out, pass)
    }.toByteArray()

    @Test fun `كل المقاطع تعود كاملة بعد التشفير والتحقق`() {
        assertArrayEquals(sample, unpack(backup()))
        assertArrayEquals(ByteArray(0), unpack(backup(ByteArray(0))))
        assertFalse(backup().contentEquals(backup())) // ملح وnonce عشوائيان
    }

    @Test fun `عبارة خطأ لا تفتح الملف`() {
        assertThrows(IOException::class.java) {
            unpack(backup(), "عبارة أخرى طويلة جداً".toCharArray())
        }
    }

    @Test fun `تعديل البايتات والقطع ووسم النهاية يُرفض`() {
        val original = backup()
        val corrupt = original.clone().also { it[45] = (it[45].toInt() xor 1).toByte() }
        assertThrows(IOException::class.java) { unpack(corrupt) }
        assertThrows(IOException::class.java) { unpack(original.copyOf(original.size - 1)) }
        assertThrows(IOException::class.java) { unpack(original + byteArrayOf(42)) }
        val brokenHeader = original.clone().also { it[0] = 0 }
        assertThrows(IOException::class.java) { unpack(brokenHeader) }
    }

    @Test fun `تدفق إدخال قصير لا يفقد بيانات عند حدود المقاطع`() {
        val narrow = object : InputStream() {
            private val delegate = ByteArrayInputStream(sample)
            override fun read(): Int = delegate.read()
            override fun read(b: ByteArray, off: Int, len: Int): Int = delegate.read(b, off, minOf(len, 7))
        }
        val out = ByteArrayOutputStream()
        assertEquals(sample.size.toLong(), BackupArchive.encrypt(narrow, out, password()))
        assertArrayEquals(sample, unpack(out.toByteArray()))
    }

    @Test fun `العبارة القصيرة مرفوضة قبل كتابة أي بيانات`() {
        val out = ByteArrayOutputStream()
        assertThrows(IllegalArgumentException::class.java) {
            BackupArchive.encrypt(ByteArrayInputStream(sample), out, "1234567".toCharArray())
        }
        assertTrue(out.size() == 0)
    }
}
