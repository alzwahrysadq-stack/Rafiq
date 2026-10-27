package net.arena.rafiq

import android.app.Activity
import androidx.test.core.app.ApplicationProvider
import android.content.Intent
import android.os.Looper
import net.arena.rafiq.data.RafiqDatabase
import net.arena.rafiq.web.NativeApi
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.LooperMode
import java.util.concurrent.Callable
import java.util.concurrent.FutureTask
import java.util.concurrent.TimeUnit

/** يفحص أن واجهة SAF تبدأ بجلسة مالك فقط وأن الإلغاء لا يحبس العمليات التالية. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
@LooperMode(LooperMode.Mode.PAUSED)
class BackupUiTest {
    private val phrase = "عبارة سرية تجريبية طويلة"

    private fun <T> fromBridge(task: () -> T): T {
        val future = FutureTask(Callable { task() })
        Thread(future, "test-backup-bridge").start()
        return future.get(30, TimeUnit.SECONDS)
    }

    @Test fun `الجسر يرفض غير المالك ويطلق منتقي الفحص دون استعادة ويمكن تكراره بعد الإلغاء`() {
        // Isolate the legacy backup bridge: normal launcher redirects to Pilot and finishes.
        // This intent is test-only; it does not expose archive navigation to users.
        val intent = Intent(ApplicationProvider.getApplicationContext<android.content.Context>(), MainActivity::class.java)
            .putExtra(MainActivity.EXTRA_ARCHIVE, true)
        val controller = Robolectric.buildActivity(MainActivity::class.java, intent).create().start().resume()
        try {
            val activity = controller.get()
            val bridge = DeviceBridge(activity)
            val dbField = MainActivity::class.java.getDeclaredField("db").apply { isAccessible = true }
            val apiField = MainActivity::class.java.getDeclaredField("api").apply { isAccessible = true }
            val db = dbField.get(activity) as RafiqDatabase
            val api = apiField.get(activity) as NativeApi
            val users = fromBridge { db.users().getAll() }
            val worker = users.first { it.role == "worker" }
            val owner = users.first { it.role == "owner" }

            assertFalse(fromBridge { bridge.backupInspect(phrase) }) // لا جلسة
            assertFalse(fromBridge { bridge.backupExport(phrase) })
            api.signInAs(worker.id)
            assertFalse(fromBridge { bridge.backupInspect(phrase) })
            assertFalse(fromBridge { bridge.backupExport(phrase) })
            api.signInAs(owner.id)
            assertFalse(fromBridge { bridge.backupInspect("قصير") })
            assertFalse(fromBridge { bridge.backupExport("قصير") })

            assertTrue(fromBridge { bridge.backupInspect(phrase) })
            shadowOf(Looper.getMainLooper()).idle()
            var picker = shadowOf(activity).nextStartedActivityForResult
            while (picker != null && picker.intent.action != Intent.ACTION_OPEN_DOCUMENT) {
                picker = shadowOf(activity).nextStartedActivityForResult
            }
            assertNotNull(picker)
            assertEquals(Intent.ACTION_OPEN_DOCUMENT, picker.intent.action)
            assertEquals("*/*", picker.intent.type)
            assertFalse(fromBridge { bridge.backupExport(phrase) }) // منتقي واحد في كل مرة

            shadowOf(activity).callOnActivityResult(picker.requestCode, Activity.RESULT_CANCELED, null)
            shadowOf(Looper.getMainLooper()).idle()
            assertTrue(fromBridge { bridge.backupInspect(phrase) })
            shadowOf(Looper.getMainLooper()).idle()
            assertEquals(Intent.ACTION_OPEN_DOCUMENT,
                shadowOf(activity).nextStartedActivityForResult.intent.action)
        } finally {
            controller.pause().stop().destroy()
        }
    }
}
