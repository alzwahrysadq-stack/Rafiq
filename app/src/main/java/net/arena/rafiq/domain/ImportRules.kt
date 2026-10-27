package net.arena.rafiq.domain

/** الصف كما قرأته الطبقة التي تقرأ الملف: الترويسة → القيمة. */
typealias Row = Map<String, String?>

/**
 * قواعد الاستيراد على مستوى الصف الواحد، مطابقة لـ norm و pick و prepare_products
 * و prepare_debts في النسخة الأصلية.
 * قراءة ملفات CSV وXLSX نفسها تأتي في المرحلة 6، وهنا فقط منطق تفسير الصفوف.
 */
object ImportRules {

    enum class Status { OK, WARN, ERROR }

    /** توحيد النص للمقارنة: بدون مسافات زائدة، والأحرف الموحّدة، وبدون الشرطات. */
    fun norm(s: String?): String {
        var t = (s ?: "").trim().lowercase()
        t = t.replace('أ', 'ا').replace('إ', 'ا').replace('آ', 'ا')
            .replace('ى', 'ي').replace('ة', 'ه')
        return t.replace(Regex("[\\s_\\-.]+"), " ")
    }

    private val CODE_WORDS = listOf("رقم", "كود", "باركود", "barcode", "code", "id")

    /**
     * يبحث عن أول ترويسة تطابق أحد المرادفات: أولاً تطابق تام، ثم تطابق جزئي.
     * avoidCode = true يتجاهل الأعمدة التي تبدو أكواداً عند البحث عن الاسم.
     */
    fun pick(row: Row, aliases: List<String>, avoidCode: Boolean = false): String? {
        var normRow = row.entries
            .map { norm(it.key) to it.value }
        if (avoidCode) {
            normRow = normRow.filter { (k, _) -> CODE_WORDS.none { k.contains(it) } }
        }
        for (a in aliases) {
            val na = norm(a)
            normRow.firstOrNull { it.first == na }?.let { return it.second }
        }
        for (a in aliases) {
            val na = norm(a)
            if (na.isEmpty()) continue
            normRow.firstOrNull { (k, _) -> na.contains(k) || k.contains(na) }?.let { return it.second }
        }
        return null
    }

    /** مرادفات أعمدة الأصناف، مطابقة للنسخة الأصلية. */
    val PRODUCT_ALIASES: Map<String, List<String>> = mapOf(
        "barcode" to listOf("باركود", "الباركود", "باركود الصنف", "الرمز", "الكود", "كود", "كود الصنف",
            "رقم الصنف", "رقم المادة", "barcode", "code"),
        "name" to listOf("الاسم", "اسم الصنف", "اسم المادة", "الصنف", "البيان", "المادة", "name", "item"),
        "unit" to listOf("الوحدة", "الوحده", "unit"),
        "category" to listOf("التصنيف", "المجموعة", "القسم", "المجموعه", "category", "group"),
        "cost" to listOf("سعر الشراء", "التكلفة", "سعر التكلفة", "الكلفة", "cost price", "purchase price", "cost"),
        "price" to listOf("سعر البيع", "سعر المفرد", "سعر التجزئة", "selling price", "sale price",
            "retail price", "السعر", "price"),
        "stock" to listOf("الكمية", "الكميه", "الرصيد", "المخزون", "الكمية الحالية", "qty", "stock", "quantity"),
        "aisle" to listOf("الممر", "ممر", "رقم الممر", "الرواق", "الموقع", "aisle", "row"),
        "shelf" to listOf("الرف", "رف", "رقم الرف", "الطابق", "shelf", "rack"),
        "expiry" to listOf("تاريخ الانتهاء", "الانتهاء", "تاريخ الصلاحية", "الصلاحية", "expiry", "exp"),
    )

    /** مرادفات أعمدة الزبائن المدينين. */
    val DEBT_ALIASES: Map<String, List<String>> = mapOf(
        "name" to listOf("الاسم", "اسم الزبون", "الزبون", "اسم العميل", "العميل", "name", "customer"),
        "phone" to listOf("الهاتف", "الجوال", "الموبايل", "التلفون", "رقم الهاتف", "phone", "mobile"),
        "amount" to listOf("المبلغ", "الدين", "الرصيد", "المديونية", "قيمة الدين", "amount", "debt", "balance"),
        "note" to listOf("ملاحظة", "ملاحظات", "البيان", "note", "notes"),
    )

