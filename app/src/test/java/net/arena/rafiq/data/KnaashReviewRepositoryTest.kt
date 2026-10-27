package net.arena.rafiq.data

import androidx.test.core.app.ApplicationProvider
import net.arena.rafiq.domain.KnaashReviewRules
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class KnaashReviewRepositoryTest {
    private lateinit var db: RafiqDatabase
    private lateinit var repo: KnaashReviewRepository
    private val hash = "a".repeat(64)
    private val otherHash = "b".repeat(64)

    @Before fun setUp() {
        db = RafiqDatabase.build(ApplicationProvider.getApplicationContext(), inMemory = true)
        repo = KnaashReviewRepository(db)
    }
    @After fun tearDown() { db.close() }

    private fun save(index: Int, mode: String, id: Long? = null, name: String = "",
                     phone: String = "", balance: Long? = null, sha: String = hash) =
        repo.save(sha, "2026-10-14", 3,
            KnaashReviewRules.Choice(index, mode, id, name, phone, balance))

    @Test fun `يحفظ مراجعة في الهاتف دون إنشاء زبون أو تعديل مبلغ`() {
        val existing = db.customers().insert(CustomerEntity(name = "عميل تجربة", openingCents = 0))
        assertTrue(save(1, "existing", id = existing) is RepoResult.Ok)
        assertTrue(save(2, "new", name = "زبون جديد", phone = "+967000000002") is RepoResult.Ok)
        assertTrue(save(3, "zero", balance = 0L) is RepoResult.Ok)
        val loaded = repo.load(hash, "2026-10-14", 3) as RepoResult.Ok
        assertEquals(3, loaded.value.choices.size)
        assertEquals(listOf("existing", "new", "zero"), loaded.value.choices.map { it.mode })
        assertEquals(0L, db.customers().getById(existing)!!.openingCents)
        assertEquals(1, db.customers().getAllIncludingInactive().size)
        assertTrue(db.importLogs().getAll().isEmpty())
        val raw = db.settings().get(KnaashReviewRepository.SETTING_KEY)!!.value
        assertTrue(raw.contains(hash))
        assertTrue(!raw.contains("pdf_b64") && !raw.contains("given_cents"))
    }

    @Test fun `التكرار أو الرصيد القائم يرفض ولا يمس المراجعة السابقة`() {
        val id = db.customers().insert(CustomerEntity(name = "موجود"))
        assertTrue(save(1, "existing", id = id) is RepoResult.Ok)
        val first = db.settings().get(KnaashReviewRepository.SETTING_KEY)!!.value
        assertTrue(save(2, "existing", id = id) is RepoResult.Failed)
        assertEquals(first, db.settings().get(KnaashReviewRepository.SETTING_KEY)!!.value)
        db.invoices().insert(InvoiceEntity(number = 1, userId = db.users().getAll().first().id,
            customerId = id, totalCents = 100L, paidCents = 100L, dueCents = 0L))
        assertTrue(repo.searchCustomers("موجود").single().second) // حتى فاتورة مسددة بالكامل هي تاريخ سابق
        assertTrue(repo.load(hash, "2026-10-14", 3) is RepoResult.Ok)
        val problem = (repo.load(hash, "2026-10-14", 3) as RepoResult.Ok).value.currentProblem
        assertTrue(problem!!.contains("حركات"))
        assertTrue(save(2, "new", name = "غير مكرر") is RepoResult.Failed)
        assertEquals(first, db.settings().get(KnaashReviewRepository.SETTING_KEY)!!.value)
    }

    @Test fun `لا يخلط كشفين مختلفين ويحذف المراجعة فقط بطلب صريح`() {
        assertNull((repo.load(hash, "2026-10-14", 3) as RepoResult.Ok).value.currentProblem)
        assertTrue(save(1, "new", name = "زبون ملف أول") is RepoResult.Ok)
        val other = repo.load(otherHash, "2026-10-14", 3) as RepoResult.Ok
        assertTrue(other.value.otherFile)
        assertTrue(other.value.choices.isEmpty())
        assertEquals(hash, other.value.previousSha256)
        assertTrue(save(1, "new", name = "زبون ملف آخر", sha = otherHash) is RepoResult.Failed)
        assertTrue(repo.clear(otherHash) is RepoResult.Failed)
        assertTrue(repo.clear(hash) is RepoResult.Ok)
        assertTrue(save(1, "new", name = "زبون ملف آخر", sha = otherHash) is RepoResult.Ok)
        val reopened = (repo.load(otherHash, "2026-10-14", 3) as RepoResult.Ok).value
        assertEquals(false, reopened.otherFile)
        assertEquals("زبون ملف آخر", reopened.choices.single().name)
    }

    @Test fun `اسم أو هاتف مكرر مع زبون آخر يمنع إنشاء نسخة ثانية`() {
        db.customers().insert(CustomerEntity(name = "أحمد أول", phone = "+967000000001", active = 0))
        assertTrue(save(1, "new", name = "احمد اول") is RepoResult.Failed)
        assertTrue(save(1, "new", name = "مختلف", phone = "967000000001") is RepoResult.Failed)
        assertTrue(save(1, "zero", balance = 1L) is RepoResult.Failed)
        assertNull(db.settings().get(KnaashReviewRepository.SETTING_KEY))
    }
}
