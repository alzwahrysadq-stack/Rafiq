package net.arena.rafiq

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.ClipData
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import android.provider.ContactsContract
import android.speech.RecognizerIntent
import android.print.PrintAttributes
import android.print.PrintManager
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.webkit.WebViewAssetLoader
import androidx.core.content.FileProvider
import com.google.zxing.client.android.Intents
import net.arena.rafiq.cloud.CloudConfigurationStorage
import net.arena.rafiq.cloud.KeystoreCloudConfigurationStorage
import net.arena.rafiq.data.BackupService
import net.arena.rafiq.data.RafiqDatabase
import net.arena.rafiq.data.VerifiedBackupDocument
import net.arena.rafiq.web.NativeApi
import net.arena.rafiq.whatsapp.InvoicePdf
import org.json.JSONObject
import org.json.JSONArray
import java.io.ByteArrayInputStream
import java.net.URI
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.IOException
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.atomic.AtomicBoolean

/**
 * الشاشة الرئيسية: تعرض الواجهات المعتمدة (القوالب) داخل WebView عبر محرّك engine.js،
 * والبيانات والقرارات من Kotlin عبر NativeApi. تبدأ من تسجيل الدخول.
 */
class MainActivity : Activity() {

    companion object {
        private const val REQ_FILE = 4201
        private const val REQ_CAMERA = 4202
        const val EXTRA_ARCHIVE = "rafiq_archive"
        @Volatile var archiveMode = false
        private const val REQ_SMS = 4310
        @Volatile var instance: MainActivity? = null
        /** وصلة اختبار CI فقط: تتجاوز تخزين إعداد السحابة قبل الإقلاع؛ الإنتاج يبقى null ⇒ Keystore. */
        @Volatile var cloudStorageOverride: CloudConfigurationStorage? = null
        private const val REQ_SAVE = 4203
        private const val REQ_SCAN = 4204
        private const val REQ_CONTACT = 4205
        private const val REQ_BACKUP_EXPORT = 4206
        private const val REQ_BACKUP_INSPECT = 4207
        private const val REQ_VOICE = 4208
    }

    private lateinit var db: RafiqDatabase
    private lateinit var api: NativeApi
    private lateinit var web: WebView
    private lateinit var assets: WebViewAssetLoader
    private val cloudHostLock = Any()
    private var allowedCloudHost: String? = null // read/write only under cloudHostLock
    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private var pendingSaveText: String? = null
    private val backupWorker = Executors.newSingleThreadExecutor()
    private val backupBusy = AtomicBoolean(false)
    // شرط المالك (الجولة 10): قراءة إعداد الإقلاع من Room تتم هنا — قاعدة الهاتف الحقيقية
    // لا تسمح بالاستعلام من الخيط الرئيسي (allowMainThreadQueries للقواعد المرحلية فقط).
    private val bootWorker = Executors.newSingleThreadExecutor()
    private val shareWorker = Executors.newSingleThreadExecutor()
    private val shareBusy = AtomicBoolean(false)
    private var encryptedBackup: File? = null
    private var inspectPhrase: CharArray? = null
    private var voiceActive = false

    private fun blockedRequest(): WebResourceResponse = WebResourceResponse(
        "text/plain", "UTF-8", 403, "Forbidden", mapOf("Cache-Control" to "no-store"),
        ByteArrayInputStream(ByteArray(0)),
    )

