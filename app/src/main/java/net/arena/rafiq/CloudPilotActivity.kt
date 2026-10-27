package net.arena.rafiq

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.net.Uri
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import net.arena.rafiq.cloud.PilotImagePickerRules
import android.provider.ContactsContract
import android.print.PrintAttributes
import android.print.PrintManager
import android.speech.RecognizerIntent
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.webkit.WebViewAssetLoader
import com.google.zxing.client.android.Intents
import net.arena.rafiq.cloud.CloudConfigRules
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.IOException
import java.net.URI
import java.nio.charset.StandardCharsets

/**
 * The main Rafiq interface in the same application ID: familiar owner/worker screens
 * backed by Supabase Auth/RLS and the isolated Room sync queue, not the legacy ledger.
 * Print and barcode bridges carry no account secrets or write permission. This pilot
 * remains review-only until a separate real-device acceptance test authorizes sales.
 */
class CloudPilotActivity : Activity() {
    companion object {
        const val EXTRA_URL = "net.arena.rafiq.PILOT_PUBLIC_URL"
        const val EXTRA_KEY = "net.arena.rafiq.PILOT_PUBLIC_KEY"
        private const val ASSET_HOST = "appassets.androidplatform.net"
        private const val START_URL = "https://$ASSET_HOST/assets/pilot/index.html"
        private const val REQ_CAMERA = 5501
        private const val REQ_SCAN = 5502
        private const val REQ_VOICE = 5503
        private const val REQ_CONTACT = 5504
        private const val REQ_IMAGE = 5505
    }

    private lateinit var web: WebView
    private var imageCallback: ValueCallback<Array<Uri>>? = null
    private lateinit var appLock: AppLock

    /** الجسر الظاهر لشاشة القفل فقط — بلا أي بيانات حساب. */
    internal fun webViewForLock(): WebView? = if (::web.isInitialized) web else null

    /** قفل التطبيق: بصمة أو رقم سري — نتائج الحوار تُبلَّغ للويب عبر __rafiqLockChanged. */
    private class PilotLockBridge(private val lock: AppLock) {
        @JavascriptInterface fun appLock(payload: String): String {
            val action = try { JSONObject(payload).optString("action", "status") } catch (_: Exception) { "status" }
            return lock.handle(action).toString()
        }
    }

    /** Print-only bridge: no Room data, Auth token, SMS, or project configuration. */
    private class PilotPrintBridge(private val activity: CloudPilotActivity) {
        @JavascriptInterface fun print() = activity.requestPrint()
    }

    /** Voice returns only recognized text. A voice result never saves a sale by itself. */
    private class PilotVoiceBridge(private val activity: CloudPilotActivity) {
        @JavascriptInterface fun start() = activity.requestVoice()
    }

    /** Camera returns only a barcode. A scan never creates a sale or edits stock. */
    private class PilotScannerBridge(private val activity: CloudPilotActivity) {
        @JavascriptInterface fun scan() = activity.requestScan()
    }

    /** Contacts picker returns only a chosen phone number string to the form. */
    private class PilotContactsBridge(private val activity: CloudPilotActivity) {
        @JavascriptInterface fun pick() = activity.requestContactPick()
    }

    fun requestVoice() = runOnUiThread {
        if(isFinishing||!::web.isInitialized)return@runOnUiThread
        val intent=Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
            .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL,RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            .putExtra(RecognizerIntent.EXTRA_LANGUAGE,"ar-YE")
            .putExtra(RecognizerIntent.EXTRA_PROMPT,"قل اسم الصنف والكمية")
        try{startActivityForResult(intent,REQ_VOICE)}
        catch(_:Exception){Toast.makeText(this,"التعرف الصوتي غير متاح على هذا الجهاز",Toast.LENGTH_LONG).show()}
    }

    fun requestContactPick() = runOnUiThread {
        try{
            val intent=Intent(Intent.ACTION_PICK, ContactsContract.CommonDataKinds.Phone.CONTENT_URI)
            startActivityForResult(intent,REQ_CONTACT)
        }catch(_:Exception){
            Toast.makeText(this,"تعذّر فتح جهات الاتصال",Toast.LENGTH_LONG).show()
        }
    }

