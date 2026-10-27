package net.arena.rafiq.sms

/** قواعد نقية قابلة للاختبار دون أندرويد: مقاطع UCS2، تقسيم، أهلية السحب، خرائط الحالات. */
object SmsRules {
    // نصوص عربية = UCS2: 70 حرفًا للمقطع الواحد، 67 لكل مقطع عند التعدد.
    fun segments(body: String): Int =
        if (body.length <= 70) 1 else (body.length + 66) / 67

    fun splitParts(body: String): List<String> {
        if (body.length <= 70) return listOf(body)
        return body.chunked(67)
    }

    /** السحب ممكن فقط داخل تطبيق أندرويد المضمّن، وعلى الجهاز المعيّن نفسه، وبدون إيقاف. */
    fun canClaim(embedded: Boolean, senderDevice: String?, device: String?, paused: Boolean): Boolean =
        embedded && senderDevice != null && senderDevice == device && !paused

    /** قبول الهاتف ليس إثبات وصول؛ delivered تأتي من بث التسليم فقط. */
    fun mapSendResult(sentOk: Boolean, error: String?): String = when {
        sentOk -> "submitted"
        error in setOf("NO_SERVICE", "RADIO_OFF", "PERMANENT_FAILURE") -> "failed"
        else -> "unknown"
    }
}
