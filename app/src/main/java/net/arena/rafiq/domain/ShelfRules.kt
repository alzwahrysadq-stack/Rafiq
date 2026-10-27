package net.arena.rafiq.domain

/**
 * قواعد المخزون والرف، مطابقة لـ loc_text و save_product و find_item في النسخة الأصلية.
 */
object ShelfRules {

    /** نص الموقع للعرض: «ممر 3 • رف ب»، أو «ممر 2»، أو «رف ج»، أو فارغ. */
    fun locationText(aisle: String?, shelf: String?): String {
        val a = aisle?.trim().orEmpty()
        val s = shelf?.trim().orEmpty()
        return when {
            a.isNotEmpty() && s.isNotEmpty() -> "ممر $a • رف $s"
            a.isNotEmpty() -> "ممر $a"
            s.isNotEmpty() -> "رف $s"
            else -> ""
        }
    }

    /**
     * يفهم عبارة البحث بالموقع: «ممر 3» أو «رف ب» أو «3» وحدها.
     * يعيد الرمز (مثل «3» أو «أ») إذا كانت العبارة موقعاً، وإلا null.
     */
    fun parseLocationQuery(query: String): String? {
        val match = LOCATION_QUERY.matchEntire(query.trim()) ?: return null
        return match.groupValues[1]
    }

    /** نص الصنف الفارغ من الاسم غير مقبول. */
    fun validateProductName(name: String?): String? =
        if (name.isNullOrBlank()) "اسم الصنف مطلوب" else null

    /**
     * يحوّل الكمية أو الحد الأدنى بأمان، كما _to_float:
     * القيم الفارغة أو غير الرقمية تعيد القيمة الافتراضية.
     */
    fun toFloatOr(raw: String?, default: Double): Double {
        if (raw == null) return default
        val s = raw.trim()
        if (s.isEmpty()) return default
        return s.toDoubleOrNull() ?: default
    }

    /** الصنف منخفض الرصيد إذا كان الرصيد أقل من الحد أو يساويه. */
    fun isLowStock(stock: Double, lowStock: Double): Boolean = stock <= lowStock

    /**
     * يطابق صنفاً مع عبارة بحث بالاسم أو الباركود (حساسية الحروف لا تهم).
     */
    fun matchesNameOrBarcode(query: String, name: String, barcode: String?): Boolean {
        val q = query.trim()
        if (q.isEmpty()) return false
        return name.contains(q, ignoreCase = true) ||
            (barcode?.contains(q, ignoreCase = true) == true)
    }

    /** يطابق موقع صنف مع رمز الموقع (ممر أو رف). */
    fun matchesLocationCode(code: String, aisle: String?, shelf: String?): Boolean =
        aisle?.trim() == code || shelf?.trim() == code

    private val LOCATION_QUERY = Regex("""^(?:ممر|رف)?\s*(\p{Nd}+[أ-يA-Za-z]?)$""")
}
