package net.arena.rafiq.data

import net.arena.rafiq.domain.KnaashReviewRules
import org.json.JSONArray
import org.json.JSONObject

/**
 * يحفظ اختيارات مراجعة هوية العملاء فقط في قاعدة هذا الهاتف.
 * لا ينشئ زبوناً ولا يغيّر رصيداً؛ لا يُستعمل هذا السجل وحده للتصريح باستيراد PDF.
 */
class KnaashReviewRepository(private val db: RafiqDatabase) {
    companion object {
        const val SETTING_KEY = "knaash_review_v1"
        private const val MAX_DRAFT_CHARS = 80_000
    }

    data class State(
        val choices: List<KnaashReviewRules.Choice>,
        val otherFile: Boolean = false,
        val previousSha256: String = "",
        val previousDate: String = "",
        val previousCount: Int = 0,
        val currentProblem: String? = null,
    )

    private fun readStored(): KnaashReviewRules.Draft? {
        val value = db.settings().get(SETTING_KEY)?.value ?: return null
        require(value.length <= MAX_DRAFT_CHARS) { "مراجعة كناش المحفوظة كبيرة جداً" }
        val obj = JSONObject(value)
        val items = obj.getJSONArray("choices")
        require(items.length() <= 10_000) { "عدد قرارات مراجعة كناش غير صالح" }
        val rows = (0 until items.length()).map { i ->
            val c = items.getJSONObject(i)
            KnaashReviewRules.Choice(
                index = c.getInt("index"), mode = c.getString("mode"),
                customerId = if (c.has("customer_id")) c.getLong("customer_id") else null,
                name = c.optString("name"), phone = c.optString("phone"),
                reportedBalanceCents = if (c.has("reported_balance_cents")) c.getLong("reported_balance_cents") else null,
            )
        }
        return KnaashReviewRules.Draft(obj.getString("source_sha256"), obj.getString("report_date_iso"),
            obj.getInt("source_count"), rows)
    }

    private fun json(draft: KnaashReviewRules.Draft): String {
        val choices = JSONArray(draft.choices.sortedBy { it.index }.map { c ->
            JSONObject().put("index", c.index).put("mode", c.mode)
                .also { row ->
                    if (c.mode == "existing") row.put("customer_id", c.customerId)
                    if (c.mode == "new") row.put("name", c.name.trim()).put("phone", c.phone.trim())
                    if (c.mode == "zero") row.put("reported_balance_cents", c.reportedBalanceCents)
                }
        })
        return JSONObject().put("source_sha256", draft.sourceSha256)
            .put("report_date_iso", draft.reportDateIso)
            .put("source_count", draft.sourceCount)
            .put("choices", choices).toString()
    }

    private fun candidates(selectedIds: Set<Long>): List<KnaashReviewRules.Existing> {
        val withHistory = if (selectedIds.isEmpty()) emptySet() else db.catalog().customerIdsWithHistory().toSet()
        return db.customers().getAllIncludingInactive().map { c ->
            KnaashReviewRules.Existing(c.id, c.name, c.phone, c.active == 1,
                c.id in selectedIds && c.id in withHistory)
        }
    }

    /** لا تستعد اختيارات ملف آخر لمجرد تطابق عدد صفوفه أو أسماء زبائنه. */
    fun load(sourceSha256: String, reportDateIso: String, sourceCount: Int): RepoResult<State> {
        if (!KnaashReviewRules.validSource(sourceSha256, reportDateIso, sourceCount)) {
            return RepoResult.Failed("معلومات PDF غير صالحة للمراجعة")
        }
        val stored = try { readStored() } catch (_: Exception) {
            return RepoResult.Failed("مراجعة محفوظة غير مقروءة؛ لا تُستعمل حتى تُحذف صراحة")
        } ?: return RepoResult.Ok(State(emptyList()))
        if (stored.sourceSha256 != sourceSha256 || stored.reportDateIso != reportDateIso ||
            stored.sourceCount != sourceCount) {
            return RepoResult.Ok(State(emptyList(), otherFile = true,
                previousSha256 = stored.sourceSha256, previousDate = stored.reportDateIso,
                previousCount = stored.sourceCount))
        }
        val selectedIds = stored.choices.filter { it.mode == "existing" }.mapNotNull { it.customerId }.toSet()
        return RepoResult.Ok(State(stored.choices, currentProblem =
            KnaashReviewRules.invalidReason(stored, candidates(selectedIds))))
    }

