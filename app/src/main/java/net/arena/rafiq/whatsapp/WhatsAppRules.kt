package net.arena.rafiq.whatsapp

import org.json.JSONArray
import org.json.JSONObject

/**
 * قواعد واتساب النقية (بلا شبكة): متى يُرسل، وتطبيع الرقم، وبناء رسالة القالب.
 * الإرسال الفعلي عبر واجهة Cloud API الرسمية من Meta، ويحتاج بيانات المالك.
 */
object WhatsAppRules {

    /** يُرسل تلقائياً فقط عند البيع الآجل الذي بقي فيه دين. */
    fun needsSend(paymentType: String, dueCents: Long): Boolean =
        paymentType == "credit" && dueCents > 0

    /**
     * يحوّل الرقم إلى الصيغة الدولية بلا «+» أو مسافات.
     * 00 تُحذف، والصفر الأول يُستبدل بمفتاح الدولة، والرقم القصير يأخذ مفتاح الدولة.
     */
    fun normalizePhone(raw: String, countryCode: String): String? {
        var d = raw.filter { it.isDigit() }
        val cc = countryCode.filter { it.isDigit() }
        when {
            d.startsWith("00") -> d = d.substring(2)
            d.startsWith("0") -> d = cc + d.substring(1)
            d.length <= 9 -> d = cc + d
        }
        return d.takeIf { it.length in 8..15 }
    }

    /** نص معاينة محلي لرسالة فاتورة آجلة؛ لا إرسال هنا. */
    fun previewBody(totalText: String, debtText: String): String =
        "فاتورة آجلة: الإجمالي $totalText، وإجمالي الدين حتى اليوم $debtText"

    /**
     * رسالة قالب بوثيقة في الترويسة (PDF) ومتغيّرين في النص:
     * {{1}} إجمالي الفاتورة، {{2}} إجمالي الدين حتى اليوم.
     */
    fun templatePayload(
        to: String,
        template: String,
        languageCode: String,
        mediaId: String,
        fileName: String,
        totalText: String,
        debtText: String,
    ): JSONObject = JSONObject()
        .put("messaging_product", "whatsapp")
        .put("recipient_type", "individual")
        .put("to", to)
        .put("type", "template")
        .put(
            "template",
            JSONObject()
                .put("name", template)
                .put("language", JSONObject().put("code", languageCode))
                .put(
                    "components",
                    JSONArray()
                        .put(
                            JSONObject().put("type", "header").put(
                                "parameters",
                                JSONArray().put(
                                    JSONObject().put("type", "document")
                                        .put("document", JSONObject().put("id", mediaId).put("filename", fileName)),
                                ),
                            ),
                        )
                        .put(
                            JSONObject().put("type", "body").put(
                                "parameters",
                                JSONArray()
                                    .put(JSONObject().put("type", "text").put("text", totalText))
                                    .put(JSONObject().put("type", "text").put("text", debtText)),
                            ),
                        ),
                ),
        )
}
