package net.arena.rafiq.cloud

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.webkit.JavascriptInterface
import net.arena.rafiq.MainActivity
import net.arena.rafiq.data.MirrorRowEntity
import net.arena.rafiq.data.OfxOpEntity
import net.arena.rafiq.data.RafiqDatabase
import net.arena.rafiq.data.SettingEntity
import net.arena.rafiq.data.SyncMetaEntity
import net.arena.rafiq.sms.SmsSender
import net.arena.rafiq.web.CLOUD_BINDING_KEY
import net.arena.rafiq.web.CLOUD_SETUP_SEEN_KEY
import android.provider.Settings
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * 6أ: جسر الواجهة الموحدة داخل WebView السحابي — طابور خارج، مرآة داخل، مراس مزامنة،
 * SMS من هاتف الإرسال المعيّن، تصدير CSV، وفتح الأرشيف المحلي للقراءة فقط.
 * لا يستخدم الدفتر المحلي القديم في البيع؛ يُزيل بياناته التجريبية مرة واحدة عند التحديث
 * مع حفظ settings/users اللازمَين لربط Keystore والإقلاع، ولا يحمل أسرار خادم.
 */
class CloudNativeBridge(private val activity: Activity, private val db: RafiqDatabase) {
    companion object {
        private const val RESET_PREF = "rafiq_pilot_test_cleanup"
        private const val RESET_KEY = "cleaned_20261019"
        private val resetLock = Any()
    }
    /**
     * Stable physical-device fingerprint (SHA-256 of ANDROID_ID) used only to match
     * the owner-designated SMS sender phone, independent of the signed-in account.
     * Never leaves the device except as this hash in the store's message settings.
     */
    @JavascriptInterface
    fun physicalId(): String {
        val raw = try { Settings.Secure.getString(activity.contentResolver, Settings.Secure.ANDROID_ID) ?: "" } catch (_: Exception) { "" }
        if (raw.isEmpty()) return ""
        val d = java.security.MessageDigest.getInstance("SHA-256").digest(raw.toByteArray(Charsets.UTF_8))
        return d.joinToString("") { "%02x".format(it) }
    }

    private val resetPrefs by lazy { activity.getSharedPreferences(RESET_PREF, Context.MODE_PRIVATE) }
    private var resetPrepared = false

    /**
     * ترقية نفس التطبيق بعد تنظيف الخادم: امسح طابور التجارب والمرآة والدفتر المحلي الوهمي
     * قبل تحميل جلسة الويب أو أي مزامنة. الكتابة ذرّية ولا تمس ربط Keystore في settings.
     * لا تُحفظ علامة الاكتمال هنا؛ يجب أن يمسح الويب نيّات sessionStorage القديمة أولاً.
     */
    @JavascriptInterface
    fun beginPilotDemoReset(): String = synchronized(resetLock) {
        if (resetPrefs.getBoolean(RESET_KEY, false)) return@synchronized """{"ok":true,"clear_web":false}"""
        try {
            db.runInTransaction {
                val sql = db.openHelper.writableDatabase
                // ترتيب الأطفال قبل الآباء مثل استعادة DatabaseSnapshots؛ لا تُحذف
                // settings (تحوي cloud_store_binding_id) أو users ولا يُحذف ملف Keystore.
                val testTables = listOf(
                    "sync_meta", "mirror_rows", "ofx_ops", "wa_log", "login_guard",
                    "invoice_payments", "ledger_entries", "supplier_visits",
                    "supplier_transactions", "imports_log", "cash_movements", "payments",
                    "invoice_items", "invoices", "shifts", "suppliers", "customers", "products",
                )
                for (table in testTables) sql.execSQL("DELETE FROM `$table`")
            }
            resetPrepared = true
            """{"ok":true,"clear_web":true}"""
        } catch (_: Exception) {
            """{"ok":false}""" // فشل التنظيف: الواجهة لا تفتح الشبكة ولا تسمح بالبيع.
        }
    }

    @JavascriptInterface
    fun finishPilotDemoReset(): String = synchronized(resetLock) {
        if (resetPrefs.getBoolean(RESET_KEY, false)) return@synchronized """{"ok":true}"""
        if (!resetPrepared) return@synchronized """{"ok":false}"""
        if (!resetPrefs.edit().putBoolean(RESET_KEY, true).commit())
            return@synchronized """{"ok":false}"""
        resetPrepared = false
        """{"ok":true}"""
    }

    @JavascriptInterface
    fun ofxAdd(json: String): String = try {
        val o = JSONObject(json)
        db.ofx().add(OfxOpEntity(id = o.getString("id"), kind = o.getString("kind"),
            payload = o.optString("payload"), status = "queued",
            queuedAt = o.optString("queuedAt"), anchor = o.optString("anchor")))
        """{"ok":true}"""
    } catch (e: Exception) { """{"ok":false}""" }

    @JavascriptInterface
    fun ofxList(): String {
        val arr = JSONArray()
        for (r in db.ofx().recent()) arr.put(JSONObject().put("id", r.id).put("kind", r.kind)
            .put("payload", r.payload).put("status", r.status).put("attempts", r.attempts)
            .put("serverRef", r.serverRef).put("note", r.note).put("queuedAt", r.queuedAt))
        return arr.toString()
    }

    @JavascriptInterface
    fun ofxQueuedCount(): String = db.ofx().queuedCount().toString()

    /** قراءة عملية واحدة بلا حد قائمة العرض؛ لا تظهر الفاتورة مؤكدة قبل تحقق حالتها في Room. */
    @JavascriptInterface
    fun ofxGet(id: String): String {
        val r = db.ofx().getById(id) ?: return "null"
        return JSONObject().put("id", r.id).put("kind", r.kind).put("payload", r.payload)
            .put("status", r.status).put("serverRef", r.serverRef).put("note", r.note).toString()
    }

