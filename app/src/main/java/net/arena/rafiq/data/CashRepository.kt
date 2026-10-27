package net.arena.rafiq.data

import net.arena.rafiq.domain.CashRules

/**
 * درج النقود: الوردية، والحركات اليدوية، وإغلاق الوردية بالفارق.
 * مطابق لـ cash_open و cash_close و _manual_cash_movement في النسخة الأصلية.
 */
class CashRepository(private val db: RafiqDatabase) {

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

    /** الوردية المفتوحة الآن، أو null. */
    fun openShift(): ShiftEntity? = db.shifts().getOpen()

    /** يفتح وردية بعهدة ابتدائية. لا تُفتح ثانية أثناء وجود وردية مفتوحة. */
    fun open(openingCents: Long, userId: Long): RepoResult<Long> {
        if (openingCents < 0L) return RepoResult.Failed("عهدة الافتتاح يجب ألا تكون سالبة")
        if (db.shifts().getOpen() != null) {
            return RepoResult.Failed("يوجد وردية مفتوحة أصلاً")
        }
        val id = tx {
            val sid = db.shifts().insert(ShiftEntity(openedBy = userId, openingCents = openingCents))
            db.cashMovements().insert(
                CashMovementEntity(shiftId = sid, kind = "open", amountCents = openingCents,
                    note = "بداية الوردية", userId = userId)
            )
            sid
        }
        return RepoResult.Ok(id)
    }

    /** المتوقع في الدرج الآن = مجموع حركات الوردية المفتوحة. */
    fun expectedNow(): Long? = openShift()?.let { db.cashMovements().sumForShift(it.id) }

    /**
     * حركة يدوية: «income» دخل، «expense» مصروف، «withdraw» سحب للمالك فقط.
     * الترتيب: المبلغ، ثم السبب، ثم الوردية، ثم الصلاحية (كما في النسخة الأصلية).
     */
    fun manualMovement(
        kind: String,
        amountCents: Long?,
        reason: String,
        note: String,
        userId: Long,
    ): RepoResult<Long> {
        val isIncome = kind == "income"
        val allowed = if (isIncome) CashRules.REASONS_IN else CashRules.REASONS_OUT
        CashRules.validateManualMovement(amountCents, reason, allowed)?.let { return RepoResult.Failed(it) }
        val shift = openShift() ?: return RepoResult.Failed("افتح الوردية أولاً")
        val user = db.users().getById(userId) ?: return RepoResult.Failed("المستخدم غير موجود")
        if (kind == "withdraw" && user.role != "owner") {
            return RepoResult.Failed("هذه الحركة للمالك فقط")
        }
        val sign = if (isIncome) 1L else -1L
        val id = db.cashMovements().insert(
            CashMovementEntity(
                shiftId = shift.id,
                kind = kind,
                amountCents = sign * amountCents!!,
                reason = reason.trim(),
                note = note.trim(),
                userId = userId,
            )
        )
        return RepoResult.Ok(id)
    }

    /**
     * إغلاق الوردية: يُحسب الفارق = المعدود − المتوقع.
     * إذا وُجد فارق يجب اختيار سببه من قائمة الفروقات.
     */
    fun close(countedCents: Long?, differenceReason: String, userId: Long): RepoResult<Long> {
        val shift = openShift() ?: return RepoResult.Failed("لا توجد وردية مفتوحة")
        if (countedCents == null) return RepoResult.Failed("اكتب المبلغ الموجود فعلياً في الدرج")
        val expected = db.cashMovements().sumForShift(shift.id)
        val diff = CashRules.difference(countedCents, expected)
        val reason = differenceReason.trim()
        if (!CashRules.canCloseShift(diff, reason)) {
            return RepoResult.Failed("يوجد فارق في الدرج — اختر سببه قبل الإغلاق")
        }
        val updated = tx {
            db.shifts().close(shift.id, userId, expected, countedCents, diff, reason)
        }
        if (updated != 1) return RepoResult.Failed("تعذّر إغلاق الوردية")
        return RepoResult.Ok(diff)
    }
}
