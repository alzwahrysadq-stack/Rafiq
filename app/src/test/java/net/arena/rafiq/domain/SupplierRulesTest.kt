package net.arena.rafiq.domain

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SupplierRulesTest {

    // ---------- الرصيد ----------

    @Test
    fun `الاستلام يزيد ما علينا له والسداد والمرتجع ينقصانه`() {
        assertEquals(0L, SupplierRules.balance(0L, 0L, 0L))
        assertEquals(10000L, SupplierRules.balance(10000L, 0L, 0L))
        assertEquals(7000L, SupplierRules.balance(10000L, 2000L, 1000L))
    }

    // ---------- المندوبون: متوقع اليوم ومتأخر ----------

    @Test
    fun `المندوب الأسبوعي متوقع بعد 7 أيام ومتأخر بعد 10`() {
        val six = SupplierRules.delegateFlags(true, true, "weekly", 6)
        assertFalse(six.dueToday)
        val seven = SupplierRules.delegateFlags(true, true, "weekly", 7)
        assertTrue(seven.dueToday)
        assertFalse(seven.overdue)
        val ten = SupplierRules.delegateFlags(true, true, "weekly", 10)
        assertTrue(ten.overdue)
    }

    @Test
    fun `المندوب الذي لم يُزَر أبداً متوقع اليوم`() {
        val f = SupplierRules.delegateFlags(true, true, "daily", null)
        assertTrue(f.dueToday)
        assertFalse(f.overdue)
    }

    @Test
    fun `المندوب اليومي يتأخر بعد يومين`() {
        assertFalse(SupplierRules.delegateFlags(true, true, "daily", 0).dueToday)
        assertTrue(SupplierRules.delegateFlags(true, true, "daily", 1).dueToday)
        assertTrue(SupplierRules.delegateFlags(true, true, "daily", 2).overdue)
    }

    @Test
    fun `المندوب الشهري يتأخر بعد 35 يوماً`() {
        assertFalse(SupplierRules.delegateFlags(true, true, "monthly", 34).overdue)
        assertTrue(SupplierRules.delegateFlags(true, true, "monthly", 35).overdue)
    }

    @Test
    fun `عند الحاجة لا يُحسب له تأخير ولا توقع`() {
        val f = SupplierRules.delegateFlags(true, true, "irregular", 999)
        assertFalse(f.dueToday)
        assertFalse(f.overdue)
    }

    @Test
    fun `المورد العادي غير المندوب لا يدخل قائمة المتوقع`() {
        val f = SupplierRules.delegateFlags(false, true, "daily", null)
        assertFalse(f.dueToday)
        assertFalse(f.overdue)
    }

    @Test
    fun `المندوب غير الفعّال لا يدخل القائمة`() {
        val f = SupplierRules.delegateFlags(true, false, "daily", null)
        assertFalse(f.dueToday)
    }

    // ---------- إيقاف المورد ----------

    @Test
    fun `لا يُوقف المورد إلا إذا كان حسابه مصفّى`() {
        assertNull(SupplierRules.validateDeactivate("ألبان", 0L))
        val msg = SupplierRules.validateDeactivate("ألبان", 1250L)
        assertEquals("لا يمكن إيقاف «ألبان» وحسابه غير مصفّى (12.50).", msg)
    }

    @Test
    fun `الرصيد السالب عند الإيقاف يُعرض بإشارته`() {
        val msg = SupplierRules.validateDeactivate("خبز", -300L)
        assertTrue(msg!!.contains("(-3.00)"))
    }

    // ---------- السداد والمرتجع ----------

    @Test
    fun `المبلغ يجب أن يكون أكبر من صفر`() {
        assertNull(SupplierRules.validAmount(null))
        assertNull(SupplierRules.validAmount(0L))
        assertNull(SupplierRules.validAmount(-100L))
        assertEquals(500L, SupplierRules.validAmount(500L))
    }

    @Test
    fun `السداد للمالك فقط`() {
        assertEquals("هذه الحركة للمالك فقط", SupplierRules.validatePay(1000L, isOwner = false, shiftOpen = true))
    }

    @Test
    fun `السداد يحتاج وردية مفتوحة`() {
        val msg = SupplierRules.validatePay(1000L, isOwner = true, shiftOpen = false)
        assertTrue(msg!!.contains("الصندوق مغلق"))
        assertNull(SupplierRules.validatePay(1000L, isOwner = true, shiftOpen = true))
    }

    @Test
    fun `المرتجع يُرفض للبنود غير القابلة للرجعة`() {
        val msg = SupplierRules.validateReturn(1000L, returnable = false, name = "ثلج")
        assertEquals("«ثلج» غير قابل للمرتجع (مثل الثلج) — لا يمكن تسجيل رجعة", msg)
        assertNull(SupplierRules.validateReturn(1000L, returnable = true, name = "خبز"))
    }

    @Test
    fun `قوائم الدورية والتسميات مطابقة للنسخة الأصلية`() {
        assertEquals(1, SupplierRules.PERIOD_DAYS["daily"])
        assertEquals(7, SupplierRules.PERIOD_DAYS["weekly"])
        assertEquals(30, SupplierRules.PERIOD_DAYS["monthly"])
        assertEquals(3, SupplierRules.OVERDUE_EXTRA["weekly"])
        assertEquals(5, SupplierRules.OVERDUE_EXTRA["monthly"])
        assertEquals("عند الحاجة", SupplierRules.PERIOD_LABEL["irregular"])
    }
}