    private fun requestScan() = runOnUiThread {
        if(isFinishing||!::web.isInitialized)return@runOnUiThread
        if(checkSelfPermission(Manifest.permission.CAMERA)==PackageManager.PERMISSION_GRANTED)
            startBarcodeScanner()
        else requestPermissions(arrayOf(Manifest.permission.CAMERA), REQ_CAMERA)
    }

    private fun startBarcodeScanner() {
        val intent=Intent(this, PortraitCaptureActivity::class.java)
            .setAction(Intents.Scan.ACTION)
            .putExtra(Intents.Scan.FORMATS,"EAN_13,EAN_8,UPC_A,UPC_E,CODE_128,CODE_39,CODE_93,ITF,QR_CODE")
            .putExtra(Intents.Scan.PROMPT_MESSAGE,"وجّه الكاميرا نحو الباركود")
            .putExtra(Intents.Scan.BEEP_ENABLED,true)
            .putExtra(Intents.Scan.ORIENTATION_LOCKED,false)
        try{startActivityForResult(intent,REQ_SCAN)}
        catch(_:Exception){Toast.makeText(this,"تعذّر فتح قارئ الباركود",Toast.LENGTH_LONG).show()}
    }

    override fun onRequestPermissionsResult(requestCode:Int, permissions:Array<out String>, grantResults:IntArray){
        if(requestCode==REQ_CAMERA){
            if(grantResults.firstOrNull()==PackageManager.PERMISSION_GRANTED)startBarcodeScanner()
            else Toast.makeText(this,"يلزم إذن الكاميرا لقراءة الباركود",Toast.LENGTH_LONG).show()
            return
        }
        super.onRequestPermissionsResult(requestCode,permissions,grantResults)
    }

    private fun finishImagePicker(value: Array<Uri>?) {
        val callback = imageCallback
        imageCallback = null // complete once; cancellation/destruction never leaves an input stuck.
        callback?.onReceiveValue(value)
    }

    private fun selectedImage(data: Intent?): Array<Uri>? {
        val uri = data?.data ?: return null
        if (uri.scheme != "content") return null
        return try {
            val type = contentResolver.getType(uri)
            val size = contentResolver.openFileDescriptor(uri, "r")?.use { it.statSize } ?: return null
            if (PilotImagePickerRules.accepts(uri.toString(), type, size)) arrayOf(uri) else null
        } catch (_: Exception) { null }
    }

