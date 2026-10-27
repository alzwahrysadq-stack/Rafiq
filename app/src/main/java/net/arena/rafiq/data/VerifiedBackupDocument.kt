package net.arena.rafiq.data

import java.io.File
import java.io.FileInputStream
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.security.MessageDigest

/**
 * ينسخ الأرشيف المشفّر إلى وجهة Android SAF ثم يقرأه منها ثانية.
 * لا يُعَد الملف نسخة ناجحة إذا تعذر فتحه للقراءة أو اختلفت بايتاته عن الأصل.
 * تُفتح القراءة بعد إغلاق تيار الكتابة لكي لا نقارن ملفاً لم يُفرغ بعد.
 */
object VerifiedBackupDocument {
    fun copyAndVerify(source: File, write: () -> OutputStream, readBack: () -> InputStream) {
        FileInputStream(source).use { from -> write().use { to -> from.copyTo(to) } }
        val original = FileInputStream(source).use { digest(it) }
        val saved = readBack().use { digest(it) }
        if (!MessageDigest.isEqual(original, saved)) throw IOException("الملف المحفوظ لا يطابق النسخة المشفّرة")
    }

    private fun digest(input: InputStream): ByteArray {
        val sha = MessageDigest.getInstance("SHA-256")
        val buffer = ByteArray(64 * 1024)
        while (true) {
            val count = input.read(buffer)
            if (count < 0) break
            if (count > 0) sha.update(buffer, 0, count)
            else {
                // بعض المزوّدين يعيدون صفراً بدلاً من التقدّم؛ نقرأ بايتاً واحداً للتأكد من النهاية.
                val one = input.read()
                if (one < 0) break
                sha.update(one.toByte())
            }
        }
        return sha.digest()
    }
}
