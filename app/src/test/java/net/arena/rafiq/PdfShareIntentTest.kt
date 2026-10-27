package net.arena.rafiq

import android.app.Application
import android.content.Intent
import androidx.core.content.FileProvider
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PdfShareIntentTest {
    @Test fun `مشاركة PDF تمنح قراءة ملف فاتورة مؤقت واحد ولا تكشف بقية الملفات`() {
        val app = ApplicationProvider.getApplicationContext<Application>()
        val folder = File(app.cacheDir, "shared_invoices").apply { mkdirs() }
        val pdf = File.createTempFile("invoice-test-", ".pdf", folder)
        pdf.writeText("%PDF-1.4 test-only")
        val controller = Robolectric.buildActivity(MainActivity::class.java).create().start().resume()
        try {
            val activity = controller.get()
            val uri = FileProvider.getUriForFile(app, "${app.packageName}.files", pdf)
            val send = activity.invoicePdfShareIntent(uri)
            assertEquals(Intent.ACTION_SEND, send.action)
            assertEquals("application/pdf", send.type)
            assertEquals(uri, send.getParcelableExtra(Intent.EXTRA_STREAM))
            assertEquals(uri, send.clipData?.getItemAt(0)?.uri)
            assertTrue(send.flags and Intent.FLAG_GRANT_READ_URI_PERMISSION != 0)
            assertNotNull(send.clipData)
            val other = File(app.cacheDir, "not-shared.txt").apply { writeText("private") }
            assertTrue(runCatching {
                FileProvider.getUriForFile(app, "${app.packageName}.files", other)
            }.isFailure)
            other.delete()
        } finally {
            pdf.delete()
            controller.pause().stop().destroy()
        }
    }
}
