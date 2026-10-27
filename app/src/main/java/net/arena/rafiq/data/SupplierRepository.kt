package net.arena.rafiq.data

import net.arena.rafiq.domain.ReportRules
import net.arena.rafiq.domain.SupplierRules

/** طبقة الموردين والمندوبين فوق قاعدة البيانات. */
class SupplierRepository(private val db: RafiqDatabase) {

    private inline fun <T> tx(block: () -> T): T {
        db.beginTransaction()
        try {
            val result = block()
            db.setTransactionSuccessful()
            return result
        } finally {
            db.endTransaction()
        }
    }

    /** الرصيد = ما علينا له الآن. */
    fun balance(supplierId: Long): Long {
        val q = db.supplierQueries()
        return SupplierRules.balance(
            receivedCents = q.sumKind(supplierId, "receive"),
            paidCents = q.sumKind(supplierId, "pay"),
            returnedCents = q.sumKind(supplierId, "return"),
        )
    }

    /** المورد النشط فقط؛ الموقوف لا يقبل حركات (كما النسخة الأصلية). */
    private fun activeSupplier(supplierId: Long): SupplierEntity? =
        db.supplierQueries().byId(supplierId)?.takeIf { it.active == 1 }

    /** تعديل البيانات الأساسية للمورد (للمالك). الاسم الفارغ يبقي القديم. */
    fun updateDetails(
        supplierId: Long, name: String, phone: String, kind: String, periodicity: String,
        goods: String, returnable: Boolean, note: String,
    ): RepoResult<Unit> {
        val old = db.supplierQueries().byId(supplierId) ?: return RepoResult.Failed("المورد غير موجود")
        db.supplierQueries().updateDetails(
            supplierId,
            name = name.trim().ifEmpty { old.name },
            phone = phone.trim(), kind = kind, periodicity = periodicity,
            goods = goods.trim(), returnable = if (returnable) 1 else 0, note = note.trim(),
        )
        return RepoResult.Ok(Unit)
    }

    /** استلام بضاعة: يزيد ما علينا له، ويُحسب زيارة. */
    fun receive(supplierId: Long, amountCents: Long?, note: String, userId: Long, ref: String = ""): RepoResult<Unit> {
        SupplierRules.validAmount(amountCents) ?: return RepoResult.Failed("اكتب مبلغاً صحيحاً")
        activeSupplier(supplierId) ?: return RepoResult.Failed("المورد غير موجود")
        tx {
            db.supplierTransactions().insert(
                SupplierTransactionEntity(
                    supplierId = supplierId, kind = "receive", amountCents = amountCents!!,
                    note = note.trim(), invoiceRef = ref.trim(), userId = userId,
                )
            )
            db.supplierQueries().touch(supplierId)
        }
        return RepoResult.Ok(Unit)
    }

    /** سداد نقدي: للمالك فقط، ويحتاج وردية مفتوحة، ويخرج من الدرج. */
    fun pay(supplierId: Long, amountCents: Long?, note: String, userId: Long): RepoResult<Unit> {
        val user = db.users().getById(userId) ?: return RepoResult.Failed("المستخدم غير موجود")
        val shift = db.shifts().getOpen()
        SupplierRules.validatePay(amountCents, isOwner = user.role == "owner", shiftOpen = shift != null)
            ?.let { return RepoResult.Failed(it) }
        val sup = activeSupplier(supplierId) ?: return RepoResult.Failed("المورد غير موجود")
        val amount = amountCents!!
        val cleanNote = note.trim()
        tx {
            db.supplierTransactions().insert(
                SupplierTransactionEntity(
                    supplierId = supplierId, kind = "pay", amountCents = amount,
                    note = cleanNote, userId = userId, shiftId = shift!!.id,
                )
            )
            db.cashMovements().insert(
                CashMovementEntity(
                    shiftId = shift.id, kind = "supplier_pay", amountCents = -amount,
                    note = "سداد: ${sup.name}", refType = "supplier", refId = supplierId, userId = userId,
                )
            )
            db.supplierQueries().touch(supplierId)
        }
        return RepoResult.Ok(Unit)
    }

    /** مرتجع فائض: للبنود القابلة للرجعة فقط. */
    fun returnGoods(supplierId: Long, amountCents: Long?, note: String, userId: Long): RepoResult<Unit> {
        val sup = activeSupplier(supplierId) ?: return RepoResult.Failed("المورد غير موجود")
        SupplierRules.validateReturn(amountCents, returnable = sup.returnable == 1, name = sup.name)
            ?.let { return RepoResult.Failed(it) }
        tx {
            db.supplierTransactions().insert(
                SupplierTransactionEntity(
                    supplierId = supplierId, kind = "return", amountCents = amountCents!!,
                    note = note.trim().ifEmpty { "مرتجع فائض" }, userId = userId,
                )
            )
            db.supplierQueries().touch(supplierId)
        }
        return RepoResult.Ok(Unit)
    }

    /** زيارة بلا شراء («مرّ اليوم»). */
    fun visit(supplierId: Long, userId: Long): RepoResult<Unit> {
        activeSupplier(supplierId) ?: return RepoResult.Failed("المورد غير موجود")
        tx {
            db.supplierVisits().insert(SupplierVisitEntity(supplierId = supplierId, userId = userId))
            db.supplierQueries().touch(supplierId)
        }
        return RepoResult.Ok(Unit)
    }

    /**
     * إيقاف التعامل لا يُسمح إلا إذا كان الحساب مصفّى. إعادة التفعيل مسموحة دائماً.
     */
    fun setActive(supplierId: Long, active: Boolean): RepoResult<Unit> {
        val sup = db.supplierQueries().byId(supplierId) ?: return RepoResult.Failed("المورد غير موجود")
        if (!active) {
            SupplierRules.validateDeactivate(sup.name, balance(supplierId))?.let { return RepoResult.Failed(it) }
        }
        db.supplierQueries().setActive(supplierId, if (active) 1 else 0)
        return RepoResult.Ok(Unit)
    }

    /** قائمة «المتوقع اليوم» للمناديب والموردين النشطين، المتأخر أولاً. */
    fun dueList(todayIso: String): ReportRules.DashboardDueCounts {
        val items = db.supplierQueries().activeList().map { s ->
            val days = SupplierRules.daysSince(s.lastVisitAt, todayIso)
            val flags = SupplierRules.delegateFlags(
                isDelegate = s.kind == "delegate", active = s.active == 1,
                periodicity = s.periodicity, daysSinceVisit = days,
            )
            ReportRules.DueItem(
                name = s.name, isDelegate = s.kind == "delegate",
                overdue = flags.overdue, daysSinceVisit = days,
            ) to flags.dueToday
        }
        val due = items.filter { it.second }.map { it.first }
        return ReportRules.dueCounts(ReportRules.sortDue(due))
    }
}
