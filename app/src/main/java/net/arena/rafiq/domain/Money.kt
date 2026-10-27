package net.arena.rafiq.domain

import kotlin.math.abs

/**
 * قواعد المال في رفيق.
 * كل المبالغ تُخزَّن داخلياً بوحدة 1/100 من الريال (أعداد صحيحة)، والعرض بالريال الكامل فقط.
 * القاعدة: التقريب إلى أقرب ريال، والنصف يُقرَّب للأعلى.
 */
object Money {

    /** ريال واحد = 100 قرش داخلياً. */
    const val MINOR: Long = 100L

    /** يقرّب المبلغ (بوحدة 1/100 من الريال) إلى أقرب ريال كامل، والنصف للأعلى. */
    fun toWhole(cents: Long): Long {
        val sign = if (cents < 0) -1L else 1L
        val a = abs(cents)
        return sign * (((a + MINOR / 2) / MINOR) * MINOR)
    }

    /**
     * يحوّل نصاً مثل «1,250» أو «١٢٥» أو «12.5» إلى وحدة 1/100 من الريال، ويقرّبه إلى ريال كامل.
     * يعيد [default] إذا كان النص فارغاً أو غير صالح.
     */
    fun parse(raw: String?, default: Long? = null): Long? {
        if (raw == null) return default
        var s = raw.trim()
            .replace(",", "")
            .replace("\u066C", "") // فاصل الآلاف العربي ٬
            .replace("\u066B", ".") // الفاصلة العشرية العربية ٫
        if (s.isEmpty()) return default
        s = translateArabicDigits(s)
        s = s.filter { it.isDigit() || it == '.' || it == '-' }
        if (s.isEmpty() || s == "-" || s == ".") return default
        val value = s.toDoubleOrNull() ?: return default
        // Math.rint = تقريب المصرفي، مثل round() في بايثون، لنفس النتائج تماماً
        val cents = Math.rint(value * MINOR).toLong()
        return toWhole(cents)
    }

    /** يعرض المبلغ بالريال الكامل بفواصل الآلاف: 512000 قرش → "5,120". */
    fun format(cents: Long): String {
        val sign = if (cents < 0) "-" else ""
        val rials = abs(cents) / MINOR
        val digits = rials.toString()
        val grouped = StringBuilder()
        for ((i, ch) in digits.withIndex()) {
            if (i > 0 && (digits.length - i) % 3 == 0) grouped.append(',')
            grouped.append(ch)
        }
        return sign + grouped.toString()
    }

    private fun translateArabicDigits(s: String): String {
        val arabic = "٠١٢٣٤٥٦٧٨٩"
        return buildString(s.length) {
            for (ch in s) {
                val idx = arabic.indexOf(ch)
                append(if (idx >= 0) ('0' + idx) else ch)
            }
        }
    }
}
