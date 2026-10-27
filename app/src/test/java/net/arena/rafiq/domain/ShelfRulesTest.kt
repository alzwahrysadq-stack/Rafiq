package net.arena.rafiq.domain

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ShelfRulesTest {

    // ---------- الموقع اختياري ----------

    @Test
    fun `الموقع اختياري والصنف بلا موقع فاتحة النص فارغ`() {
        assertEquals("", ShelfRules.locationText(null, null))
        assertEquals("", ShelfRules.locationText("", ""))
        assertEquals("", ShelfRules.locationText("  ", " "))
    }

    @Test
    fun `نص الموقع الكامل بصيغة رفيق`() {
        assertEquals("ممر 3 • رف ب", ShelfRules.locationText("3", "ب"))
    }

    @Test
    fun `ممر بلا رف أو رف بلا ممر كلاهما مقبول`() {
        assertEquals("ممر 2", ShelfRules.locationText("2", ""))
        assertEquals("رف ج", ShelfRules.locationText(null, "ج"))
    }

    @Test
    fun `اسم الصنف مطلوب`() {
        assertEquals("اسم الصنف مطلوب", ShelfRules.validateProductName("  "))
        assertEquals("اسم الصنف مطلوب", ShelfRules.validateProductName(null))
        assertNull(ShelfRules.validateProductName("شاي"))
    }

    // ---------- تحويل الأرقام بأمان ----------

    @Test
    fun `القيم الفارغة أو غير الرقمية تعيد الافتراضي`() {
        assertEquals(0.0, ShelfRules.toFloatOr(null, 0.0), 0.0)
        assertEquals(5.0, ShelfRules.toFloatOr("", 5.0), 0.0)
        assertEquals(5.0, ShelfRules.toFloatOr("abc", 5.0), 0.0)
        assertEquals(0.75, ShelfRules.toFloatOr(" 0.75 ", 0.0), 0.0)
    }

    // ---------- البحث: اسم ≡ باركود ≡ موقع ----------

    @Test
    fun `البحث بالاسم والباركود يطابق الصنف نفسه`() {
        assertTrue(ShelfRules.matchesNameOrBarcode("حليب", "حليب نيدو", "6281000123500"))
        assertTrue(ShelfRules.matchesNameOrBarcode("6281000123500", "حليب نيدو", "6281000123500"))
    }

    @Test
    fun `البحث بلا نص لا يطابق شيئاً`() {
        assertFalse(ShelfRules.matchesNameOrBarcode("   ", "شاي", null))
    }

    @Test
    fun `البحث لا يهتم بحالة الأحرف في الإنجليزية`() {
        assertTrue(ShelfRules.matchesNameOrBarcode("cola", "COLA زيرو", null))
    }

    @Test
    fun `عبارة الموقع تُفهم من ممر أو رف أو رقم وحده`() {
        assertEquals("3", ShelfRules.parseLocationQuery("ممر 3"))
        assertEquals("3", ShelfRules.parseLocationQuery("3"))
        assertEquals("3ب", ShelfRules.parseLocationQuery("3ب"))
        assertEquals("3أ", ShelfRules.parseLocationQuery("رف 3أ"))
    }

    @Test
    fun `النص العادي ليس موقعاً`() {
        assertNull(ShelfRules.parseLocationQuery("شاي أحمر"))
        assertNull(ShelfRules.parseLocationQuery("رف ب"))
        assertNull(ShelfRules.parseLocationQuery("شيء_غير_موجود"))
    }

    @Test
    fun `الأرقام العربية تُفهم كموقع`() {
        assertEquals("٣", ShelfRules.parseLocationQuery("ممر ٣"))
    }

    @Test
    fun `البحث بالموقع يجد كل صنف في الممر نفسه`() {
        assertTrue(ShelfRules.matchesLocationCode("3", "3", "أ"))
        assertTrue(ShelfRules.matchesLocationCode("3", "3", "ب"))
        assertFalse(ShelfRules.matchesLocationCode("3", "9", "أ"))
        assertTrue(ShelfRules.matchesLocationCode("أ", "9", "أ"))
    }

    // ---------- الرصيد المنخفض ----------

    @Test
    fun `الرصيد المنخفض يشمل المساوي للحد`() {
        assertTrue(ShelfRules.isLowStock(5.0, 5.0))
        assertTrue(ShelfRules.isLowStock(0.0, 5.0))
        assertFalse(ShelfRules.isLowStock(6.0, 5.0))
    }
}
