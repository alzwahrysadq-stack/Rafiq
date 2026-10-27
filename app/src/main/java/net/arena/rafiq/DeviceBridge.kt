package net.arena.rafiq

import android.webkit.JavascriptInterface

/**
 * جسر الأجهزة للواجهة (window.RafiqDevice): الطباعة، وفتح الروابط (واتساب)، والكاميرا،
 * وحفظ الملفات، والأوامر الصوتية. يستدعيه engine.js فقط حين يعمل داخل التطبيق.
 */
class DeviceBridge(private val activity: MainActivity) {
    @JavascriptInterface
    fun print() = activity.printPage()

    /** يفتح واجهة Pilot محلية منفصلة بلا RafiqNative ولا وصول إلى Room. */
    @JavascriptInterface
    fun openPilot() = activity.openPilot()

    @JavascriptInterface
    fun openUrl(url: String) = activity.openExternal(url)

    @JavascriptInterface
    fun scan() = activity.scanBarcode()

    /** يظهر للمالك زمن فتح المعاينة وزمن التركيز/القراءة لآخر مسح؛ دون حفظ الباركود. */
    @JavascriptInterface
    fun scanDiagnostics(): String = ScanTiming.diagnostics()

    @JavascriptInterface
    fun saveText(name: String, text: String) = activity.saveText(name, text)

    @JavascriptInterface
    fun listen() = activity.listenVoice()

    /** مشاركة PDF عبر نافذة الهاتف؛ لا يعني استدعاء هذه الدالة أن الرسالة أُرسلت. */
    @JavascriptInterface
    fun shareInvoicePdf(invoiceId: Long) = activity.shareInvoicePdf(invoiceId)

    @JavascriptInterface
    fun pickContact() = activity.pickContact()

    /** نسخ وفحص للمالك فقط؛ العبارة تمر في الذاكرة ولا تُحفظ أو تُرسل إلى خادم. */
    @JavascriptInterface
    fun backupExport(passphrase: String): Boolean = activity.beginBackupExport(passphrase)

    @JavascriptInterface
    fun backupInspect(passphrase: String): Boolean = activity.beginBackupInspect(passphrase)

    /** رقم البناء: تعرضه الواجهة لنعرف أن الهاتف يعمل بالنسخة الجديدة */
    @JavascriptInterface
    fun version(): String = activity.buildNumber()
}