    override fun onActivityResult(requestCode:Int,resultCode:Int,data:Intent?){
        if(requestCode==REQ_IMAGE){
            val value = if(resultCode==RESULT_OK && !isFinishing && ::web.isInitialized &&
                PilotImagePickerRules.trustedPage(web.url)) selectedImage(data) else null
            finishImagePicker(value)
            if(resultCode==RESULT_OK && value==null && !isFinishing)
                Toast.makeText(this,"اختر صورة JPG أو PNG أو WebP لا تزيد على 10 ميغابايت",Toast.LENGTH_LONG).show()
            return
        }

        if(requestCode==REQ_VOICE){
            val text=if(resultCode==RESULT_OK)data?.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS)?.firstOrNull()?.trim()?.take(200) else null
            if(!text.isNullOrEmpty()&&::web.isInitialized)
                web.evaluateJavascript("window.__rafiqVoice && window.__rafiqVoice("+JSONObject.quote(text)+")",null)
            return
        }
        if(requestCode==REQ_CONTACT){
            var number:String?=null
            if(resultCode==RESULT_OK){
                try{
                    val uri=data?.data
                    if(uri!=null)contentResolver.query(uri,arrayOf(ContactsContract.CommonDataKinds.Phone.NUMBER),null,null,null)?.use{ c->
                        if(c.moveToFirst())number=c.getString(0)?.trim()?.take(30)
                    }
                }catch(_:Exception){}
            }
            if(!number.isNullOrEmpty()&&::web.isInitialized)
                web.evaluateJavascript("window.__rafiqContact && window.__rafiqContact("+JSONObject.quote(number)+")",null)
            return
        }
        if(requestCode==REQ_SCAN){
            val code=if(resultCode==RESULT_OK)data?.getStringExtra(Intents.Scan.RESULT)?.trim()?.take(80) else null
            if(!code.isNullOrEmpty()&&::web.isInitialized)
                web.evaluateJavascript("window.__rafiqPilotBarcode && window.__rafiqPilotBarcode("+
                    JSONObject.quote(code)+")",null)
            return
        }
        super.onActivityResult(requestCode,resultCode,data)
    }

    fun requestPrint() = runOnUiThread {
        if (isFinishing || !::web.isInitialized) return@runOnUiThread
        try {
            val manager = getSystemService(Context.PRINT_SERVICE) as PrintManager
            manager.print("رفيق — فاتورة تجريبية",
                web.createPrintDocumentAdapter("رفيق — طباعة اختبار"),
                PrintAttributes.Builder().setMediaSize(PrintAttributes.MediaSize.ISO_A4)
                    .setColorMode(PrintAttributes.COLOR_MODE_MONOCHROME).build())
        } catch (_: Exception) {
            Toast.makeText(this, "تعذّر فتح طابعة Android", Toast.LENGTH_LONG).show()
        }
    }

    private fun forbidden(): WebResourceResponse = WebResourceResponse(
        "text/plain", "UTF-8", 403, "Forbidden", mapOf("Cache-Control" to "no-store"),
        ByteArrayInputStream(ByteArray(0)),
    )

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // 130: لوحة المفاتيح تُقصّر مساحة الواجهة حتى يبقى الحقل المكتوب فيه ظاهرًا —
        // adjustResize للنوافذ العادية، وحشو IME صريح للأندرويد 11+ (حيث قد لا يعمل مع ملء الشاشة).
        @Suppress("DEPRECATION")
        window.setSoftInputMode(android.view.WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            window.decorView.setOnApplyWindowInsetsListener { v, insets ->
                val ime = insets.getInsets(android.view.WindowInsets.Type.ime()).bottom
                web.setPadding(0, 0, 0, if (ime > 0) ime else 0)
                insets
            }
        }
        // أمر المالك (الجولة 9): إقلاع بلا إعداد سحابي = «وضع تهيئة»: الصفحة الموحدة تُفتح على شاشة
        // تهيئة الهاتف نفسها — لا حقن تهيئة، ولا أي مضيف خارجي مسموح قبل الحفظ عبر الجسر.
        val rawUrl = intent.getStringExtra(EXTRA_URL).orEmpty()
        val rawKey = intent.getStringExtra(EXTRA_KEY).orEmpty()
        val setupMode = rawUrl.isBlank() && rawKey.isBlank()
        val config: ByteArray?
        val projectHost: String?
        if (setupMode) {
            config = null
            projectHost = null
        } else {
            val url: String
            val key: String
            try {
                url = CloudConfigRules.projectUrl(rawUrl)
                key = CloudConfigRules.publishableKey(rawKey)
            } catch (_: Exception) {
                Toast.makeText(this, "تهيئة مشروع الاختبار غير صالحة", Toast.LENGTH_LONG).show()
                finish()
                return
            }
            projectHost = URI(url).host
            config = JSONObject().put("url", url).put("key", key)
                .toString().toByteArray(StandardCharsets.UTF_8)
        }
        val loader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        // Auth tokens live only in the isolated WebView's JavaScript memory; none enter an Intent.
        web = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true // random device ID and pending operation UUID only
            settings.allowFileAccess = false
            // The OS grants read access to the single user-selected content URI only.
            // File URLs stay disabled; navigation/network interception still blocks content URLs.
            settings.allowContentAccess = true
            settings.javaScriptCanOpenWindowsAutomatically = false
            settings.setSupportMultipleWindows(false)
            settings.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            addJavascriptInterface(PilotPrintBridge(this@CloudPilotActivity), "RafiqPilotPrint")
            addJavascriptInterface(PilotScannerBridge(this@CloudPilotActivity), "RafiqPilotScanner")
            addJavascriptInterface(PilotContactsBridge(this@CloudPilotActivity), "RafiqPilotContacts")
            addJavascriptInterface(PilotVoiceBridge(this@CloudPilotActivity), "RafiqPilotVoice")
            addJavascriptInterface(PilotLockBridge(AppLock(this@CloudPilotActivity).also { appLock = it }), "RafiqAppLock")
            // 6أ: جسر المزامنة الموحدة (طابور/مرآة/SMS/تصدير/أرشيف) — لا دفتر محلي قديم.
            addJavascriptInterface(net.arena.rafiq.cloud.CloudNativeBridge(this@CloudPilotActivity, net.arena.rafiq.data.RafiqDatabase.build(applicationContext)), "NativeApi")
            webChromeClient = object : WebChromeClient() {
                override fun onShowFileChooser(
                    view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams,
                ): Boolean {
                    // Do not replace a chooser already on screen: that could route its result
                    // into a different field. The new request is explicitly cancelled instead.
                    if(imageCallback!=null || isFinishing ||
                        !PilotImagePickerRules.trustedPage(view.url) ||
                        params.mode!=FileChooserParams.MODE_OPEN){
                        callback.onReceiveValue(null)
                        return true
                    }
                    imageCallback=callback
                    val picker=Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                        addCategory(Intent.CATEGORY_OPENABLE)
                        type="image/*"
                        putExtra(Intent.EXTRA_MIME_TYPES,PilotImagePickerRules.MIME_TYPES)
                        putExtra(Intent.EXTRA_ALLOW_MULTIPLE,false)
                        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                    }
                    try{startActivityForResult(picker,REQ_IMAGE)}
                    catch(_:Exception){
                        finishImagePicker(null)
                        Toast.makeText(this@CloudPilotActivity,"تعذّر فتح الصور على هذا الهاتف",Toast.LENGTH_LONG).show()
                    }
                    return true
                }
            }
            webViewClient = object : WebViewClient() {
                override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                    val uri = request.url
                    if (uri.scheme == "https" && uri.host == ASSET_HOST &&
                        uri.port == -1 && uri.userInfo == null) {
                        if (uri.path == "/rafiq-config") return if (config == null) WebResourceResponse(
                            // وضع التهيئة (الجولة 9): لا تهيئة محفوظة — 404 صريح فتعرض الصفحة الموحدة
                            // شاشة إدخال الرابط والمفتاح العام نفسها.
                            "application/json", "UTF-8", 404, "Not Found",
                            mapOf("Cache-Control" to "no-store"),
                            ByteArrayInputStream(ByteArray(0)),
                        ) else WebResourceResponse(
                            "application/json", "UTF-8", 200, "OK",
                            mapOf("Cache-Control" to "no-store", "X-Content-Type-Options" to "nosniff"),
                            ByteArrayInputStream(config),
                        )
                        // Some older Android MIME maps do not recognise .mjs as a module.
                        if (uri.path == "/assets/pilot/lib.mjs") {
                            val module = try { this@CloudPilotActivity.assets.open("pilot/lib.mjs") }
                                catch (_: IOException) { return forbidden() }
                            return WebResourceResponse("text/javascript", "UTF-8", module)
                        }
                        if (uri.path?.startsWith("/assets/pilot/") == true) {
                            return loader.shouldInterceptRequest(uri) ?: forbidden()
                        }
                        return forbidden()
                    }
                    // Reject any unapproved third-party request even if HTML/CSP changes later.
                    // وضع التهيئة (بلا تكوين): لا مضيف خارجي مسموح إطلاقًا — التحقق محلي والحفظ عبر الجسر.
                    return if (projectHost != null && uri.scheme == "https" && uri.host == projectHost &&
                        uri.port == -1 && uri.userInfo == null) null else forbidden()
                }

                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                    val uri = request.url
                    return uri.scheme != "https" || uri.host != ASSET_HOST ||
                        uri.port != -1 || uri.userInfo != null ||
                        uri.path?.startsWith("/assets/pilot/") != true
                }
            }
        }
        setContentView(web)
        if (::appLock.isInitialized) appLock.lockOnStart()
        web.loadUrl(START_URL)
    }

    override fun onDestroy() {
        finishImagePicker(null)
        if (::web.isInitialized) {
            web.stopLoading()
            web.loadUrl("about:blank")
            web.removeAllViews()
            web.destroy()
        }
        super.onDestroy()
    }
}
