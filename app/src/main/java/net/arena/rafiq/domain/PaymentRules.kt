package net.arena.rafiq.domain

/**
 * طرق الدفع داخل الفاتورة. النقد يدخل الدرج، أما الحوالة والمحفظة والإيداع فتُسجَّل
 * بمرجعها وتظهر منفصلة عند إغلاق الوردية، ولا تدخل الدرج. الدين هو المتبقي على الزبون.
 */
object PaymentRules {

    val NON_CASH: List<String> = listOf("transfer", "wallet", "deposit")

    val LABELS: Map<String, String> = mapOf(
        "cash" to "نقد",
        "transfer" to "حوالة",
        "wallet" to "محفظة",
        "deposit" to "إيداع",
        "debt" to "دين",
    )

    /** جزء دفع غير نقدي كما يُدخله الكاشير. */
    data class Part(val method: String, val amountCents: Long, val reference: String)

    /** يتحقق من الأجزاء غير النقدية. يعيد رسالة خطأ بالعربية أو null إذا كانت سليمة. */
    fun validateNonCash(parts: List<Part>): String? {
        for (p in parts) {
            if (p.method !in NON_CASH) return "طريقة دفع غير صحيحة"
            if (p.amountCents <= 0L) return "مبلغ ${LABELS[p.method]} يجب أن يكون أكبر من صفر"
            val ref = p.reference.trim()
            if (ref.isEmpty()) return "أدخل رقم مرجع ${LABELS[p.method]}"
            if (ref.length > 40) return "رقم مرجع ${LABELS[p.method]} طويل جداً"
        }
        return null
    }

    fun sumNonCash(parts: List<Part>): Long = parts.sumOf { it.amountCents }
}
