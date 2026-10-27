package net.arena.rafiq.domain

/**
 * رمز قصير للزبون مشتق من رقمه المحلي الثابت في قاعدة هاتف البيع.
 * لا يغيّر رقم قاعدة البيانات ولا يتطلب ترحيلاً؛ يبقى محفوظاً في النسخة الاحتياطية.
 * عند دمج قواعد من أجهزة مختلفة لا يجوز اعتبار هذه الرموز عالمية: يحتاج الدمج هوية جهاز.
 */
object CustomerCode {
    fun display(id: Long): String = "#" + id.toString().padStart(5, '0')

    /** لا نخلط الرمز بالهاتف: البحث الصريح يبدأ بـ #. ندعم أرقام لوحة مفاتيح عربية. */
    fun parseExplicit(query: String): Long? {
        val trimmed = query.trim()
        if (!trimmed.startsWith('#')) return null
        val digits = trimmed.drop(1)
        if (digits.isEmpty() || digits.length > 18) return null
        val normalized = buildString {
            for (ch in digits) {
                val digit = Character.digit(ch, 10)
                if (digit !in 0..9) return null
                append(('0'.code + digit).toChar())
            }
        }
        return normalized.toLongOrNull()?.takeIf { it > 0 }
    }
}
