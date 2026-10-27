package net.arena.rafiq.data

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.IOException

class VerifiedBackupDocumentTest {
    private fun source(): File = File.createTempFile("verified-backup-", ".rafiqbak").apply {
        writeBytes(ByteArray(180_000) { (it * 17).toByte() }) // أكثر من حجم مخزن القراءة
    }

    @Test fun `نسخة محفوظة مطابقة تُقبل بعد إغلاق الكتابة وإعادة القراءة`() {
        val file = source()
        try {
            var closed = false
            val destination = object : ByteArrayOutputStream() {
                override fun close() { closed = true; super.close() }
            }
            VerifiedBackupDocument.copyAndVerify(file,
                write = { destination }, readBack = {
                    assertTrue("يجب إغلاق الكتابة قبل الفحص", closed)
                    ByteArrayInputStream(destination.toByteArray())
                })
            assertArrayEquals(file.readBytes(), destination.toByteArray())
        } finally { file.delete() }
    }

    @Test fun `ملف مبتور أو محرّف يُرفض ولا يُعلن نجاحاً`() {
        val file = source()
        try {
            val destination = ByteArrayOutputStream()
            assertThrows(IOException::class.java) {
                VerifiedBackupDocument.copyAndVerify(file,
                    write = { destination }, readBack = { ByteArrayInputStream(destination.toByteArray().copyOf(200)) })
            }
            assertThrows(IOException::class.java) {
                VerifiedBackupDocument.copyAndVerify(file,
                    write = { destination }, readBack = {
                        val tampered = destination.toByteArray().also { it[70_000] = (it[70_000].toInt() xor 1).toByte() }
                        ByteArrayInputStream(tampered)
                    })
            }
        } finally { file.delete() }
    }

    @Test fun `الوجهة التي لا تسمح بقراءة الملف لا تُعد نسخة ناجحة`() {
        val file = source()
        try {
            assertThrows(IOException::class.java) {
                VerifiedBackupDocument.copyAndVerify(file,
                    write = { ByteArrayOutputStream() },
                    readBack = { throw IOException("مزوّد التخزين رفض إعادة القراءة") })
            }
        } finally { file.delete() }
    }
}
