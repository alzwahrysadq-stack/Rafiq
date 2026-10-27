package net.arena.rafiq.domain

/**
 * قواعد الزبائن والديون، مطابقة لـ BALANCE_SQL و customer_debit و customer_pay في النسخة الأصلية.
 */
object CustomerRules {

    /**
     * رصيد الزبون (الدين عليه) بوحدة 1/100 من الريال:
     * الدين المرحّل + الفواتير المفتوحة غير المدفوعة + حركات «أعطيت» − الدفعات.
     */
    fun balance(
        openingCents: Long,
        openInvoiceDueCents: Long,
        ledgerDebitsCents: Long,
        paymentsCents: Long,
    ): Long = openingCents + openInvoiceDueCents + ledgerDebitsCents - paymentsCents

    /** تسجيل دين «أعطيت» بلا فاتورة. يعيد رسالة الخطأ أو null. */
    fun validateDebit(amountCents: Long?): String? =
        if (amountCents == null || amountCents <= 0L) "اكتب مبلغاً صحيحاً" else null

    /**
     * تسجيل دفعة من الزبون. الترتيب مهم: المبلغ أولاً ثم الوردية، كما في النسخة الأصلية.
     * يعيد رسالة الخطأ أو null.
     */
    fun validatePayment(amountCents: Long?, shiftOpen: Boolean): String? {
        if (amountCents == null || amountCents <= 0L) return "اكتب مبلغاً صحيحاً"
        if (!shiftOpen) {
            return "الصندوق مغلق — افتح الوردية أولاً حتى تُسجَّل التحصيلات في الصندوق"
        }
        return null
    }
}