    /** Called on WebView's JavaScript bridge thread, never trusted to grant a cloud role. */
    fun openPilot() {
        val configuration = try { api.pilotConfiguration() } catch (_: Exception) { null }
        runOnUiThread {
            if (configuration == null) {
                Toast.makeText(this, "أكمل تهيئة مشروع الاختبار من حساب المالك أولاً", Toast.LENGTH_LONG).show()
            } else {
                startActivity(Intent(this, CloudPilotActivity::class.java)
                    .putExtra(CloudPilotActivity.EXTRA_URL, configuration.projectUrl)
                    .putExtra(CloudPilotActivity.EXTRA_KEY, configuration.publishableKey))
            }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        instance = this
        archiveMode = intent.getBooleanExtra(EXTRA_ARCHIVE, false)
        db = RafiqDatabase.build(applicationContext)
        val deviceId = android.provider.Settings.Secure.getString(contentResolver, android.provider.Settings.Secure.ANDROID_ID).orEmpty()
        api = NativeApi(db, BuildConfig.LICENSE_PUBLIC_KEY, deviceId,
            requireSecuritySetup = !BuildConfig.DEBUG,
            cloudStorage = cloudStorageOverride ?: KeystoreCloudConfigurationStorage(applicationContext),
            requireCloudOnboarding = !BuildConfig.DEBUG,
            enableServerShiftPilot = BuildConfig.DEBUG,
            onCloudHostReady = { projectUrl ->
                synchronized(cloudHostLock) {
                    allowedCloudHost = projectUrl?.let { URI(it).host }
                }
            })
        assets = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        // التصحيح عن بُعد (chrome://inspect) مسموح للنسخ التجريبية فقط
        WebView.setWebContentsDebuggingEnabled((applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0)

        web = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.saveFormData = false // لا يتذكر WebView حقول النماذج؛ أقدم أجهزة Android تدعم هذا الضبط.
            // لا وصول إلى ملفات الجهاز أو المحتوى من داخل الصفحات
            settings.allowFileAccess = false
            settings.allowContentAccess = false
            settings.javaScriptCanOpenWindowsAutomatically = false
            settings.setSupportMultipleWindows(false)
            settings.mixedContentMode = android.webkit.WebSettings.MIXED_CONTENT_NEVER_ALLOW
            addJavascriptInterface(api, "RafiqNative")
            addJavascriptInterface(DeviceBridge(this@MainActivity), "RafiqDevice")
            webViewClient = object : WebViewClient() {
                override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                    val uri = request.url
                    if (uri.scheme == "https" && uri.host == "appassets.androidplatform.net" &&
                        uri.port == -1 && uri.userInfo == null) {
                        return if (uri.path?.startsWith("/assets/web/") == true)
                            assets.shouldInterceptRequest(uri) ?: blockedRequest() else blockedRequest()
                    }
                    // لا نسمح بتحميل سكربت أو صفحة من المشروع؛ فقط Auth وREST لمضيف التهيئة المحفوظ.
                    val shiftApiPath = uri.path?.startsWith("/rest/v1/") == true ||
                        uri.path?.startsWith("/auth/v1/") == true
                    val allowed = synchronized(cloudHostLock) {
                        val host = allowedCloudHost
                        host != null && uri.scheme == "https" && uri.host == host &&
                            uri.port == -1 && uri.userInfo == null && shiftApiPath
                    }
                    if (allowed) return null
                    if (uri.scheme == "data" || uri.scheme == "blob") return null
                    return blockedRequest()
                }

                /* الانتقال بين الصفحات محلي فقط، حتى أثناء اتصالات الوردية. */
                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
                    request.url.scheme != "https" || request.url.host != "appassets.androidplatform.net" ||
                        request.url.port != -1 || request.url.userInfo != null ||
                        request.url.path?.startsWith("/assets/web/") != true
            }
            webChromeClient = object : WebChromeClient() {
                /* اختيار الملف (للاستيراد): يفتح منتقي الملفات في الجهاز */
                override fun onShowFileChooser(
                    view: WebView,
                    callback: ValueCallback<Array<Uri>>,
                    params: WebChromeClient.FileChooserParams,
                ): Boolean {
                    fileCallback?.onReceiveValue(null)
                    fileCallback = callback
                    val intent = Intent(Intent.ACTION_GET_CONTENT)
                        .addCategory(Intent.CATEGORY_OPENABLE)
                        .setType("*/*")
                    return try {
                        startActivityForResult(Intent.createChooser(intent, "اختر الملف"), REQ_FILE)
                        true
                    } catch (e: Exception) {
                        fileCallback = null
                        false
                    }
                }
            }
        }
        // 6أ/توحيد + أمر المالك (الجولة 9): الإقلاع يفتح الواجهة الموحدة دائمًا — إن وُجد ربط سحابي
        // محفوظ تُفتح به مباشرة (دخول واحد هناك)، وإن غاب تُفتح في «وضع التهيئة» (شاشة إدخال رابط
        // المشروع ومفتاحه العام داخل الواجهة الموحدة نفسها). لا تُفتح واجهة الدفتر القديم أبدًا عند
        // غياب الإعداد؛ الدفتر القديم يبقى أرشيفًا قراءة-فقط عبر EXTRA_ARCHIVE صريحًا فقط.
        // شرط المالك (الجولة 10): القراءة من Room على الخيط الرئيسي كانت تُسقط إعدادًا محفوظًا
        // بصمت (الاستثناء يُبتلع ⇒ وضع تهيئة رغم وجود الإعداد)؛ صارت على عامل خلفي ثم توجيه على
        // الخيط الرئيسي. لا تُعرض واجهة قديمة أثناء الانتظار — لا setContentView قبل القرار.
        if (!archiveMode) {
            bootWorker.execute {
                val launchCfg = try { api.pilotConfigurationForLaunch() } catch (_: Exception) { null }
                runOnUiThread {
                    if (isFinishing || isDestroyed) return@runOnUiThread
                    val pilot = Intent(this, CloudPilotActivity::class.java)
                    if (launchCfg != null) {
                        pilot.putExtra(CloudPilotActivity.EXTRA_URL, launchCfg.projectUrl)
                            .putExtra(CloudPilotActivity.EXTRA_KEY, launchCfg.publishableKey)
                    }
                    startActivity(pilot)
                    finish()
                }
            }
            return
        }
        setContentView(web)
        if (archiveMode) toast("الأرشيف المحلي على هذا الهاتف: قراءة فقط — العمليات الجديدة موقوفة.")
        web.loadUrl("https://appassets.androidplatform.net/assets/web/index.html?p=/login" +
            if (archiveMode) "&archive=1" else "")
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        when (requestCode) {
            REQ_FILE -> {
                fileCallback?.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data))
                fileCallback = null
            }
            REQ_SAVE -> saveResult(resultCode, data)
            REQ_CONTACT -> contactResult(resultCode, data)
            REQ_BACKUP_EXPORT -> backupSaveResult(resultCode, data)
            REQ_BACKUP_INSPECT -> backupInspectResult(resultCode, data)
            REQ_SCAN -> scanResult(resultCode, data)
            REQ_VOICE -> voiceResult(resultCode, data)
            else -> super.onActivityResult(requestCode, resultCode, data)
        }
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        if (requestCode == REQ_CAMERA) {
            if (grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) startScan()
            else toast("يلزم إذن الكاميرا لقراءة الباركود")
            return
        }
        if (requestCode == REQ_SMS) {
            if (grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) toast("مُنح إذن إرسال SMS لهاتف هذا المتجر")
            else toast("بدون إذن إرسال SMS تبقى الرسائل بالطابور للمراجعة")
            return
        }
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
    }

    /* ---------- الجسر: تُستدعى من DeviceBridge على خيط الخلفية، فتنتقل إلى خيط الواجهة ---------- */

    fun printPage() {
        runOnUiThread {
            val pm = getSystemService(PRINT_SERVICE) as PrintManager
            pm.print("رفيق", web.createPrintDocumentAdapter("رفيق"), PrintAttributes.Builder().build())
        }
    }

    fun openExternal(url: String) {
        runOnUiThread {
            try {
                startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
            } catch (e: Exception) {
                toast("لا يوجد تطبيق يفتح هذا الرابط")
            }
        }
    }

    fun scanBarcode() {
        runOnUiThread {
            if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
                startScan()
            } else {
                requestPermissions(arrayOf(Manifest.permission.CAMERA), REQ_CAMERA)
            }
        }
    }

    fun saveText(name: String, text: String) {
        runOnUiThread {
            pendingSaveText = text
            val intent = Intent(Intent.ACTION_CREATE_DOCUMENT)
                .addCategory(Intent.CATEGORY_OPENABLE)
                .setType("text/csv")
                .putExtra(Intent.EXTRA_TITLE, name)
            startActivityForResult(intent, REQ_SAVE)
        }
    }

    /** اختيار جهة اتصال: منتقي النظام يمنح قراءة الرقم المختار فقط، دون طلب إذن جهات الاتصال كاملة */
    fun pickContact() {
        runOnUiThread {
            val intent = Intent(Intent.ACTION_PICK, ContactsContract.CommonDataKinds.Phone.CONTENT_URI)
            try {
                startActivityForResult(intent, REQ_CONTACT)
            } catch (e: Exception) {
                toast("تعذّر فتح جهات الاتصال على هذا الجهاز")
            }
        }
    }

    /** يبدأ التعرف بطلب من المستخدم فقط؛ موفر الهاتف قد يحتاج الإنترنت (وافق المالك). */
    fun listenVoice() {
        runOnUiThread {
            if (voiceActive || isFinishing || isDestroyed) return@runOnUiThread
            val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
                .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                .putExtra(RecognizerIntent.EXTRA_LANGUAGE, "ar")
                .putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 3)
                .putExtra(RecognizerIntent.EXTRA_PROMPT, "قل: أضف حليب عدد 2، أو بيع نقدي، أو اطبع الفاتورة")
            try {
                voiceActive = true
                startActivityForResult(intent, REQ_VOICE)
            } catch (_: Exception) {
                voiceActive = false
                voiceError("تعذّر فتح خدمة التعرّف الصوتي؛ تحقق من توفرها في الهاتف وإذن الميكروفون ثم حاول مجدداً")
            }
        }
    }

    private fun voiceResult(resultCode: Int, data: Intent?) {
        voiceActive = false
        if (resultCode != RESULT_OK) {
            voiceError("لم تصل نتيجة من خدمة الصوت؛ ربما أُلغي الاستماع أو احتاجت الخدمة للإنترنت. لم يُنفّذ أي أمر")
            return
        }
        val candidates = data?.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS)
            ?.map { it.trim().take(120) }?.filter { it.isNotEmpty() }?.distinct()?.take(3).orEmpty()
        if (candidates.isEmpty()) {
            voiceError("لم أسمع أمراً واضحاً؛ حاول التحدث مرة أخرى")
            return
        }
        // يرسل نصوص الاحتمالات إلى الواجهة للمراجعة فقط؛ لا يحفظ الصوت أو ينفذ بيعاً.
        runJs("window.__rafiqVoiceCandidates && window.__rafiqVoiceCandidates(" +
            JSONArray(candidates).toString() + ")")
    }

    private fun voiceError(message: String) {
        runJs("window.__rafiqVoiceError && window.__rafiqVoiceError(" + JSONObject.quote(message) + ")")
    }

    /** فاتورة PDF محلية لزبون مرتبط: لا يرسلها رفيق؛ يختار المستخدم جهة الإرسال في Android. */
    fun shareInvoicePdf(invoiceId: Long) {
        if (invoiceId <= 0 || !::api.isInitialized || shareWorker.isShutdown ||
            !shareBusy.compareAndSet(false, true)) return
        try {
            shareWorker.execute {
                var staged: File? = null
                try {
                    val draft = api.prepareManualInvoiceShare(invoiceId) // صلاحية + جلسة + رقم الزبون
                    val data = InvoicePdf.render(draft.document)
                    if (data.size !in 100..8_000_000) throw IOException("حجم الفاتورة غير صالح للمشاركة")
                    val folder = File(cacheDir, "shared_invoices")
                    if (!folder.exists() && !folder.mkdirs()) throw IOException("تعذّر تجهيز مجلد الفاتورة")
                    folder.listFiles()?.filter { it.lastModified() < System.currentTimeMillis() - 86_400_000L }
                        ?.forEach { it.delete() }
                    val output = File.createTempFile("invoice-${draft.invoiceNumber}-", ".pdf", folder)
                    staged = output
                    FileOutputStream(output).use { it.write(data) }
                    // منع مشاركة رصيد أو فاتورة تغيّرت أثناء تجهيز PDF، أو بعد انتهاء الجلسة.
                    if (api.prepareManualInvoiceShare(invoiceId) != draft) {
                        throw IllegalStateException("تغيّرت بيانات الفاتورة؛ افتحها وراجعها ثم أعد المحاولة")
                    }
                    runOnUiThread {
                        if (isFinishing || isDestroyed) {
                            output.delete(); shareBusy.set(false); return@runOnUiThread
                        }
                        try {
                            val uri = FileProvider.getUriForFile(this, "$packageName.files", output)
                            val chooser = Intent.createChooser(invoicePdfShareIntent(uri),
                                "اختر تطبيقاً ثم الزبون ${draft.customerName} (${draft.phone})")
                                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                            startActivity(chooser)
                        } catch (_: Exception) {
                            output.delete()
                            toast("تعذّر فتح مشاركة الفاتورة؛ لم تُرسل")
                        } finally {
                            shareBusy.set(false)
                        }
                    }
                } catch (e: Exception) {
                    staged?.delete()
                    shareBusy.set(false)
                    runOnUiThread {
                        if (!isDestroyed) toast(if (e is IllegalStateException || e is IllegalArgumentException)
                            e.message ?: "تعذّر تجهيز الفاتورة" else "تعذّر تجهيز PDF؛ لم تُرسل الفاتورة")
                    }
                }
            }
        } catch (_: RejectedExecutionException) {
            shareBusy.set(false)
        }
    }

    /** ClipData + إذن قراءة مؤقت للملف نفسه فقط؛ لا وصول إلى قاعدة البيانات أو بقية الملفات. */
    fun invoicePdfShareIntent(uri: Uri): Intent = Intent(Intent.ACTION_SEND)
        .setType("application/pdf")
        .putExtra(Intent.EXTRA_STREAM, uri)
        .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        .apply { clipData = ClipData.newUri(contentResolver, "فاتورة PDF", uri) }

    /* ---------- نتائج الأنشطة ---------- */

    private fun startScan() {
        // IntentIntegrator يحمّل FragmentActivity حتى عندما يعمل من Activity عادية؛
        // لم تُضمّن مكتبة Fragment في التطبيق الخفيف. نبني نفس Intent الرسمي مباشرةً.
        val intent = Intent(this, PortraitCaptureActivity::class.java)
            .setAction(Intents.Scan.ACTION)
            // أصناف المتاجر وQR؛ تجنّب الصيغ غير المطلوبة في نقطة البيع.
            .putExtra(Intents.Scan.FORMATS,
                "EAN_13,EAN_8,UPC_A,UPC_E,CODE_128,CODE_39,CODE_93,ITF,QR_CODE")
            .putExtra(Intents.Scan.PROMPT_MESSAGE, "وجّه الكاميرا نحو الباركود")
            .putExtra(Intents.Scan.BEEP_ENABLED, true)
            .putExtra(Intents.Scan.ORIENTATION_LOCKED, false) // portrait في المانيفست
        ScanTiming.start()
        try {
            startActivityForResult(intent, REQ_SCAN)
        } catch (_: Exception) {
            toast("تعذّر فتح قارئ الباركود")
        }
    }

    private fun scanResult(resultCode: Int, data: Intent?) {
        val code = if (resultCode == RESULT_OK) data?.getStringExtra(Intents.Scan.RESULT) else null
        if (!code.isNullOrEmpty()) {
            ScanTiming.finish()
            runJs("window.__rafiqScanCb && window.__rafiqScanCb(" + JSONObject.quote(code) + ")")
        }
    }

    private fun saveResult(resultCode: Int, data: Intent?) {
        val text = pendingSaveText
        pendingSaveText = null
        val uri = data?.data
        if (resultCode == RESULT_OK && uri != null && text != null) {
            try {
                contentResolver.openOutputStream(uri)?.use { it.write(text.toByteArray(Charsets.UTF_8)) }
                toast("تم حفظ الملف")
            } catch (e: Exception) {
                toast("تعذّر حفظ الملف")
            }
        }
    }

    /* ---------- نسخة البيانات المشفّرة: حفظ وفحص فقط، لا استعادة من الواجهة بعد ---------- */

    /** تُستدعى من خيط جسر WebView. رفض العامل هنا مستقل عن إخفاء الزر في القالب. */
    fun beginBackupExport(passphrase: String): Boolean {
        if (backupWorker.isShutdown || !::api.isInitialized || api.currentUser()?.role != "owner" ||
            passphrase.length !in 12..256 || !backupBusy.compareAndSet(false, true)) return false
        val phrase = passphrase.toCharArray()
        try {
            backupWorker.execute {
                var tmp: File? = null
                try {
                    val stagedBackup = File.createTempFile("rafiq-encrypted-", ".rafiqbak", cacheDir)
                    tmp = stagedBackup
                    val service = BackupService(applicationContext, db)
                    FileOutputStream(stagedBackup).use { out -> service.export(out, phrase) }
                    // تحقّق من الملف المشفر كاملاً قبل عرضه للحفظ، لا من قاعدة المصدر فحسب.
                    FileInputStream(stagedBackup).use { input -> service.inspect(input, phrase) }
                    if (api.currentUser()?.role != "owner") throw IOException("انتهت جلسة المالك")
                    val ready = stagedBackup
                    runOnUiThread {
                        if (isFinishing || isDestroyed) {
                            ready.delete()
                            backupBusy.set(false)
                            return@runOnUiThread
                        }
                        encryptedBackup = ready
                        val name = "rafiq-backup-" + SimpleDateFormat("yyyyMMdd-HHmm", Locale.US).format(Date()) + ".rafiqbak"
                        val intent = Intent(Intent.ACTION_CREATE_DOCUMENT)
                            .addCategory(Intent.CATEGORY_OPENABLE)
                            .setType("application/octet-stream")
                            .putExtra(Intent.EXTRA_TITLE, name)
                        try {
                            startActivityForResult(intent, REQ_BACKUP_EXPORT)
                        } catch (_: Exception) {
                            encryptedBackup = null
                            ready.delete()
                            backupBusy.set(false)
                            backupFeedback(false, "تعذّر فتح اختيار مكان حفظ النسخة")
                        }
                    }
                } catch (_: Exception) {
                    tmp?.delete()
                    backupBusy.set(false)
                    backupFeedback(false, "تعذّر تجهيز نسخة بيانات مؤكدة؛ تأكد من وجود مساحة كافية ثم أعد المحاولة")
                } finally {
                    phrase.fill('\u0000')
                }
            }
        } catch (_: RejectedExecutionException) {
            phrase.fill('\u0000')
            backupBusy.set(false)
            return false
        }
        return true
    }

    /** فحص الملف لا يلمس قاعدة البيع؛ عبارة المرور تُصفّر بعد نتيجة منتقي الملفات. */
    fun beginBackupInspect(passphrase: String): Boolean {
        if (backupWorker.isShutdown || !::api.isInitialized || api.currentUser()?.role != "owner" ||
            passphrase.length !in 12..256 || !backupBusy.compareAndSet(false, true)) return false
        inspectPhrase = passphrase.toCharArray()
        runOnUiThread {
            if (isFinishing || isDestroyed) {
                inspectPhrase?.fill('\u0000'); inspectPhrase = null
                backupBusy.set(false)
                return@runOnUiThread
            }
            val intent = Intent(Intent.ACTION_OPEN_DOCUMENT)
                .addCategory(Intent.CATEGORY_OPENABLE)
                .setType("*/*")
            try {
                startActivityForResult(intent, REQ_BACKUP_INSPECT)
            } catch (_: Exception) {
                inspectPhrase?.fill('\u0000'); inspectPhrase = null
                backupBusy.set(false)
                backupFeedback(false, "تعذّر فتح اختيار ملف النسخة")
            }
        }
        return true
    }

    private fun backupSaveResult(resultCode: Int, data: Intent?) {
        val tmp = encryptedBackup
        encryptedBackup = null
        val uri = data?.data
        if (resultCode != RESULT_OK || uri == null || tmp == null) {
            tmp?.delete()
            backupBusy.set(false)
            backupFeedback(false, "أُلغي حفظ النسخة؛ لم يُحفظ ملف يمكن الاعتماد عليه")
            return
        }
        try {
            backupWorker.execute {
                try {
                    if (api.currentUser()?.role != "owner") throw IOException("انتهت جلسة المالك")
                    VerifiedBackupDocument.copyAndVerify(
                        tmp,
                        write = { contentResolver.openOutputStream(uri, "w") ?: throw IOException("تعذّر فتح وجهة الحفظ") },
                        readBack = { contentResolver.openInputStream(uri) ?: throw IOException("تعذّرت قراءة الملف المحفوظ") },
                    )
                    backupFeedback(true, "حُفظت نسخة مشفّرة وتأكدنا من مطابقة الملف في المكان الذي اخترته")
                } catch (_: Exception) {
                    backupFeedback(false, "لم نتحقق من النسخة؛ قد يبقى ملف ناقص في الوجهة، لا تعتمد عليه واحذفه ثم أعد المحاولة")
                } finally {
                    tmp.delete()
                    backupBusy.set(false)
                }
            }
        } catch (_: RejectedExecutionException) {
            tmp.delete()
            backupBusy.set(false)
            backupFeedback(false, "تعذّر متابعة حفظ النسخة؛ أعد المحاولة")
        }
    }

    private fun backupInspectResult(resultCode: Int, data: Intent?) {
        val phrase = inspectPhrase
        inspectPhrase = null
        val uri = data?.data
        if (resultCode != RESULT_OK || uri == null || phrase == null) {
            phrase?.fill('\u0000')
            backupBusy.set(false)
            backupFeedback(false, "أُلغي فحص النسخة دون تغيير بيانات الهاتف")
            return
        }
        try {
            backupWorker.execute {
                try {
                    if (api.currentUser()?.role != "owner") throw IOException("انتهت جلسة المالك")
                    val input = contentResolver.openInputStream(uri) ?: throw IOException("تعذّر قراءة النسخة")
                    val summary = input.use { BackupService(applicationContext, db).inspect(it, phrase) }
                    backupFeedback(true, "نسخة سليمة: ${summary.rows["invoices"] ?: 0} فاتورة، " +
                        "${summary.rows["products"] ?: 0} صنف، ${summary.rows["customers"] ?: 0} زبون. لم تُستعد البيانات.")
                } catch (_: Exception) {
                    backupFeedback(false, "فشل فحص النسخة: عبارة المرور غير صحيحة أو الملف تالف/غير مدعوم")
                } finally {
                    phrase.fill('\u0000')
                    backupBusy.set(false)
                }
            }
        } catch (_: RejectedExecutionException) {
            phrase.fill('\u0000')
            backupBusy.set(false)
            backupFeedback(false, "تعذّر متابعة فحص النسخة؛ أعد المحاولة")
        }
    }

    private fun backupFeedback(ok: Boolean, message: String) {
        runOnUiThread {
            if (isDestroyed) return@runOnUiThread
            toast(message)
            runJs("window.__rafiqBackupResult && window.__rafiqBackupResult(" +
                JSONObject.quote(message) + ", " + ok + ")")
        }
    }

    override fun onDestroy() {
        instance = null
        inspectPhrase?.fill('\u0000'); inspectPhrase = null
        encryptedBackup?.delete(); encryptedBackup = null
        backupWorker.shutdown()
        shareWorker.shutdown()
        bootWorker.shutdown()
        super.onDestroy()
    }

    private fun contactResult(resultCode: Int, data: Intent?) {
        if (resultCode != RESULT_OK) return
        val uri = data?.data ?: return
        val number = try {
            contentResolver.query(uri, arrayOf(ContactsContract.CommonDataKinds.Phone.NUMBER), null, null, null)?.use { c ->
                if (c.moveToFirst()) c.getString(0) else null
            }
        } catch (e: Exception) {
            null
        }
        if (number.isNullOrBlank()) {
            toast("هذه الجهة بلا رقم هاتف")
            return
        }
        runJs("window.__rafiqContact && window.__rafiqContact(" + JSONObject.quote(number) + ")")
    }

    private fun runJs(js: String) {
        web.evaluateJavascript(js, null)
    }

    private fun toast(msg: String) {
        Toast.makeText(this, msg, Toast.LENGTH_LONG).show()
    }

    /* الرجوع يعود إلى الشاشة السابقة داخل المحرّك؛ إن لم توجد شاشة سابقة (الرئيسية أو الدخول) يُغلق التطبيق */
    fun buildNumber(): String = try {
        packageManager.getPackageInfo(packageName, 0).versionCode.toString()
    } catch (e: Exception) {
        "?"
    }

    override fun onBackPressed() {
        web.evaluateJavascript("(window.__rafiqBack && window.__rafiqBack()) ? 'yes' : 'no'") { result ->
            if (result != "\"yes\"") finish()
        }
    }
}
