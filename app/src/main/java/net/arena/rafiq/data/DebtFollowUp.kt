package net.arena.rafiq.data

import net.arena.rafiq.domain.SupplierRules

/**
 * معيار متابعة قابل للضبط، وليس تاريخ استحقاق أو حكماً قانونياً بالتعثر:
 * بعد N أيام من أقدم مبلغ ما زال غير مسدّد، مع احتساب دفعات الزبون للأقدم أولاً.
 * الدين المرحّل يُنسب إلى تاريخ إنشاء ملف الزبون (قد يكون أقدم من الاستيراد اللاحق).
 */
object DebtFollowUp {
    data class Alert(val customer: CustomerEntity, val balanceCents: Long, val oldestDate: String, val ageDays: Int)

    fun oldestUnpaidDate(db: RafiqDatabase, customer: CustomerEntity): String? {
        val charges = ArrayList<Pair<String, Long>>()
        if (customer.openingCents > 0) charges.add(customer.createdAt to customer.openingCents)
        for (invoice in db.sales().debtInvoices(customer.id)) {
            charges.add(invoice.createdAt to invoice.dueCents)
        }
        var credit = db.payments().getByCustomer(customer.id).sumOf { it.amountCents.coerceAtLeast(0) }
        for (entry in db.ledger().getByCustomer(customer.id)) {
            if (entry.amountCents > 0) charges.add(entry.createdAt to entry.amountCents)
            else credit -= entry.amountCents
        }
        if (charges.sumOf { it.second } <= credit) return null
        for ((at, amount) in charges.sortedBy { it.first }) {
            if (credit >= amount) credit -= amount
            else return at.take(10)
        }
        return null
    }

    fun alert(db: RafiqDatabase, customer: CustomerEntity, balanceCents: Long,
              todayIso: String, daysThreshold: Int): Alert? {
        if (balanceCents <= 0L) return null
        val oldest = oldestUnpaidDate(db, customer) ?: return null
        val age = SupplierRules.daysSince(oldest, todayIso) ?: return null
        return if (age >= daysThreshold) Alert(customer, balanceCents, oldest, age) else null
    }
}
