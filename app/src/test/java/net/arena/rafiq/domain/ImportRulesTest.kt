package net.arena.rafiq.domain

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ImportRulesTest {

    private val money: (String?) -> Long? = { Money.parse(it) }

    @Test
    fun `التوحيد يزيل المسافات والشرطات ويوحّد الأحرف`() {
        assertEquals("احمد علي حسن", ImportRules.norm("  أحمد_علي-حسن  "))
        assertEquals("رقم الهاتف", ImportRules.norm("رقم_الهاتف"))
        assertEquals("", ImportRules.norm(null))
    }

    @Test
    fun `المطابقة التامة تسبق المطابقة الجزئية`() {
        val row: Row = mapOf("الاسم" to "تام", "اسم المادة الجديدة" to "جزئي")
        assertEquals("تام", ImportRules.pick(row, listOf("الاسم")))
    }

    @Test
    fun `المطابقة الجزئية تجد العمود الذي يحتوي المرادف`() {
        val row: Row = mapOf("اسم المادة الجديدة" to "x")
        assertEquals("x", ImportRules.pick(row, listOf("اسم المادة")))
    }

    @Test
    fun `البحث عن الاسم يتجاهل أعمدة الأكواد`() {
        val row: Row = mapOf("رقم الصنف" to "9999", "الاسم" to "شاي")
        assertEquals("شاي", ImportRules.pick(row, ImportRules.PRODUCT_ALIASES.getValue("name"), avoidCode = true))
    }

    @Test
    fun `ملف الأصناف بالترويسات العربية يُقرأ صحيحاً`() {
        val rows: List<Row> = listOf(
            mapOf(
                "باركود" to "1112223334448", "الاسم" to "شاي أحمر 400 غرام", "الوحدة" to "علبة",
                "سعر الشراء" to "7.80", "سعر البيع" to "10.00", "الكمية" to "70",
            ),
        )
        val r = ImportRules.prepareProducts(rows, money).single()
        assertEquals(ImportRules.Status.OK, r.status)
        assertEquals(2, r.row)
        assertEquals("شاي أحمر 400 غرام", r.name)
        assertEquals("1112223334448", r.barcode)
        assertEquals(800L, r.costCents)   // 7.80 يُقرَّب إلى 8 ريال (العملة ريال كامل)
        assertEquals(1000L, r.priceCents)
        assertEquals(70.0, r.stock, 0.0)
    }

    @Test
    fun `صنف بلا سعر بيع لا يُحفظ بسعر شراء أو بسعر صفر، وصنف بلا اسم يُرفض`() {
        val rows: List<Row> = listOf(
            mapOf("الاسم" to "فول معلب", "سعر البيع" to "", "الكمية" to "30"),
            mapOf("الاسم" to "", "سعر البيع" to "5"),
            mapOf("item_name" to "أرز", "cost_price" to "7200"),
        )
        val out = ImportRules.prepareProducts(rows, money)
        assertEquals(ImportRules.Status.ERROR, out[0].status)
        assertEquals("سعر البيع مفقود؛ لم يُعتمد الصنف", out[0].error)
        assertEquals(0L, out[0].priceCents)
        assertEquals(ImportRules.Status.ERROR, out[1].status)
        assertEquals("بدون اسم صنف", out[1].error)
        assertEquals(ImportRules.Status.ERROR, out[2].status)
        assertEquals(720000L, out[2].costCents)
        assertEquals(0L, out[2].priceCents)
    }

    @Test
    fun `ترويسة كتالوج الباركود تميّز سعر البيع عن الشراء مهما كان ترتيب الأعمدة`() {
        val csv = "barcode,item_name,category,unit,cost_price,selling_price\n" +
            "CODE-123,صنف اختبار,تصنيف,حبة,1200,1500\n"
        val r = ImportRules.prepareProducts(CsvReader.parse(csv), money).single()
        assertEquals(ImportRules.Status.OK, r.status)
        assertEquals("صنف اختبار", r.name)
        assertEquals("CODE-123", r.barcode)
        assertEquals(120000L, r.costCents)
        assertEquals(150000L, r.priceCents)
        assertEquals(0.0, r.stock, 0.0)
        assertEquals(false, r.stockProvided)
        val reverse: Row = linkedMapOf("selling_price" to "41", "cost_price" to "38", "item_name" to "تجربة")
        val second = ImportRules.prepareProducts(listOf(reverse), money).single()
        assertEquals(4100L, second.priceCents)
        assertEquals(3800L, second.costCents)
    }

    @Test
    fun `رقم EAN 13 غير مطابق ينبه فقط ولا يدعي التحقق من المنتج`() {
        val rows: List<Row> = listOf(
            mapOf("باركود" to "1234567890128", "الاسم" to "رمز تحقق سليم", "سعر البيع" to "12"),
            mapOf("باركود" to "1234567890123", "الاسم" to "رقم داخلي محتمل", "سعر البيع" to "12"),
            mapOf("باركود" to "CODE-13", "الاسم" to "رمز غير EAN", "سعر البيع" to "12"),
        )
        val rec = ImportRules.prepareProducts(rows, money)
        assertEquals(ImportRules.Status.OK, rec[0].status)
        assertEquals(ImportRules.Status.WARN, rec[1].status)
        assertTrue(rec[1].error.contains("EAN-13"))
        assertEquals(ImportRules.Status.OK, rec[2].status)
    }

    @Test
    fun `كمية غير مفهومة لا تتحول إلى الصفر بصمت`() {
        val r = ImportRules.prepareProducts(listOf(mapOf("الاسم" to "شاي", "سعر البيع" to "10",
            "الكمية" to "كثير")), money).single()
        assertEquals(ImportRules.Status.ERROR, r.status)
        assertTrue(r.error.contains("الكمية"))
        assertEquals(true, r.stockProvided)
    }

    @Test
    fun `سعر بيع غير صالح يُرفض بدلاً من أن يُحذَّر`() {
        val rows: List<Row> = listOf(mapOf("الاسم" to "شاي", "سعر البيع" to "abc"))
        val r = ImportRules.prepareProducts(rows, money).single()
        assertEquals(ImportRules.Status.ERROR, r.status)
        assertEquals("سعر البيع غير صحيح", r.error)
    }

    @Test
    fun `الباركود المكرر داخل الملف يُرفض في تكراره الثاني`() {
        val rows: List<Row> = listOf(
            mapOf("باركود" to "1", "الاسم" to "أول", "سعر البيع" to "1"),
            mapOf("باركود" to "1", "الاسم" to "ثانٍ", "سعر البيع" to "2"),
        )
        val out = ImportRules.prepareProducts(rows, money)
        assertEquals(ImportRules.Status.OK, out[0].status)
        assertEquals(ImportRules.Status.ERROR, out[1].status)
        assertEquals("باركود مكرر داخل الملف", out[1].error)
    }

    @Test
    fun `الموقع اختياري في ملف الأصناف`() {
        val rows: List<Row> = listOf(
            mapOf("الاسم" to "مستورد", "سعر البيع" to "10", "الممر" to "6", "الرف" to "أ"),
            mapOf("الاسم" to "بلا موقع", "سعر البيع" to "10"),
        )
        val out = ImportRules.prepareProducts(rows, money)
        assertEquals("6", out[0].aisle)
        assertEquals("أ", out[0].shelf)
        assertEquals("", out[1].aisle)
        assertEquals(ImportRules.Status.OK, out[1].status)
    }

    @Test
    fun `الكمية الفارغة تعني غير مذكورة وغير الرقمية تُرفض`() {
        val rows: List<Row> = listOf(
            mapOf("الاسم" to "أ", "سعر البيع" to "1", "الكمية" to ""),
            mapOf("الاسم" to "ب", "سعر البيع" to "1", "الكمية" to "كثير"),
        )
        val out = ImportRules.prepareProducts(rows, money)
        assertEquals(0.0, out[0].stock, 0.0)
        assertEquals(false, out[0].stockProvided)
        assertEquals(ImportRules.Status.OK, out[0].status)
        assertEquals(ImportRules.Status.ERROR, out[1].status)
        assertEquals(true, out[1].stockProvided)
    }

    @Test
    fun `الوحدة الفارغة تصبح حبة`() {
        val r = ImportRules.prepareProducts(listOf(mapOf("الاسم" to "ج", "سعر البيع" to "1")), money).single()
        assertEquals("حبة", r.unit)
    }

    @Test
    fun `ملف الزبائن المدينين يدمج المبالغ ويتجاهل الصفوف الفارغة`() {
        val rows: List<Row> = listOf(
            mapOf("اسم الزبون" to "عم محمد", "الهاتف" to "0501112233", "المبلغ" to "5000"),
            mapOf("اسم الزبون" to "", "المبلغ" to "500"),
            mapOf("اسم الزبون" to "صفر الدين", "المبلغ" to "0"),
            mapOf("اسم الزبون" to "خطأ", "المبلغ" to "abc"),
        )
        val out = ImportRules.prepareDebts(rows, money)
        assertEquals(ImportRules.Status.OK, out[0].status)
        assertEquals(500000L, out[0].amountCents)     // 5000 ريال = 500000 قرش
        assertEquals("0501112233", out[0].phone)
        assertEquals(ImportRules.Status.ERROR, out[1].status)
        assertEquals("بدون اسم زبون", out[1].error)
        assertEquals(ImportRules.Status.WARN, out[2].status)
        assertEquals("مبلغ صفر — سيُتجاوز", out[2].error)
        assertEquals(ImportRules.Status.ERROR, out[3].status)
        assertEquals("مبلغ غير صحيح", out[3].error)
        assertTrue(out.all { it.row >= 2 })
    }

    @Test
    fun `التاريخ يُقبل بالصيغ الشائعة ويُرفض غير الموجود`() {
        assertEquals("2027-01-31", ImportRules.toIsoDate("2027-01-31"))
        assertEquals("2027-01-31", ImportRules.toIsoDate("31/01/2027"))
        assertEquals("2027-01-31", ImportRules.toIsoDate("01/31/2027"))
        assertEquals(null, ImportRules.toIsoDate("31/02/2027"))
        assertEquals(null, ImportRules.toIsoDate("abc"))
        assertEquals(null, ImportRules.toIsoDate(""))
    }

    @Test
    fun `الاستيراد يعيد تاريخ ASCII حتى مع لغة هاتف عربية`() {
        val previous = java.util.Locale.getDefault()
        try {
            java.util.Locale.setDefault(java.util.Locale.forLanguageTag("ar-YE"))
            assertEquals("2026-12-31", ImportRules.toIsoDate("31/12/2026"))
            assertEquals("2027-01-31", ImportRules.toIsoDate("46418"))
        } finally {
            java.util.Locale.setDefault(previous)
        }
    }

    @Test
    fun `تاريخ الانتهاء يصل إلى سجل الصنف`() {
        val row: Row = mapOf("اسم الصنف" to "شاي", "سعر البيع" to "8", "تاريخ الانتهاء" to "31/12/2026")
        assertEquals("2026-12-31", ImportRules.prepareProducts(listOf(row), money).single().expiry)
    }

    @Test
    fun `تاريخ إكسل الرقمي يُحوَّل إلى تاريخ والأرقام الصغيرة لا تُعد تواريخ`() {
        assertEquals("2027-01-31", ImportRules.toIsoDate("46418"))
        assertEquals(null, ImportRules.toIsoDate("123"))
    }
}