    /** قرار صف واحد في معاملة قصيرة؛ لا تسجيل دين ولا إضافة زبون في هذا المسار إطلاقاً. */
    fun save(sourceSha256: String, reportDateIso: String, sourceCount: Int,
             choice: KnaashReviewRules.Choice): RepoResult<State> {
        if (!KnaashReviewRules.validSource(sourceSha256, reportDateIso, sourceCount)) {
            return RepoResult.Failed("معلومات PDF غير صالحة للمراجعة")
        }
        db.beginTransaction()
        try {
            val previous = try { readStored() } catch (_: Exception) {
                return RepoResult.Failed("مراجعة محفوظة غير مقروءة؛ احذفها من شاشة المالك أولاً")
            }
            if (previous != null && (previous.sourceSha256 != sourceSha256 ||
                    previous.reportDateIso != reportDateIso || previous.sourceCount != sourceCount)) {
                return RepoResult.Failed("هناك مراجعة لملف كناش مختلف على هذا الهاتف؛ لا تخلط الكشفين")
            }
            val rows = (previous?.choices.orEmpty().filterNot { it.index == choice.index } + choice)
                .sortedBy { it.index }
            val draft = KnaashReviewRules.Draft(sourceSha256, reportDateIso, sourceCount, rows)
            val selected = rows.filter { it.mode == "existing" }.mapNotNull { it.customerId }.toSet()
            KnaashReviewRules.invalidReason(draft, candidates(selected))?.let { return RepoResult.Failed(it) }
            val encoded = json(draft)
            if (encoded.length > MAX_DRAFT_CHARS) return RepoResult.Failed("مراجعة كناش طويلة جداً")
            db.settings().upsert(SettingEntity(SETTING_KEY, encoded))
            db.setTransactionSuccessful()
            return RepoResult.Ok(State(rows))
        } finally {
            db.endTransaction()
        }
    }

    /** حذف مسودة مراجعة فقط، بعد تأكيد صريح في واجهة المالك. لا يلمس الأرصدة. */
    fun clear(expectedSha256: String): RepoResult<Unit> {
        if (!Regex("[a-f0-9]{64}").matches(expectedSha256)) return RepoResult.Failed("بصمة الملف غير صالحة")
        db.beginTransaction()
        try {
            val existing = try { readStored() } catch (_: Exception) {
                return RepoResult.Failed("مراجعة محفوظة غير مقروءة؛ لا تُحذف تلقائياً")
            }
            if (existing != null && existing.sourceSha256 != expectedSha256) {
                return RepoResult.Failed("المراجعة التي تحاول حذفها تغيّرت؛ أعد فتح الشاشة")
            }
            db.settings().delete(SETTING_KEY)
            db.setTransactionSuccessful()
            return RepoResult.Ok(Unit)
        } finally {
            db.endTransaction()
        }
    }

    /** بحث مختصر للمالك فقط؛ لا يتم اختيار عميل آلياً بالاسم. */
    fun searchCustomers(term: String): List<Pair<CustomerEntity, Boolean>> {
        val needle = term.trim().take(80)
        val code = if (needle.startsWith('#')) net.arena.rafiq.domain.CustomerCode.parseExplicit(needle) else null
        val rows = if (needle.startsWith('#')) {
            listOfNotNull(code?.let { db.customers().getById(it) }?.takeIf { it.active == 1 })
        } else {
            db.customers().getAll().filter { needle.isEmpty() ||
                it.name.contains(needle, ignoreCase = true) || it.phone.contains(needle) }
                .take(20)
        }
        val withHistory = if (rows.isEmpty()) emptySet() else db.catalog().customerIdsWithHistory().toSet()
        return rows.map { it to (it.id in withHistory) }
    }
}
