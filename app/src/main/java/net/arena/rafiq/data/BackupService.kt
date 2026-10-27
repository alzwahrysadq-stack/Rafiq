package net.arena.rafiq.data

import android.content.Context
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.InputStream
import java.io.OutputStream

/** عمليات لا تغيّر قاعدة البيع: إنشاء ملف مشفّر وفحص ملف مشفّر قبل التفكير في استعادة. */
class BackupService(private val context: Context, private val db: RafiqDatabase) {
    data class Summary(val rows: Map<String, Long>, val databaseBytes: Long)

    /** لا يغلق تيار destination؛ التطبيق هو المسؤول عن إغلاق ملف الوجهة والتحقق منه. */
    fun export(destination: OutputStream, password: CharArray): Summary {
        val snapshot = DatabaseSnapshots.snapshot(context, db)
        try {
            FileInputStream(snapshot.file).use { input ->
                BackupArchive.encrypt(input, destination, password)
            }
            return Summary(snapshot.rowCounts, snapshot.size)
        } finally {
            DatabaseSnapshots.discard(context, snapshot.file)
        }
    }

    /** يتحقق من عبارة المرور والوسم والمخطط والروابط دون مساس بقاعدة البيع الحية. */
    fun inspect(archive: InputStream, password: CharArray): Summary {
        val stage = DatabaseSnapshots.newStagingFile(context)
        try {
            FileOutputStream(stage).use { output -> BackupArchive.decrypt(archive, output, password) }
            val result = DatabaseSnapshots.verify(context, stage)
            return Summary(result.rowCounts, result.size)
        } finally {
            DatabaseSnapshots.discard(context, stage)
        }
    }
}