    /** 6أ (مراجعة 5): عمليات المراجعة كاملة بلا حد العرض — تعارضات وطلبات ومعزولات وملغاة تسترجع دائمًا. */
    @JavascriptInterface
    fun ofxReview(): String {
        val arr = JSONArray()
        for (r in db.ofx().review()) arr.put(JSONObject().put("id", r.id).put("kind", r.kind)
            .put("payload", r.payload).put("status", r.status).put("attempts", r.attempts)
            .put("serverRef", r.serverRef).put("note", r.note).put("queuedAt", r.queuedAt))
        return arr.toString()
    }

    /** 6أ (مراجعة 2): كل المعلّقة بلا حد العرض — حتى لا تتأخر عملية قديمة عن المزامنة أبدًا. */
    @JavascriptInterface
    fun ofxQueued(): String {
        val arr = JSONArray()
        for (r in db.ofx().queued()) arr.put(JSONObject().put("id", r.id).put("kind", r.kind)
            .put("payload", r.payload).put("status", r.status).put("attempts", r.attempts)
            .put("serverRef", r.serverRef).put("note", r.note).put("queuedAt", r.queuedAt))
        return arr.toString()
    }

    @JavascriptInterface
    fun ofxSettle(id: String, status: String, ref: String, note: String): String {
        db.ofx().settle(id, status, ref, note)
        return """{"ok":true}"""
    }

    @JavascriptInterface
    fun mirrorPut(json: String): String = try {
        val arr = JSONArray(json)
        val rows = mutableListOf<MirrorRowEntity>()
        for (i in 0 until arr.length()) {
            val o = arr.getJSONObject(i)
            rows.add(MirrorRowEntity(o.getString("tbl"), o.getString("id"), o.optString("json"), o.optString("updatedAt")))
        }
        db.mirror().put(rows)
        """{"ok":true}"""
    } catch (e: Exception) { """{"ok":false}""" }

    @JavascriptInterface
    fun mirrorGet(tbl: String): String {
        val arr = JSONArray()
        for (r in db.mirror().all(tbl)) arr.put(JSONObject().put("id", r.id).put("json", r.json).put("updatedAt", r.updatedAt))
        return arr.toString()
    }

    @JavascriptInterface
    fun metaGet(k: String): String = db.syncMeta().get(k) ?: ""

    @JavascriptInterface
    fun metaSet(k: String, v: String): String {
        db.syncMeta().set(SyncMetaEntity(k, v))
        return """{"ok":true}"""
    }

    @JavascriptInterface
    fun smsSend(json: String): String = try {
        val o = JSONObject(json)
        val r = SmsSender(activity).send(o.optInt("slot", 1), o.optString("dest"), o.optString("body"), o.optString("task"))
        JSONObject().put("status", r.status).put("segments", r.segments)
            .put("error", r.error ?: JSONObject.NULL).toString()
    } catch (e: Exception) { """{"status":"unknown","error":"bridge_error"}""" }

    @JavascriptInterface
    fun saveExport(name: String, text: String): String = try {
        val safe = name.replace(Regex("[^A-Za-z0-9._-]"), "_")
        val dir = File(activity.getExternalFilesDir(null), "exports").apply { mkdirs() }
        val f = File(dir, safe).apply { writeText(text, Charsets.UTF_8) }
        JSONObject().put("path", f.absolutePath).toString()
    } catch (e: Exception) { """{"error":"export_failed"}""" }

    @JavascriptInterface
    fun openLocalArchive(): String = try {
        activity.startActivity(Intent(activity, MainActivity::class.java)
            .putExtra(MainActivity.EXTRA_ARCHIVE, true))
        """{"ok":true}"""
    } catch (e: Exception) { """{"ok":false}""" }

    /** أمر المالك (الجولة 9): حفظ الإعداد السحابي من الشاشة الموحدة نفسها عند غيابه — تشفير
     * Android Keystore نفسه ومفتاحا الربط/الاطلاع نفسيهما كما في NativeApi؛ القيم لا تُوضع في
     * تخزين WebView ولا في Room (سوى معرّف الربط المحلي العشوائي، كما في مسار صفحة المالك). */
    @JavascriptInterface
    fun savePilotConfiguration(url: String, key: String): String = try {
        val cleanUrl = CloudConfigRules.projectUrl(url)
        val cleanKey = CloudConfigRules.publishableKey(key)
        val binding = db.settings().get(CLOUD_BINDING_KEY)?.value
            ?: java.util.UUID.randomUUID().toString().also {
                db.settings().upsert(SettingEntity(CLOUD_BINDING_KEY, it))
            }
        KeystoreCloudConfigurationStorage(activity.applicationContext).save(binding, cleanUrl, cleanKey)
        db.settings().upsert(SettingEntity(CLOUD_SETUP_SEEN_KEY, "1"))
        """{"ok":true}"""
    } catch (e: IllegalArgumentException) { """{"ok":false,"error":"invalid"}""" }
      catch (e: Exception) { """{"ok":false,"error":"save_failed"}""" }

    /** بعد نجاح الحفظ: إعادة الإقلاع من الشاشة الرئيسية لتقرأ التكوين الجديد وتفتح الواجهة
     * الموحدة به (مسار الإقلاع نفسه — لا واجهة دفتر قديم). */
    @JavascriptInterface
    fun restartForConfiguration(): String = try {
        activity.startActivity(Intent(activity, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK))
        activity.finish()
        """{"ok":true}"""
    } catch (e: Exception) { """{"ok":false}""" }
}
