package net.arena.rafiq.domain

import java.text.Normalizer
import java.text.SimpleDateFormat
import java.util.Locale

/** مسودة اختيار هوية العملاء فقط؛ لا تفوّض كتابة دين أو تعديل رصيد. */
object KnaashReviewRules {
    data class Existing(
        val id: Long,
        val name: String,
        val phone: String,
        val active: Boolean,
        val hasHistory: Boolean,
    )

    data class Choice(
        val index: Int,
        val mode: String, // existing | new | zero
        val customerId: Long? = null,
        val name: String = "",
        val phone: String = "",
        val reportedBalanceCents: Long? = null, // الصفر للمراجعة فقط؛ الترحيل يعيد فحص PDF.
    )

    data class Draft(
        val sourceSha256: String,
        val reportDateIso: String,
        val sourceCount: Int,
        val choices: List<Choice>,
    )

    fun validSource(sha256: String, date: String, count: Int): Boolean {
        if (!Regex("[a-f0-9]{64}").matches(sha256) ||
            !Regex("[0-9]{4}-[0-9]{2}-[0-9]{2}").matches(date) || count !in 1..10_000) return false
        return runCatching {
            SimpleDateFormat("yyyy-MM-dd", Locale.US).apply { isLenient = false }.parse(date) != null
        }.getOrDefault(false)
    }

    /** المقارنة تحذيرية فقط؛ لا تستنتج الهوية من تطابق الاسم. */
    fun normalizedName(raw: String): String {
        val normalized = Normalizer.normalize(raw.trim(), Normalizer.Form.NFKD)
        return buildString {
            for (ch in normalized) {
                if (ch == '\u0640' || ch.isWhitespace() ||
                    Character.getType(ch) == Character.NON_SPACING_MARK.toInt() ||
                    Character.getType(ch) == Character.COMBINING_SPACING_MARK.toInt()) continue
                if (ch.isLetterOrDigit()) append(ch.lowercaseChar())
            }
        }
    }

    fun normalizedPhone(raw: String): String = buildString {
        raw.forEach { ch -> if (ch.isDigit()) append(Character.getNumericValue(ch)) }
    }

    /** رسالة سبب الرفض، أو null إذا أمكن حفظ قرارات المراجعة (وليس ترحيل الديون). */
    fun invalidReason(draft: Draft, customers: List<Existing>): String? {
        if (!validSource(draft.sourceSha256, draft.reportDateIso, draft.sourceCount)) {
            return "بيانات ملف كناش غير صالحة للمراجعة"
        }
        if (draft.choices.size > draft.sourceCount) return "عدد قرارات المراجعة أكثر من صفوف الكشف"
        val ids = HashSet<Long>()
        val positions = HashSet<Int>()
        val newNames = HashSet<String>()
        val newPhones = HashSet<String>()
        val byId = customers.associateBy { it.id }
        val oldNames = customers.map { normalizedName(it.name) }.filter { it.isNotEmpty() }.toSet()
        val oldPhones = customers.map { normalizedPhone(it.phone) }.filter { it.isNotEmpty() }.toSet()
        for (row in draft.choices) {
            if (row.index !in 1..draft.sourceCount || !positions.add(row.index)) {
                return "صف مكرر أو خارج عدد عملاء الكشف"
            }
            when (row.mode) {
                "existing" -> {
                    val id = row.customerId ?: return "اختر زبوناً موجوداً بعينه"
                    val found = byId[id] ?: return "الزبون المختار غير موجود في رفيق"
                    if (!found.active) return "الزبون المختار غير نشط؛ لا تُضاف إليه أرصدة"
                    if (found.hasHistory) return "الزبون المختار لديه رصيد أو حركات سابقة؛ لا تُضاعف رصيده"
                    if (!ids.add(id)) return "اخترت الزبون نفسه لأكثر من صف؛ راجع التطابق"
                }
                "new" -> {
                    val name = row.name.trim()
                    val phone = row.phone.trim()
                    if (name.isEmpty() || name.length > 120 || name.any { Character.isISOControl(it) } ||
                        phone.length > 40 || phone.any { Character.isISOControl(it) }) {
                        return "راجع اسم الزبون الجديد ورقم هاتفه"
                    }
                    val comparable = normalizedName(name)
                    if (comparable.isEmpty()) return "اسم الزبون الجديد غير صالح"
                    if (comparable in oldNames || !newNames.add(comparable)) {
                        return "اسم زبون جديد يطابق اسماً موجوداً؛ راجع الشخص قبل إنشاء نسخة ثانية"
                    }
                    val digits = normalizedPhone(phone)
                    if (digits.isNotEmpty() && (digits in oldPhones || !newPhones.add(digits))) {
                        return "رقم هاتف مستخدم لزبون آخر؛ راجعه قبل الحفظ"
                    }
                }
                "zero" -> if (row.reportedBalanceCents != 0L) {
                    return "لا يُستبعد من مراجعة الديون إلا الصف الذي رصيده صفر فعلاً"
                }
                else -> return "اختيار المراجعة غير معروف"
            }
        }
        return null
    }
}
