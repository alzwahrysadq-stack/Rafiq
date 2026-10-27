package net.arena.rafiq

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.os.Looper
import android.speech.RecognizerIntent
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.LooperMode
import com.google.zxing.client.android.Intents

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
@LooperMode(LooperMode.Mode.PAUSED)
class ScannerIntentTest {
    @Test fun `قارئ الكاميرا يستخدم صيغ المتجر وليس جميع الصيغ ويظل طوليا`() {
        val app = ApplicationProvider.getApplicationContext<android.app.Application>()
        shadowOf(app).grantPermissions(Manifest.permission.CAMERA)
        val controller = Robolectric.buildActivity(MainActivity::class.java).create().start().resume()
        try {
            val activity = controller.get()
            activity.scanBarcode()
            shadowOf(Looper.getMainLooper()).idle()
            val started = shadowOf(activity).nextStartedActivityForResult
            assertNotNull(started)
            assertEquals(4204, started.requestCode)
            assertEquals(PortraitCaptureActivity::class.java.name, started.intent.component?.className)
            val formats = started.intent.getStringExtra(Intents.Scan.FORMATS).orEmpty().split(',').toSet()
            assertTrue(formats.containsAll(setOf("EAN_13", "UPC_A", "CODE_128", "QR_CODE")))
            assertFalse(formats.contains("PDF_417"))
            assertFalse(formats.contains("AZTEC"))
        } finally {
            controller.pause().stop().destroy()
        }
    }

    @Test fun `زر الصوت يفتح تعرف الهاتف بالعربية ولا يبدأ دون نقرة`() {
        val controller = Robolectric.buildActivity(MainActivity::class.java).create().start().resume()
        try {
            val activity = controller.get()
            assertNull(shadowOf(activity).nextStartedActivityForResult)
            DeviceBridge(activity).listen()
            shadowOf(Looper.getMainLooper()).idle()
            val started = shadowOf(activity).nextStartedActivityForResult
            assertNotNull(started)
            assertEquals(4208, started.requestCode)
            assertEquals(RecognizerIntent.ACTION_RECOGNIZE_SPEECH, started.intent.action)
            assertEquals("ar", started.intent.getStringExtra(RecognizerIntent.EXTRA_LANGUAGE))
            assertEquals(3, started.intent.getIntExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 0))
            DeviceBridge(activity).listen() // ضغطتان أثناء الاستماع لا تفتحان جلستين
            shadowOf(Looper.getMainLooper()).idle()
            assertNull(shadowOf(activity).nextStartedActivityForResult)
            shadowOf(activity).callOnActivityResult(4208, Activity.RESULT_CANCELED, null)
            DeviceBridge(activity).listen() // بعد الإلغاء يستطيع البدء مجدداً
            shadowOf(Looper.getMainLooper()).idle()
            assertNotNull(shadowOf(activity).nextStartedActivityForResult)
            val recognized = Intent().putStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS,
                arrayListOf("افتح البيع", "افتح نقطة البيع"))
            shadowOf(activity).callOnActivityResult(4208, Activity.RESULT_OK, recognized)
            DeviceBridge(activity).listen() // نتيجة الكلام لا تغلق الميزة نهائياً
            shadowOf(Looper.getMainLooper()).idle()
            assertNotNull(shadowOf(activity).nextStartedActivityForResult)
        } finally {
            controller.pause().stop().destroy()
        }
    }
}
