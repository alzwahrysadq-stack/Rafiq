package net.arena.rafiq.domain

import org.junit.Assert.assertEquals
import org.junit.Test

class CustomerCodeTest {
    @Test
    fun `الرمز مشتق من المعرف المحلي وقابل للبحث بالعربية`() {
        assertEquals("#00001", CustomerCode.display(1L))
        assertEquals("#100001", CustomerCode.display(100001L))
        assertEquals(42L, CustomerCode.parseExplicit("  #00042 "))
        assertEquals(42L, CustomerCode.parseExplicit("#٠٠٠٤٢"))
    }

    @Test
    fun `لا نفسر رقما هاتفيا او رمزا غير صحيح على انه هوية زبون`() {
        assertEquals(null, CustomerCode.parseExplicit("777123456"))
        assertEquals(null, CustomerCode.parseExplicit("#"))
        assertEquals(null, CustomerCode.parseExplicit("#00000"))
        assertEquals(null, CustomerCode.parseExplicit("#42x"))
        assertEquals(null, CustomerCode.parseExplicit("#9999999999999999999"))
    }
}