    /** يحوّل التاريخ إلى YYYY-MM-DD: يقبل ISO وdd/MM/yyyy وdd-MM-yyyy وyyyy/MM/dd وMM/dd/yyyy، ويرفض التواريخ غير الموجودة. */
    fun toIsoDate(raw: String?): String? {
        val s = (raw ?: "").trim()
        if (s.isEmpty()) return null
        // تاريخ إكسل المخزَّن كرقم تسلسلي (أيام منذ 1899-12-30)
        if (Regex("""\d{5}""").matches(s)) {
            val serial = s.toLong()
            if (serial in 20000L..90000L) {
                val cal = java.util.Calendar.getInstance(java.util.TimeZone.getTimeZone("UTC"))
                cal.clear()
                cal.set(1899, 11, 30)
                cal.add(java.util.Calendar.DAY_OF_MONTH, serial.toInt())
                return String.format(java.util.Locale.US, "%04d-%02d-%02d", cal.get(java.util.Calendar.YEAR),
                    cal.get(java.util.Calendar.MONTH) + 1, cal.get(java.util.Calendar.DAY_OF_MONTH))
            }
        }
        val m = Regex("""(\d{1,4})[/-](\d{1,2})[/-](\d{1,4})""").matchEntire(s) ?: return null
        val (a, b, c) = m.destructured
        val candidates = listOf(
            Triple(a.toInt(), b.toInt(), c.toInt()),            // yyyy-mm-dd / yyyy/mm/dd
            Triple(c.toInt(), b.toInt(), a.toInt()),            // dd/mm/yyyy
            Triple(c.toInt(), a.toInt(), b.toInt()),            // mm/dd/yyyy
        )
        for ((y, mo, d) in candidates) {
            if (y >= 1000 && mo in 1..12 && d in 1..daysIn(y, mo)) {
                return String.format(java.util.Locale.US, "%04d-%02d-%02d", y, mo, d)
            }
        }
        return null
    }

    private fun daysIn(y: Int, mo: Int): Int = when (mo) {
        2 -> if ((y % 4 == 0 && y % 100 != 0) || y % 400 == 0) 29 else 28
        4, 6, 9, 11 -> 30
        else -> 31
    }

    data class ProductRecord(
        val row: Int,
        val status: Status,
        val error: String,
        val name: String,
        val barcode: String,
        val unit: String,
        val category: String,
        val costCents: Long,
        val priceCents: Long,
        val stock: Double,
        val aisle: String,
        val shelf: String,
        val expiry: String? = null,
        val stockProvided: Boolean = false,
    )

    /** فصل سعر البيع عن الشراء: «price» العامة لا يجوز أن تلتقط cost_price الأول. */
    private fun salePrice(row: Row): String? {
        val costTerms = listOf("cost", "purchase", "buy", "wholesale", "شراء", "تكلف", "كلف")
        val saleColumns = row.filterKeys { raw ->
            val h = norm(raw)
            h.isNotBlank() && costTerms.none { h.contains(it) }
        }
        return pick(saleColumns, PRODUCT_ALIASES.getValue("price"))
    }

    /** تحذير فقط: بعض المتاجر تطبع رقماً داخلياً من 13 خانة بصيغة غير EAN-13. */
    private fun invalidEan13(code: String): Boolean {
        if (code.length != 13 || code.any { it !in '0'..'9' }) return false
        var sum = 0
        for (i in 0 until 12) sum += (code[i] - '0') * (if (i % 2 == 0) 1 else 3)
        return (10 - sum % 10) % 10 != code[12] - '0'
    }

