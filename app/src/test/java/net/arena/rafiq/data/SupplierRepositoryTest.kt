package net.arena.rafiq.data

import androidx.test.core.app.ApplicationProvider
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class SupplierRepositoryTest {

    private lateinit var db: RafiqDatabase
    private lateinit var repo: SupplierRepository
    private var ownerId = 0L
    private var workerId = 0L

    @Before
    fun setUp() {
        db = RafiqDatabase.build(ApplicationProvider.getApplicationContext(), inMemory = true)
        repo = SupplierRepository(db)
        ownerId = db.users().getAll().first { it.role == "owner" }.id
        workerId = db.users().getAll().first { it.role == "worker" }.id
    }

    @After
    fun tearDown() {
        db.close()
    }

    private fun openShift(): Long {
        val id = db.shifts().insert(ShiftEntity(openedBy = ownerId, openingCents = 0L))
        db.cashMovements().insert(CashMovementEntity(shiftId = id, kind = "open", amountCents = 0L, userId = ownerId))
        return id
    }

    private fun supplier(
        name: String = "ألبان",
        kind: String = "fixed",
        periodicity: String = "weekly",
        returnable: Int = 0,
        lastVisitAt: String? = null,
    ): Long = db.suppliers().insert(
        SupplierEntity(name = name, kind = kind, periodicity = periodicity,
            returnable = returnable, lastVisitAt = lastVisitAt)
    )

    private fun failMessage(r: RepoResult<*>): String {
        assertTrue("توقعنا الرفض، لكن جاء: $r", r is RepoResult.Failed)
        return (r as RepoResult.Failed).message
    }

    private fun ok(r: RepoResult<*>) {
        assertTrue("توقعنا النجاح، لكن جاء: $r", r is RepoResult.Ok<*>)
    }

    @Test
    fun `الاستلام يزيد ما علينا له ويُحسب زيارة`() {
        val sid = supplier()
        ok(repo.receive(sid, 10000L, "", ownerId))
        assertEquals(10000L, repo.balance(sid))
        assertNotNull(db.suppliers().getById(sid)!!.lastVisitAt)
    }

    @Test
    fun `الرصيد الكامل استلام ناقص سداد ناقص مرتجع`() {
        openShift()
        val sid = supplier(returnable = 1)
        ok(repo.receive(sid, 10000L, "", ownerId))
        ok(repo.pay(sid, 4000L, "", ownerId))
        ok(repo.returnGoods(sid, 1000L, "", ownerId))
        assertEquals(5000L, repo.balance(sid))
    }

    @Test
    fun `السداد للمالك فقط`() {
        openShift()
        val sid = supplier()
        repo.receive(sid, 5000L, "", ownerId)
        assertEquals("هذه الحركة للمالك فقط", failMessage(repo.pay(sid, 1000L, "", workerId)))
        assertEquals(5000L, repo.balance(sid))
    }

    @Test
    fun `السداد يحتاج وردية ولا يتم بدونها`() {
        val sid = supplier()
        repo.receive(sid, 5000L, "", ownerId)
        assertTrue(failMessage(repo.pay(sid, 1000L, "", ownerId)).contains("الصندوق مغلق"))
        assertEquals(5000L, repo.balance(sid))
    }

    @Test
    fun `السداد يخصم من الدرج ويُنقص الرصيد`() {
        val shiftId = openShift()
        val sid = supplier()
        repo.receive(sid, 5000L, "", ownerId)
        ok(repo.pay(sid, 2000L, "", ownerId))
        assertEquals(3000L, repo.balance(sid))
        assertEquals(-2000L, db.cashMovements().sumForShift(shiftId))  // بداية 0 − سداد 2000
    }

    @Test
    fun `المرتجع يُرفض للبنود غير القابلة للرجعة`() {
        val sid = supplier(returnable = 0)
        repo.receive(sid, 5000L, "", ownerId)
        assertEquals("«ألبان» غير قابل للمرتجع (مثل الثلج) — لا يمكن تسجيل رجعة",
            failMessage(repo.returnGoods(sid, 1000L, "", ownerId)))
        assertEquals(5000L, repo.balance(sid))
    }

    @Test
    fun `لا يُوقف المورد وحسابه غير مصفّى ويُعاد تفعيله دائماً`() {
        val sid = supplier(name = "خبز")
        repo.receive(sid, 1250L, "", ownerId)
        assertEquals("لا يمكن إيقاف «خبز» وحسابه غير مصفّى (12.50).",
            failMessage(repo.setActive(sid, false)))
        assertTrue(db.suppliers().getById(sid)!!.active == 1)

        openShift()
        ok(repo.pay(sid, 1250L, "", ownerId))
        ok(repo.setActive(sid, false))
        assertTrue(db.suppliers().getById(sid)!!.active == 0)
        ok(repo.setActive(sid, true))
        assertTrue(db.suppliers().getById(sid)!!.active == 1)
    }

    @Test
    fun `الزيارة تُخرج المندوب من قائمة المتوقع اليوم`() {
        val sid = supplier(name = "مندوب", kind = "delegate", periodicity = "weekly")
        val before = repo.dueList("2026-10-13")
        assertEquals(1, before.delegatesDue)

        ok(repo.visit(sid, ownerId))
        val today = db.suppliers().getById(sid)!!.lastVisitAt!!.take(10)
        val after = repo.dueList(today)
        assertEquals(0, after.delegatesDue)
    }

    @Test
    fun `المندوب المتأخر يُحسب في المتأخرين`() {
        // أسبوعي: متوقع بعد 7 أيام، ومتأخر بعد 10. آخر زيارة قبل 12 يوماً
        supplier(name = "متأخر", kind = "delegate", periodicity = "weekly", lastVisitAt = "2026-10-01 09:00:00")
        val counts = repo.dueList("2026-10-13")
        assertEquals(1, counts.delegatesDue)
        assertEquals(1, counts.totalLate)
    }

    @Test
    fun `المورد العادي لا يدخل قائمة المتوقع`() {
        supplier(name = "مورد", kind = "fixed", periodicity = "daily")
        assertEquals(0, repo.dueList("2026-10-13").totalDue)
    }
}
