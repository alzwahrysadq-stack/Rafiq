package net.arena.rafiq.domain

/**
 * كشف حساب الزبون بالأسلوب الكناشي، مطابق لـ customer_detail في النسخة الأصلية.
 * كل سطر يحمل «الرصيد بعده». الحساب يبدأ من الأقدم، ثم يُعرض الأحدث أولاً.
 */
object CustomerStatement {

    // الرصيد الدائن الافتتاحي ليس دفعة نقدية؛ يحتسب كائتمان للزبون مع تمييزه في الكشف.
    enum class Kind { GIVEN, TAKEN, OPENING_CREDIT }

    data class InvoiceLine(val id: Long, val number: Long, val createdAt: String, val dueCents: Long,
                           val paidCents: Long, val status: String, val userName: String? = null)
    data class LedgerLine(val id: Long, val createdAt: String, val amountCents: Long, val note: String,
                          val userName: String? = null)
    data class PaymentLine(val id: Long, val createdAt: String, val amountCents: Long, val note: String,
                           val userName: String?)

    data class Event(
        val ts: String,
        val kind: Kind,
        val amountCents: Long,
        val note: String,
        val balanceAfterCents: Long,
        val invoiceId: Long? = null,
        val userName: String? = null,
    )

    private const val OPENING_TS = "0001-01-01 00:00:00"

    fun build(
        openingCents: Long,
        invoices: List<InvoiceLine>,
        ledger: List<LedgerLine>,
        payments: List<PaymentLine>,
    ): List<Event> {
        // ترتيب النوع مستقل عن طول سجل كل جدول؛ جمع الرقم مع 100/200 يتعطّل بعد مئات الحركات.
        data class Raw(val ts: String, val kindOrder: Int, val id: Long, val event: Event)
        val raw = ArrayList<Raw>()

        if (openingCents != 0L) {
            require(openingCents != Long.MIN_VALUE) { "رصيد افتتاحي خارج الحد الآمن" }
            val credit = openingCents < 0L
            raw.add(Raw(OPENING_TS, 0, 0L, Event(OPENING_TS,
                if (credit) Kind.OPENING_CREDIT else Kind.GIVEN,
                if (credit) -openingCents else openingCents,
                if (credit) "رصيد افتتاحي لصالح الزبون (ليس دفعة نقدية)" else "رصيد سابق (مُرحَّل من الكناش)",
                0L)))
        }
        for (inv in invoices) {
            if (inv.status != "open" || inv.dueCents == 0L) continue
            var note = "فاتورة رقم ${inv.number}"
            if (inv.paidCents != 0L) note += " (دُفع مقدماً ${net.arena.rafiq.domain.Money.format(inv.paidCents)})"
            raw.add(Raw(inv.createdAt, 1, inv.id,
                Event(inv.createdAt, Kind.GIVEN, inv.dueCents, note, 0L,
                    invoiceId = inv.id, userName = inv.userName)))
        }
        for (l in ledger) {
            raw.add(Raw(l.createdAt, 2, l.id,
                Event(l.createdAt, Kind.GIVEN, l.amountCents, l.note.ifEmpty { "دين يدوي" }, 0L,
                    userName = l.userName)))
        }
        for (p in payments) {
            raw.add(Raw(p.createdAt, 3, p.id,
                Event(p.createdAt, Kind.TAKEN, p.amountCents, p.note.ifEmpty { "دفعة نقدية" }, 0L,
                    userName = p.userName)))
        }

        val ordered = raw.sortedWith(compareBy<Raw> { it.ts }.thenBy { it.kindOrder }.thenBy { it.id })
        var running = 0L
        val withBalance = ordered.map { r ->
            running += if (r.event.kind == Kind.GIVEN) r.event.amountCents else -r.event.amountCents
            r.event.copy(balanceAfterCents = running)
        }
        return withBalance.reversed()
    }
}
