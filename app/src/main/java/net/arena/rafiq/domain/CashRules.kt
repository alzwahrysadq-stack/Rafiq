package net.arena.rafiq.domain

/**
 * قواعد درج النقود، مطابقة لنسخة بايثون (app.py).
 * دوال نقية بلا قاعدة بيانات، حتى تُختبر بسرعة.
 */
object CashRules {

    /** أسباب الدخل اليدوي للدرج. */
    val REASONS_IN: List<String> = listOf(
        "فكّة للدرج", "إيداع من المالك", "دخل متنوع", "استرجاع من مورد", "أخرى"
    )

    /** أسباب المصروف اليدوي من الدرج. */
    val REASONS_OUT: List<String> = listOf(
        "مصروف متجر", "فكّة أعطيت", "سحب للمالك", "شراء بضاعة نقداً", "أخرى"
    )

    /** أسباب الفارق عند إغلاق الوردية. */
    val REASONS_DIFF: List<String> = listOf(
        "خطأ في العدّ", "نسيان تسجيل حركة", "فكّة ناقصة/زائدة", "سلفة مؤقتة", "أخرى"
    )

    /** فئات النقود للعدّ، بالريال. */
    val DENOMINATIONS: List<Int> = listOf(1000, 500, 250, 200, 100, 50, 20, 10, 5, 1)

    /** المتوقع في الدرج = مجموع كل حركات الوردية (بوحدة 1/100 من الريال). */
    fun expectedFromMovements(amountsCents: List<Long>): Long = amountsCents.sum()

    /** الفارق = المعدود - المتوقع. موجب = زيادة، سالب = عجز. */
    fun difference(countedCents: Long, expectedCents: Long): Long = countedCents - expectedCents

    /**
     * يسمح بإغلاق الوردية؟
     * إذا كان هناك فارق، يجب اختيار سبب من قائمة الفارق.
     */
    fun canCloseShift(differenceCents: Long, reason: String?): Boolean {
        if (differenceCents == 0L) return true
        return reason?.trim() in REASONS_DIFF
    }

    /**
     * يتحقق من حركة يدوية قبل تسجيلها.
     * يعيد رسالة الخطأ بالعربية، أو null إذا كانت الحركة صالحة.
     */
    fun validateManualMovement(
        amountCents: Long?,
        reason: String?,
        allowedReasons: List<String>,
    ): String? {
        if (amountCents == null || amountCents <= 0L) {
            return "اكتب مبلغاً صحيحاً أكبر من صفر"
        }
        if (reason?.trim() !in allowedReasons) {
            return "اختر سبباً من القائمة — لا تُسجَّل حركة بلا سبب"
        }
        return null
    }
}
