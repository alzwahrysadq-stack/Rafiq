package net.arena.rafiq.domain

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class CsvReaderTest {

    @Test
    fun `يكتشف الفاصلة المنقوطة ويتجاهل السطور الفارغة`() {
        val rows = CsvReader.parse("الاسم;السعر\nشاي;100\n\n  ;  \nأرز;200")
        assertEquals(2, rows.size)
        assertEquals("شاي", rows[0]["الاسم"])
        assertEquals("100", rows[0]["السعر"])
        assertEquals("200", rows[1]["السعر"])
    }

    @Test
    fun `الاقتباس يحفظ الفاصلة والاقتباس داخل الخلية`() {
        val rows = CsvReader.parse("الاسم,ملاحظة\n\"أرز, بسمتي\",\"قال \"\"مرحبا\"\"\"")
        assertEquals("أرز, بسمتي", rows[0]["الاسم"])
        assertEquals("قال \"مرحبا\"", rows[0]["ملاحظة"])
    }

    @Test
    fun `علامة BOM تُزال من الترويسة والجدولة تُكتشف`() {
        val bom = CsvReader.parse("\uFEFFالاسم,السعر\nشاي,1")
        assertEquals("شاي", bom[0]["الاسم"])
        val tab = CsvReader.parse("الاسم\tالسعر\nشاي\t5")
        assertEquals("5", tab[0]["السعر"])
    }

    @Test
    fun `الصف الناقص يعطي null للأعمدة الغائبة`() {
        val rows = CsvReader.parse("الاسم,السعر,الكمية\nشاي,5")
        assertNull(rows[0]["الكمية"])
    }
}