    /**
     * يحوّل صفوف الأصناف إلى سجلات جاهزة للمعاينة.
     * [parseMoney] يحوّل النص إلى وحدة 1/100 من الريال، ويعيد null للنص غير الصالح (مثل Money.parse).
     */
    fun prepareProducts(rows: List<Row>, parseMoney: (String?) -> Long?): List<ProductRecord> {
        val out = ArrayList<ProductRecord>()
        rows.forEachIndexed { index, row ->
            val name = (pick(row, PRODUCT_ALIASES.getValue("name"), avoidCode = true) ?: "").trim()
            val barcode = (pick(row, PRODUCT_ALIASES.getValue("barcode")) ?: "").trim()
            val rawPrice = salePrice(row)
            val parsedPrice = parseMoney(rawPrice)
            val rawStock = (pick(row, PRODUCT_ALIASES.getValue("stock")) ?: "").trim()
            val stockProvided = rawStock.isNotEmpty() && !rawStock.equals("None", ignoreCase = true)
            val parsedStock = if (stockProvided) rawStock.toDoubleOrNull() else null
            val invalidStock = stockProvided && (parsedStock == null || !parsedStock.isFinite() || parsedStock < 0.0)
            val stock = if (invalidStock) 0.0 else parsedStock ?: 0.0

            var status = Status.OK
            var error = ""
            val price = parsedPrice ?: 0L
            if (name.isEmpty()) {
                status = Status.ERROR; error = "بدون اسم صنف"
            } else if (parsedPrice == null) {
                status = Status.ERROR
                error = if (rawPrice.isNullOrBlank()) "سعر البيع مفقود؛ لم يُعتمد الصنف"
                    else "سعر البيع غير صحيح"
            } else if (invalidStock) {
                status = Status.ERROR; error = "الكمية غير صحيحة؛ لم يُعتمد الصنف"
            } else if (invalidEan13(barcode)) {
                status = Status.WARN
                error = "رقم تحقق EAN-13 غير مطابق؛ راجع الرمز على العبوة (قد يكون رمزاً داخلياً بصيغة أخرى)"
            }

            out.add(
                ProductRecord(
                    row = index + 2,
                    status = status,
                    error = error,
                    name = name,
                    barcode = barcode,
                    unit = (pick(row, PRODUCT_ALIASES.getValue("unit")) ?: "").trim().ifEmpty { "حبة" },
                    category = (pick(row, PRODUCT_ALIASES.getValue("category")) ?: "").trim(),
                    costCents = parseMoney(pick(row, PRODUCT_ALIASES.getValue("cost"))) ?: 0L,
                    priceCents = price,
                    stock = stock,
                    aisle = (pick(row, PRODUCT_ALIASES.getValue("aisle")) ?: "").trim(),
                    shelf = (pick(row, PRODUCT_ALIASES.getValue("shelf")) ?: "").trim(),
                    expiry = toIsoDate(pick(row, PRODUCT_ALIASES.getValue("expiry"))),
                    stockProvided = stockProvided,
                )
            )
        }
        // الباركود المكرر داخل الملف نفسه يُرفض في كل تكرار بعد الأول
        val seen = HashSet<String>()
        return out.map { rec ->
            if (rec.barcode.isEmpty()) rec
            else if (!seen.add(rec.barcode)) rec.copy(status = Status.ERROR, error = "باركود مكرر داخل الملف")
            else rec
        }
    }

    data class DebtRecord(
        val row: Int,
        val status: Status,
        val error: String,
        val name: String,
        val phone: String,
        val amountCents: Long,
        val note: String,
    )

    fun prepareDebts(rows: List<Row>, parseMoney: (String?) -> Long?): List<DebtRecord> {
        return rows.mapIndexed { index, row ->
            val name = (pick(row, DEBT_ALIASES.getValue("name")) ?: "").trim()
            val amount = parseMoney(pick(row, DEBT_ALIASES.getValue("amount")))
            var status = Status.OK
            var error = ""
            if (name.isEmpty()) {
                status = Status.ERROR; error = "بدون اسم زبون"
            } else if (amount == null) {
                status = Status.ERROR; error = "مبلغ غير صحيح"
            } else if (amount <= 0L) {
                status = Status.WARN; error = "مبلغ صفر — سيُتجاوز"
            }
            DebtRecord(
                row = index + 2,
                status = status,
                error = error,
                name = name,
                phone = (pick(row, DEBT_ALIASES.getValue("phone")) ?: "").trim(),
                amountCents = amount ?: 0L,
                note = (pick(row, DEBT_ALIASES.getValue("note")) ?: "").trim(),
            )
        }
    }
}
