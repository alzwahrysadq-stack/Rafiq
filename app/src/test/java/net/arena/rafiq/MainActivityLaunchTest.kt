package net.arena.rafiq

import android.content.Context
import android.content.Intent
import android.os.Looper
import androidx.test.core.app.ApplicationProvider
import net.arena.rafiq.cloud.CloudConfiguration
import net.arena.rafiq.cloud.CloudConfigurationStorage
import net.arena.rafiq.data.RafiqDatabase
import net.arena.rafiq.data.SettingEntity
import net.arena.rafiq.web.CLOUD_BINDING_KEY
import net.arena.rafiq.web.NativeApi
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows
import org.robolectric.annotation.Config

/**
 * يعيد إنتاج الإقلاع على الهاتف: الشاشة الرئيسية تُنشأ على قاعدة ملف حقيقية
 * (لا قاعدة الذاكرة في الاختبارات التي تسمح بالاستعلام من الخيط الرئيسي).
 * أي وصول إلى قاعدة البيانات من onCreate يُسقط التطبيق عند التشغيل.
 *
 * شرط المالك (الجولة 10): قراءة إعداد الإقلاع انتقلت إلى عامل خلفي (bootWorker) ثم
 * توجيه على الخيط الرئيسي — الاختبارات تنتظر اكتمال التوجيه قبل الفحص.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class MainActivityLaunchTest {

    /** ينتظر حتى يوجّه الإقلاع نشاطًا (القراءة على عامل خلفي ثم runOnUiThread). */
    private fun awaitBootRouting(activity: MainActivity, timeoutMs: Long = 10_000): Intent? {
        val shadowApp = Shadows.shadowOf(activity.application)
        val main = Shadows.shadowOf(Looper.getMainLooper())
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            main.idle()
            shadowApp.nextStartedActivity?.let { return it }
            Thread.sleep(25)
        }
        return shadowApp.nextStartedActivity
    }

    @Test
    fun appStartsOnFileDatabaseWithoutTouchingDatabaseOnMainThread() {
        val controller = Robolectric.buildActivity(MainActivity::class.java)
            .create().start().resume()
        val activity = controller.get()
        try {
            awaitBootRouting(activity)
            assertNotNull(activity)
        } finally {
            controller.destroy()
        }
    }

    /** أمر المالك (الجولة 9): عند غياب الإعداد السحابي يفتح الإقلاع الواجهة الموحدة في وضع
     * التهيئة (بلا extras) — ولا تُفتح واجهة الدفتر القديم أبدًا في هذا المسار. */
    @Test
    fun absentCloudConfigurationLaunchesUnifiedPilotInSetupModeNotOldLedger() {
        val controller = Robolectric.buildActivity(MainActivity::class.java).create()
        val activity = controller.get()
        try {
            val next = awaitBootRouting(activity)
            assertNotNull("الإقلاع بلا إعداد يجب أن يوجّه نشاطًا واحدًا على الأقل", next)
            assertEquals(CloudPilotActivity::class.java.name, next?.component?.className)
            assertEquals("", next?.getStringExtra(CloudPilotActivity.EXTRA_URL).orEmpty())
            assertEquals("", next?.getStringExtra(CloudPilotActivity.EXTRA_KEY).orEmpty())
            assertTrue("الشاشة القديمة تُغلق فور توجيه الواجهة الموحدة", activity.isFinishing)
        } finally {
            controller.destroy()
        }
    }

    /** شرط المالك (الجولة 10): عند وجود إعداد سحابي محفوظ تُقلع الواجهة الموحدة **به** —
     * القراءة من Room على عامل خلفي؛ لا يُطلب من المالك إدخال إعداد موجود أصلًا،
     * ولا تُفتح واجهة الدفتر القديم. قبل الإصلاح كانت القراءة على الخيط الرئيسي تُرمى
     * (قاعدة الملف لا تسمح بذلك) ويُبتلع الاستثناء ⇒ وضع تهيئة رغم وجود الإعداد. */
    @Test
    fun savedCloudConfigurationLaunchesUnifiedPilotWithConfigurationExtras() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val url = "https://syntheticprojectref.supabase.co"
        val key = "sb_publishable_" + "A".repeat(30)
        // بذر مفتاح الربط في قاعدة الملف الحقيقية نفسها التي سيقرؤها الإقلاع.
        // شرط المالك (الجولة 10، إصلاح البذر): البذر على خيط خلفي — خيط اختبار Robolectric
        // هو الخيط الرئيسي، وقاعدة الملف تُبنى بلا allowMainThreadQueries، فالكتابة منه سترمي
        // «Cannot access database on the main thread» قبل الإقلاع (أحمر كاذب في البذر لا في السلوك).
        val seed = RafiqDatabase.build(context)
        val seedFailure = java.util.concurrent.atomic.AtomicReference<Throwable?>(null)
        val seeder = Thread {
            try {
                seed.settings().upsert(SettingEntity(CLOUD_BINDING_KEY, "binding-test"))
            } catch (t: Throwable) {
                seedFailure.set(t)
            }
        }
        seeder.start()
        seeder.join()
        seedFailure.get()?.let { throw it }
        seed.close()
        MainActivity.cloudStorageOverride = object : CloudConfigurationStorage {
            override fun save(storeBindingId: String, projectUrl: String, publishableKey: String) {}
            override fun read(storeBindingId: String) = CloudConfiguration(url, key, storeBindingId)
        }
        val controller = Robolectric.buildActivity(MainActivity::class.java).create()
        val activity = controller.get()
        try {
            val next = awaitBootRouting(activity)
            assertNotNull("الإقلاع بإعداد محفوظ يجب أن يوجّه الواجهة الموحدة", next)
            assertEquals(CloudPilotActivity::class.java.name, next?.component?.className)
            assertEquals("الإعداد المحفوظ يصل كاملًا إلى الواجهة الموحدة", url,
                next?.getStringExtra(CloudPilotActivity.EXTRA_URL))
            assertEquals(key, next?.getStringExtra(CloudPilotActivity.EXTRA_KEY))
            assertTrue("الشاشة القديمة تُغلق فور التوجيه", activity.isFinishing)
        } finally {
            MainActivity.cloudStorageOverride = null
            controller.destroy()
        }
    }

    @Test
    fun loginPageIsServedFromFileDatabaseCreatedOnMainThread() {
        val db = RafiqDatabase.build(ApplicationProvider.getApplicationContext())
        try {
            // كما على الهاتف: البناء على الخيط الرئيسي، ثم أول طلب من الواجهة يأتي من خيط الجسر
            val api = NativeApi(db)
            var out: String? = null
            var failure: Throwable? = null
            val bridge = Thread {
                try {
                    out = api.page("GET", "/login", "")
                } catch (e: Throwable) {
                    failure = e
                }
            }
            bridge.start()
            bridge.join()
            failure?.let { throw it }
            assertEquals("login.html", JSONObject(out!!).getString("template"))
        } finally {
            db.close()
        }
    }
}
