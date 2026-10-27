package net.arena.rafiq.web

import androidx.test.core.app.ApplicationProvider
import net.arena.rafiq.cloud.CloudConfiguration
import net.arena.rafiq.cloud.CloudConfigurationStorage
import net.arena.rafiq.data.CashRepository
import net.arena.rafiq.data.ProductEntity
import net.arena.rafiq.data.RafiqDatabase
import net.arena.rafiq.data.RepoResult
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import java.net.URLEncoder

@RunWith(RobolectricTestRunner::class)
class NativeApiTest {

    private lateinit var db: RafiqDatabase
    private lateinit var api: NativeApi
    private var ownerId = 0L

    @Before
    fun setUp() {
        db = RafiqDatabase.build(ApplicationProvider.getApplicationContext(), inMemory = true)
        api = NativeApi(db)
        ownerId = db.users().getAll().first { it.role == "owner" }.id
        api.signInAs(ownerId)
    }

    @After
    fun tearDown() {
        db.close()
    }

    /** يعيد (الحالة، جسم الرد) بعد فكّ الغلاف الذي يمرّره الجسر. */
    private fun call(method: String, url: String, body: String = ""): Pair<Int, JSONObject> {
        val outer = JSONObject(api.api(method, url, body))
        return outer.getInt("status") to JSONObject(outer.getString("body"))
    }

    private fun milk(): Long = db.products().insert(
        ProductEntity(name = "حليب", barcode = "111", priceCents = 1000L, stock = 5.0)
    )

    private fun saleBody(pid: Long, qty: Int, received: Long): String =
        JSONObject()
            .put("items", JSONArray().put(JSONObject().put("product_id", pid).put("qty", qty)))
            .put("payment_type", "cash")
            .put("received_cents", received)
            .toString()

    @Test
    fun `البحث يعيد الصنف بالحقول نفسها في النسخة الأصلية`() {
        milk()
        val q = URLEncoder.encode("حليب", "UTF-8")
        val (status, body) = call("GET", "/api/search?q=$q")
        assertEquals(200, status)
        assertTrue(body.getBoolean("ok"))
        val p = body.getJSONArray("products").getJSONObject(0)
        assertEquals("حليب", p.getString("name"))
        assertEquals(1000L, p.getLong("price_cents"))
        assertEquals("111", p.getString("barcode"))
    }

    @Test
    fun `البيع بلا وردية مفتوحة يُرفض`() {
        val pid = milk()
        val (status, res) = call("POST", "/api/sale", saleBody(pid, 1, 1000L))
        assertEquals(400, status)
        assertFalse(res.getBoolean("ok"))
    }

    @Test
    fun `البيع النقدي بعد فتح الوردية ينجح ويعيد رقم الفاتورة`() {
        val pid = milk()
        assertTrue(CashRepository(db).open(0L, ownerId) is RepoResult.Ok)
        val (status, res) = call("POST", "/api/sale", saleBody(pid, 2, 2000L))
        assertEquals(200, status)
        assertTrue(res.getBoolean("ok"))
        assertEquals(1L, res.getLong("number"))
        assertTrue(res.has("total"))
    }

    /** يعيد (الحالة، جسم الرد) من page(). */
    private fun page(method: String, path: String, body: String = ""): JSONObject =
        JSONObject(api.page(method, path, body))

    @Test
    fun `صفحة الدخول تعرض المستخدمين النشطين بالترتيب الأصلي`() {
        val res = page("GET", "/login")
        assertEquals("login.html", res.getString("template"))
        val users = res.getJSONObject("ctx").getJSONArray("users")
        assertEquals(3, users.length())
        assertEquals("worker", users.getJSONObject(0).getString("role"))   // ORDER BY role DESC
        assertEquals("owner", users.getJSONObject(2).getString("role"))
    }

    @Test
    fun `الرمز الخاطئ يعيد إلى الدخول برسالة خطأ ولا يسجّل`() {
        api.signInAs(0L)   // لا يوجد مستخدم بالرقم 0، أي أن الجلسة فارغة
        val res = page("POST", "/auth", JSONObject().put("uid", ownerId).put("pin", "9999").toString())
        assertEquals("/login", res.getString("redirect"))
        val after = page("GET", "/login")
        assertEquals("error", after.getJSONArray("flashes").getJSONArray(0).getString(0))
        assertEquals("/login", page("GET", "/pos").getString("redirect"))
    }

    @Test
    fun `الرمز الصحيح يفتح البيع والصفحات تتطلب الدخول`() {
        page("GET", "/logout")   // setUp سجّل الدخول؛ نبدأ من جلسة فارغة
        assertEquals("/login", page("GET", "/pos").getString("redirect"))
        val ok = page("POST", "/auth", JSONObject().put("uid", ownerId).put("pin", "1111").toString())
        assertEquals("/", ok.getString("redirect"))
        val pos = page("GET", "/pos")
        assertEquals("pos.html", pos.getString("template"))
        assertEquals("owner", pos.getJSONObject("ctx").getJSONObject("u").getString("role"))
    }

    @Test
    fun `فتح الوردية من شاشة الصندوق يحدّث الحالة ويعيد التوجيه`() {
        val res = page("POST", "/cash/open", JSONObject().put("amount", "500").toString())
        assertEquals("/cash", res.getString("redirect"))
        val cash = page("GET", "/cash")
        assertEquals("cash.html", cash.getString("template"))
        assertEquals(50000L, cash.getJSONObject("ctx").getJSONObject("shift").getLong("opening_cents"))
        assertEquals("ok", cash.getJSONArray("flashes").getJSONArray(0).getString(0))
    }

    @Test
    fun `حركة الصندوق بلا سبب تُرفض برسالة خطأ`() {
        page("POST", "/cash/open", JSONObject().put("amount", "100").toString())
        page("POST", "/cash/expense", JSONObject().put("amount", "10").put("reason", "").toString())
        val cash = page("GET", "/cash")
        val flashes = cash.getJSONArray("flashes")   // الرسالة الأخيرة هي رسالة الحركة المرفوضة
        assertEquals("error", flashes.getJSONArray(flashes.length() - 1).getString(0))
        assertEquals(10000L, cash.getJSONObject("ctx").getJSONObject("shift").getLong("opening_cents"))
        assertEquals(0L, cash.getJSONObject("ctx").getJSONObject("totals").getLong("expense"))   // لم تُسجَّل حركة
    }

    private fun customer(name: String, opening: Long): Long =
        db.customers().insert(net.arena.rafiq.data.CustomerEntity(name = name, openingCents = opening))

    @Test
    fun `قائمة الزبائن تعرض الرصيد والإجماليات كما في النسخة الأصلية`() {
        val cid = customer("علي", 5000L)
        val res = page("GET", "/customers")
        assertEquals("customers.html", res.getString("template"))
        val ctx = res.getJSONObject("ctx")
        val row = ctx.getJSONArray("rows").getJSONObject(0)
        assertEquals(cid, row.getLong("id"))
        assertEquals(5000L, row.getLong("balance_cents"))
        assertEquals(5000L, ctx.getLong("given"))
        assertEquals(0L, ctx.getLong("taken"))
        assertEquals(5000L, ctx.getLong("remaining"))
    }

    @Test
    fun `كشف الزبون يعرض المرحّل وسطر الرصيد`() {
        val cid = customer("سالم", 2000L)
        val res = page("GET", "/customers/$cid")
        assertEquals("customer_detail.html", res.getString("template"))
        val ev = res.getJSONObject("ctx").getJSONArray("ev")
        assertEquals(1, ev.length())
        assertEquals("given", ev.getJSONObject(0).getString("kind"))
        assertEquals(2000L, ev.getJSONObject(0).getLong("balance_after"))
    }

    @Test
    fun `التحصيل يُرفض بلا وردية ثم يُسجَّل بعد فتحها`() {
        val cid = customer("أحمد", 100_000L)   // 1000 ريال
        page("POST", "/customers/$cid/pay", JSONObject().put("amount", "300").toString())
        val rejected = page("GET", "/customers/$cid")
        val fl = rejected.getJSONArray("flashes")
        assertEquals("error", fl.getJSONArray(fl.length() - 1).getString(0))
        assertEquals(100_000L, rejected.getJSONObject("ctx").getJSONObject("c").getLong("balance_cents"))

        page("POST", "/cash/open", JSONObject().put("amount", "0").toString())
        page("POST", "/customers/$cid/pay", JSONObject().put("amount", "300").toString())
        val paid = page("GET", "/customers/$cid")
        assertEquals(70_000L, paid.getJSONObject("ctx").getJSONObject("c").getLong("balance_cents"))   // 700 ريال
    }

    @Test
    fun `إضافة الزبون من البيع ترسل نموذجاً مشفّراً وتعيد إلى الصفحة نفسها`() {
        val body = "name=" + URLEncoder.encode("خالد", "UTF-8") + "&phone=777&back=/pos"
        val res = page("POST", "/customers/add", body)
        assertEquals("/pos", res.getString("redirect"))
        val added = db.customers().getAll().single { it.name == "خالد" }
        assertEquals("777", added.phone)
    }

    @Test
    fun `الإضافة السريعة تعيد هوية الزبون نفسه ولو كان للاسم نظير وتستعمل رمزاً مطابقاً`() {
        val otherId = customer("سالم", 0L)
        val (createdStatus, createdBody) = call("POST", "/api/customers",
            JSONObject().put("name", "سالم").put("phone", "٠٧٧١").toString())
        assertEquals(200, createdStatus)
        val created = createdBody.getJSONObject("customer")
        val newId = created.getLong("id")
        assertTrue(newId != otherId)
        assertEquals("#" + newId.toString().padStart(5, '0'), created.getString("code"))
        assertEquals("٠٧٧١", created.getString("phone"))

        val (status, found) = call("GET", "/api/customers?q=" + URLEncoder.encode(created.getString("code"), "UTF-8"))
        assertEquals(200, status)
        assertEquals(1, found.getJSONArray("customers").length())
        assertEquals(newId, found.getJSONArray("customers").getJSONObject(0).getLong("id"))
        val (_, byName) = call("GET", "/api/customers?q=" + URLEncoder.encode("سالم", "UTF-8"))
        assertEquals(2, byName.getJSONArray("customers").length())

        val pid = milk()
        assertTrue(CashRepository(db).open(0L, ownerId) is RepoResult.Ok)
        val (saleStatus, _) = call("POST", "/api/sale", JSONObject()
            .put("items", JSONArray().put(JSONObject().put("product_id", pid).put("qty", 1)))
            .put("payment_type", "credit").put("customer_id", newId).toString())
        assertEquals(200, saleStatus)
        assertEquals(1000L, net.arena.rafiq.data.SalesRepository(db).customerBalance(newId))
        assertEquals(0L, net.arena.rafiq.data.SalesRepository(db).customerBalance(otherId))
    }

    @Test
    fun `صلاحية إنشاء زبون سريع تتبع شاشة البيع أو الزبائن ولا تمنح لعامل معزول`() {
        val worker = db.users().getAll().first { it.role == "worker" }
        db.settings().upsert(net.arena.rafiq.data.SettingEntity("perm_${worker.id}", ""))
        api.signInAs(worker.id)
        val (deniedStatus, _) = call("POST", "/api/customers", JSONObject().put("name", "زبون").toString())
        assertEquals(403, deniedStatus)
        db.settings().upsert(net.arena.rafiq.data.SettingEntity("perm_${worker.id}", "pos"))
        val (allowedStatus, allowed) = call("POST", "/api/customers", JSONObject().put("name", "زبون").toString())
        assertEquals(200, allowedStatus)
        assertEquals("زبون", allowed.getJSONObject("customer").getString("name"))
    }

    @Test
    fun `البحث بالموقع يعرض أصناف الممر ويعلن الوضع`() {
        db.products().insert(ProductEntity(name = "شاي", aisle = "3", shelf = "ب", priceCents = 500L, stock = 2.0))
        db.products().insert(ProductEntity(name = "زيت", aisle = "1", priceCents = 900L, stock = 9.0))
        val res = page("GET", "/find?q=" + URLEncoder.encode("ممر 3", "UTF-8"))
        assertEquals("find.html", res.getString("template"))
        val ctx = res.getJSONObject("ctx")
        assertEquals("location", ctx.getString("mode"))
        val rows = ctx.getJSONArray("res")
        assertEquals(1, rows.length())
        assertEquals("شاي", rows.getJSONObject(0).getString("name"))
    }

    @Test
    fun `البحث بالاسم يعمل وبلا عبارة لا يعرض شيئاً`() {
        db.products().insert(ProductEntity(name = "شاي أحمر", priceCents = 500L, stock = 2.0))
        val named = page("GET", "/find?q=" + URLEncoder.encode("شاي", "UTF-8"))
        val ctx = named.getJSONObject("ctx")
        assertEquals("name", ctx.getString("mode"))
        assertEquals(1, ctx.getJSONArray("res").length())
        val empty = page("GET", "/find")
        assertEquals(0, empty.getJSONObject("ctx").getJSONArray("res").length())
        assertEquals("", empty.getJSONObject("ctx").getString("mode"))
    }

    @Test
    fun `لوحة المالك تعرض الأرقام والمندوب المتوقع اليوم`() {
        db.products().insert(ProductEntity(name = "ملح", priceCents = 100L, stock = 2.0, lowStock = 5.0))
        db.products().insert(ProductEntity(name = "سكر", priceCents = 100L, stock = 20.0, lowStock = 5.0))
        db.suppliers().insert(net.arena.rafiq.data.SupplierEntity(name = "أبو خالد", kind = "delegate", periodicity = "weekly", goods = "روتي"))
        val res = page("GET", "/")
        assertEquals("dashboard.html", res.getString("template"))
        val ctx = res.getJSONObject("ctx")
        val stats = ctx.getJSONObject("stats")
        assertEquals(2, stats.getInt("products"))
        assertEquals(1, stats.getInt("low_stock"))
        assertEquals(1, stats.getInt("due_total"))
        assertEquals(1, stats.getInt("due_delegates"))
        assertEquals(0, stats.getInt("late_total"))
        assertEquals("أبو خالد", ctx.getJSONArray("due_list").getJSONObject(0).getString("name"))
        assertEquals("أسبوعي", ctx.getJSONObject("PL").getString("weekly"))
    }

    @Test
    fun expiryAlertShowsOnlyStockedProductsWithinConfigurableWindow() {
        fun date(delta: Int): String {
            val cal = java.util.Calendar.getInstance()
            cal.add(java.util.Calendar.DAY_OF_YEAR, delta)
            return java.text.SimpleDateFormat("yyyy-MM-dd", java.util.Locale.US).format(cal.time)
        }
        db.products().insert(ProductEntity(name = "منتهي", stock = 2.0, expiry = date(-1)))
        db.products().insert(ProductEntity(name = "قريب", stock = 4.0, expiry = date(10)))
        db.products().insert(ProductEntity(name = "بعيد", stock = 5.0, expiry = date(40)))
        db.products().insert(ProductEntity(name = "نفد", stock = 0.0, expiry = date(-2)))
        val ctx = page("GET", "/").getJSONObject("ctx")
        assertEquals(2, ctx.getInt("expiry_total"))
        assertEquals(1, ctx.getInt("expiry_expired"))
        assertEquals(1, ctx.getInt("expiry_near"))
        assertEquals(2, page("GET", "/products?expiry_alert=1").getJSONObject("ctx")
            .getJSONArray("rows").length())
        db.settings().upsert(net.arena.rafiq.data.SettingEntity("expiry_alert_days", "7"))
        assertEquals(1, page("GET", "/").getJSONObject("ctx").getInt("expiry_total"))
    }

    @Test
    fun `العامل يُحوَّل من الرئيسية إلى البيع`() {
        val worker = db.users().getAll().first { it.role == "worker" }
        api.signInAs(worker.id)
        val res = page("GET", "/")
        assertEquals("/pos", res.getString("redirect"))
    }

    @Test
    fun `إضافة صنف يدوياً تحفظه وتعيد إلى القائمة`() {
        val body = JSONObject()
            .put("name", "زيت عافية")
            .put("barcode", "6281000")
            .put("price", "12")
            .put("stock", "4")
            .put("aisle", "3")
            .put("shelf", "")
            .put("back", "products")
            .toString()
        val res = page("POST", "/products/new", body)
        assertEquals("/products", res.getString("redirect"))
        val saved = db.products().findByBarcode("6281000")
        assertTrue(saved != null)
        assertEquals("زيت عافية", saved!!.name)
        assertEquals(1200L, saved.priceCents)
        assertEquals(4.0, saved.stock, 0.0)
        assertEquals("3", saved.aisle)
        assertEquals("حبة", saved.unit)
    }

    @Test
    fun `الباركود المشترك يعرض اختيار الأوجه ويرفض تكرار الاسم نفسه أو الاسم الفارغ`() {
        db.products().insert(ProductEntity(name = "ماء بارد", barcode = "999", priceCents = 100L))
        val variant = JSONObject().put("name", "ماء عادي").put("barcode", "999")
            .put("price", "2").put("stock", "3").toString()
        assertEquals("/products", page("POST", "/products/new", variant).getString("redirect"))
        val lookup = call("POST", "/api/find", JSONObject().put("code", "999").toString()).second
        assertTrue(lookup.getBoolean("ok"))
        assertEquals(2, lookup.getJSONArray("choices").length())
        assertFalse(lookup.has("product")) // لا يضاف أول وجه تلقائياً
        assertEquals("ماء بارد", lookup.getJSONArray("choices").getJSONObject(0).getString("name"))
        val dup = JSONObject().put("name", "ماء عادي").put("barcode", "999").put("price", "1").toString()
        val r1 = page("POST", "/products/new", dup)
        assertEquals(200, r1.getInt("status"))
        assertEquals("product_form.html", r1.getString("template"))
        val empty = JSONObject().put("name", "  ").put("price", "1").put("back", "products").toString()
        assertEquals("/products", page("POST", "/products/new", empty).getString("redirect"))
        assertEquals(2, db.catalog().searchProducts("", 500).size)
    }

    @Test
    fun `العامل لا يدخل الأصناف`() {
        val worker = db.users().getAll().first { it.role == "worker" }
        api.signInAs(worker.id)
        val res = page("GET", "/products")
        assertEquals(403, res.getInt("status"))
        assertEquals("error.html", res.getString("template"))
    }

    @Test
    fun `تقرير اليوم يعرض الملخص والديون كما في النسخة الأصلية`() {
        customer("علي", 5000L)
        val res = page("GET", "/reports", JSONObject().put("date", "2026-10-14").toString())
        assertEquals("reports.html", res.getString("template"))
        val ctx = res.getJSONObject("ctx")
        assertEquals("2026-10-14", ctx.getString("d"))
        assertEquals(0, ctx.getJSONObject("summary").getInt("count"))
        val debts = ctx.getJSONArray("debts")
        assertEquals(1, debts.length())
        assertEquals(5000L, debts.getJSONObject(0).getLong("balance_cents"))
        assertEquals(5000L, ctx.getLong("debts_total"))
    }

    @Test
    fun `التقارير للمالك فقط والعامل يرى 403`() {
        val worker = db.users().getAll().first { it.role == "worker" }
        api.signInAs(worker.id)
        val res = page("GET", "/reports")
        assertEquals(403, res.getInt("status"))
        assertEquals("error.html", res.getString("template"))
    }

    @Test
    fun `تقرير اليوم على هاتف عربي يجد الفاتورة والتاريخ صالح لحقل date`() {
        val previous = java.util.Locale.getDefault()
        try {
            java.util.Locale.setDefault(java.util.Locale.forLanguageTag("ar-YE"))
            assertTrue(CashRepository(db).open(0L, ownerId) is RepoResult.Ok)
            val pid = milk()
            val (status, receipt) = call("POST", "/api/sale", saleBody(pid, 2, 2000L))
            assertEquals(200, status)

            val ctx = page("GET", "/reports").getJSONObject("ctx")
            val day = db.invoices().getById(receipt.getLong("invoice_id"))!!.createdAt.take(10)
            assertEquals(day, ctx.getString("d"))
            assertTrue(ctx.getString("d").matches(Regex("[0-9]{4}-[0-9]{2}-[0-9]{2}")))
            assertEquals(1, ctx.getJSONObject("summary").getInt("count"))
            assertEquals(1, ctx.getJSONArray("top").length())
            assertEquals("حليب", ctx.getJSONArray("top").getJSONObject(0).getString("name"))
            assertEquals(1, ctx.getJSONArray("invoices").length())

            val stats = page("GET", "/").getJSONObject("ctx").getJSONObject("stats")
            assertEquals(1, stats.getJSONObject("sales_today").getInt("c"))
        } finally {
            java.util.Locale.setDefault(previous)
        }
    }

    private fun addSupplierViaPage(name: String): Long {
        page("POST", "/suppliers/add", JSONObject().put("name", name).put("kind", "delegate")
            .put("periodicity", "weekly").put("goods", "حليب").toString())
        return db.supplierQueries().allList().single { it.name == name }.id
    }

    @Test
    fun `الاستلام يزيد الرصيد ويحفظ رقم الفاتورة في كشف المورد`() {
        val sid = addSupplierViaPage("ألبان الواحة")
        val r = page("POST", "/suppliers/$sid/receive", JSONObject().put("amount", "500").put("ref", "F-1").toString())
        assertEquals("/suppliers/$sid", r.getString("redirect"))
        val ctx = page("GET", "/suppliers/$sid").getJSONObject("ctx")
        assertEquals(50000L, ctx.getJSONObject("s").getLong("balance_cents"))
        val ev = ctx.getJSONArray("ev").getJSONObject(0)
        assertEquals("F-1", ev.getString("ref"))
        assertEquals(50000L, ev.getLong("balance_after"))
    }

    @Test
    fun `لا يُوقف المورد وحسابه غير مصفّى والعامل لا يسدّد`() {
        val sid = addSupplierViaPage("خبز الحي")
        page("POST", "/suppliers/$sid/receive", JSONObject().put("amount", "100").toString())
        page("POST", "/suppliers/$sid/toggle")
        val flashes = page("GET", "/suppliers/$sid").getJSONArray("flashes")
        val last = flashes.getJSONArray(flashes.length() - 1)
        assertEquals("error", last.getString(0))
        assertTrue(last.getString(1).startsWith("لا يمكن إيقاف «خبز الحي»"))
        assertEquals(1, db.supplierQueries().byId(sid)!!.active)

        val worker = db.users().getAll().first { it.role == "worker" }
        api.signInAs(worker.id)
        assertEquals(403, page("POST", "/suppliers/$sid/pay", JSONObject().put("amount", "10").toString()).getInt("status"))
    }

    @Test
    fun `الإعدادات تُحفظ والمفاتيح غير المحددة تصبح 0`() {
        val body = JSONObject().put("store_name", "بقالة الحي").put("country_code", "967")
            .put("low_stock_default", "7").put("allow_price_edit", "1").toString()
        assertEquals("/settings", page("POST", "/settings", body).getString("redirect"))
        assertEquals("بقالة الحي", db.settings().get("store_name")!!.value)
        assertEquals("7", db.settings().get("low_stock_default")!!.value)
        assertEquals("1", db.settings().get("allow_price_edit")!!.value)
        assertEquals("0", db.settings().get("allow_negative_stock")!!.value)
    }

    @Test
    fun `حفظ إعداد عام لا يلغي أذونات عامل لم تظهر خاناته ويمكن إلغاء المعروض عمدا`() {
        val workers = db.users().getAll().filter { it.role == "worker" }
        assertEquals(2, workers.size)
        val first = workers[0].id
        val second = workers[1].id
        db.settings().upsert(net.arena.rafiq.data.SettingEntity("perm_$first", "pos,find"))
        db.settings().upsert(net.arena.rafiq.data.SettingEntity("perm_$second", "pos,customers"))

        val ctx = page("GET", "/settings").getJSONObject("ctx")
        assertEquals(2, (0 until ctx.getJSONArray("users_list").length()).count {
            ctx.getJSONArray("users_list").getJSONObject(it).getString("role") == "worker"
        })
        page("POST", "/settings", JSONObject().put("store_name", "بقالة")
            .put("perm_${first}_products", "1").toString())
        assertEquals("pos,find", db.settings().get("perm_$first")!!.value)
        assertEquals("pos,customers", db.settings().get("perm_$second")!!.value)

        page("POST", "/settings", JSONObject().put("store_name", "بقالة")
            .put("perm_present_$first", "1").put("perm_${first}_pos", "1")
            .put("perm_${first}_products", "1").toString())
        assertEquals("pos,products", db.settings().get("perm_$first")!!.value)
        assertEquals("pos,customers", db.settings().get("perm_$second")!!.value)

        page("POST", "/settings", JSONObject().put("store_name", "بقالة")
            .put("perm_present_$first", "1").toString())
        assertEquals("", db.settings().get("perm_$first")!!.value)
        assertEquals("pos,customers", db.settings().get("perm_$second")!!.value)
    }

    @Test
    fun `إضافة عامل تتطلب رمزاً صريحاً ويمكن تغيير الرمز لاحقاً`() {
        page("POST", "/users", JSONObject().put("name", "سالم الجديد").toString())
        assertFalse(db.users().getAll().any { it.name == "سالم الجديد" })
        page("POST", "/users", JSONObject().put("name", "سالم الجديد").put("pin", "4816").toString())
        val added = db.users().getAll().single { it.name == "سالم الجديد" }
        assertEquals("worker", added.role)
        assertTrue(net.arena.rafiq.domain.PinHasher.verify(added.pin, "4816"))
        assertFalse(added.pin == "4816")
        page("POST", "/users", JSONObject().put("uid", added.id.toString()).put("pin", "5555").toString())
        assertTrue(net.arena.rafiq.domain.PinHasher.verify(db.users().getById(added.id)!!.pin, "5555"))
    }

    @Test
    fun `العامل لا يفتح الإعدادات`() {
        val worker = db.users().getAll().first { it.role == "worker" }
        api.signInAs(worker.id)
        assertEquals(403, page("GET", "/settings").getInt("status"))
    }

    private fun importPage(kind: String, filename: String, content: String) =
        page("POST", "/imports/upload", JSONObject().put("kind", kind)
            .put("filename", filename).put("content", content).toString())

    @Test
    fun `استيراد الأصناف معاينة ثم تأكيد يحدّث بالباركود ويضيف الجديد`() {
        db.products().insert(ProductEntity(barcode = "6281", name = "أرز قديم", priceCents = 1000L, stock = 1.0))
        val csv = "باركود,اسم الصنف,سعر البيع,الكمية,تاريخ الانتهاء\n" +
            "6281,أرز,27,40,2027-01-31\n" +
            "6282,شاي,8,24,31/12/2026\n"
        val preview = importPage("products", "items.csv", csv)
        assertEquals("import_preview.html", preview.getString("template"))
        val ctx = preview.getJSONObject("ctx")
        assertEquals(2, ctx.getInt("ok"))
        assertEquals(2, ctx.getJSONArray("records").length())

        val commit = page("POST", "/imports/commit", JSONObject().put("kind", "products")
            .put("token", ctx.getString("token")).toString())
        assertEquals("/imports", commit.getString("redirect"))
        assertEquals(2700L, db.catalog().anyProductByBarcode("6281")!!.priceCents)
        assertEquals("أرز", db.catalog().anyProductByBarcode("6281")!!.name)
        assertEquals("2026-12-31", db.catalog().activeProductByName("شاي")!!.expiry)

        val fl = page("GET", "/imports").getJSONArray("flashes").getJSONArray(0)
        assertTrue(fl.getString(1).contains("جديد 1 • محدَّث 1"))
    }

    @Test
    fun `الاستيراد لا يكتب على وجه عشوائي عند اشتراك الباركود`() {
        db.products().insert(ProductEntity(name = "بن فاتح", barcode = "701", stock = 4.0, priceCents = 100L))
        db.products().insert(ProductEntity(name = "بن غامق", barcode = "701", stock = 6.0, priceCents = 200L))
        val csv = "باركود,اسم الصنف,سعر البيع,الكمية\n701,بن جديد,50,99\n"
        val token = importPage("products", "coffee.csv", csv).getJSONObject("ctx").getString("token")
        page("POST", "/imports/commit", JSONObject().put("kind", "products").put("token", token).toString())
        val rows = db.products().allByBarcode("701")
        assertEquals(2, rows.size)
        assertEquals(mapOf("بن فاتح" to 100L, "بن غامق" to 200L), rows.associate { it.name to it.priceCents })
        assertEquals(mapOf("بن فاتح" to 4.0, "بن غامق" to 6.0), rows.associate { it.name to it.stock })
    }

    @Test
    fun `ملف بغير صيغة CSV يُرفض ولا يُحفظ شيء`() {
        val res = importPage("products", "items.xlsx", "x")
        assertEquals("/imports", res.getString("redirect"))
        val bad = page("POST", "/imports/commit", JSONObject().put("kind", "products")
            .put("token", "deadbeef").toString())
        assertEquals("/imports", bad.getString("redirect"))
        assertEquals(0, db.catalog().searchProducts("", 100).size)
    }

    @Test
    fun `مسار دين CSV القديم لا يضيف الرصيد مرتين ولا يقبل تأكيداً مباشراً`() {
        val existing = db.customers().insert(net.arena.rafiq.data.CustomerEntity(
            name = "محمد عبدالله", openingCents = 1500000L))
        val csv = "اسم الزبون,الهاتف,المبلغ\nمحمد عبدالله,0771234567,15000\nسعيد علي,,8500\n"
        repeat(2) {
            assertEquals("/imports", importPage("debts", "kanash.csv", csv).getString("redirect"))
            assertEquals("/imports", page("POST", "/imports/commit", JSONObject()
                .put("kind", "debts").put("token", "deadbeef").toString()).getString("redirect"))
        }
        assertEquals(1500000L, db.customers().getById(existing)!!.openingCents)
        assertEquals(null, db.catalog().customerByName("سعيد علي"))
        assertEquals(0, db.importLogs().getAll().size)
        val errors = page("GET", "/imports").getJSONArray("flashes")
        assertTrue((0 until errors.length()).any { errors.getJSONArray(it).getString(1).contains("مُعطل") })
    }

    @Test
    fun `الاستيراد للمالك فقط والعامل يرى 403`() {
        val worker = db.users().getAll().first { it.role == "worker" }
        api.signInAs(worker.id)
        assertEquals(403, page("GET", "/imports").getInt("status"))
    }

    @Test
    fun `الفاتورة تُعرض والإلغاء للمالك يُرجع المخزون ويعود إلى التقارير`() {
        val pid = milk()
        assertTrue(CashRepository(db).open(0L, ownerId) is RepoResult.Ok)
        call("POST", "/api/sale", saleBody(pid, 2, 2000L))
        val view = page("GET", "/invoice/1")
        assertEquals("invoice.html", view.getString("template"))
        val ctx = view.getJSONObject("ctx")
        assertEquals(1L, ctx.getJSONObject("inv").getLong("number"))
        assertEquals(1, ctx.getJSONArray("items").length())
        assertEquals(3.0, db.products().getById(pid)!!.stock, 0.001)

        assertEquals("/reports", page("POST", "/invoice/1/cancel").getString("redirect"))
        assertEquals(5.0, db.products().getById(pid)!!.stock, 0.001)
        assertEquals("cancelled", db.invoices().getById(1L)!!.status)
        val report = page("GET", "/reports")
        assertEquals(0L, report.getJSONObject("ctx").getJSONObject("summary").getLong("paid"))
        val fl = report.getJSONArray("flashes").getJSONArray(0)
        assertTrue(fl.getString(1).contains("تم إلغاء الفاتورة رقم 1"))
        assertEquals(0L, page("GET", "/").getJSONObject("ctx").getJSONObject("stats").getLong("cash_sales"))
    }

    @Test
    fun `إلغاء الفاتورة للعامل يُرفض ورقم غير موجود يعطي 404`() {
        val worker = db.users().getAll().first { it.role == "worker" }
        api.signInAs(worker.id)
        assertEquals(403, page("POST", "/invoice/1/cancel").getInt("status"))
        api.signInAs(ownerId)
        assertEquals(404, page("GET", "/invoice/999").getInt("status"))
    }

    @Test
    fun `تقرير الصندوق يطابق حركات اليوم ويعرض الوردية`() {
        assertTrue(CashRepository(db).open(0L, ownerId) is RepoResult.Ok)
        call("POST", "/api/sale", saleBody(milk(), 2, 2000L))
        val res = page("GET", "/cash/report")
        assertEquals("cash_report.html", res.getString("template"))
        val ctx = res.getJSONObject("ctx")
        assertEquals(1, ctx.getJSONArray("blocks").length())
        val b = ctx.getJSONArray("blocks").getJSONObject(0)
        assertEquals(2000L, b.getJSONObject("tot").getLong("sale"))
        assertEquals(2000L, b.getLong("expected"))
        assertEquals(2000L, ctx.getLong("day_in"))
        assertEquals(0L, ctx.getLong("day_out"))
    }

    @Test
    fun `تقرير الصندوق للمالك فقط ولا تُفتح وردية ثانية`() {
        val worker = db.users().getAll().first { it.role == "worker" }
        api.signInAs(worker.id)
        assertEquals(403, page("GET", "/cash/report").getInt("status"))
        api.signInAs(ownerId)
        assertTrue(CashRepository(db).open(0L, ownerId) is RepoResult.Ok)
        assertTrue(CashRepository(db).open(0L, ownerId) is RepoResult.Failed)
    }

    @Test
    fun `السحب من العامل لا يغيّر الدرج`() {
        assertTrue(CashRepository(db).open(0L, ownerId) is RepoResult.Ok)
        val worker = db.users().getAll().first { it.role == "worker" }
        val before = CashRepository(db).expectedNow()
        api.signInAs(worker.id)
        page("POST", "/cash/withdraw", JSONObject().put("amount", "10").put("reason", "سحب للمالك").toString())
        assertEquals(before, CashRepository(db).expectedNow())
    }

    private fun xlsxBase64(sheetXml: String): String {
        val bos = java.io.ByteArrayOutputStream()
        java.util.zip.ZipOutputStream(bos).use { zip ->
            zip.putNextEntry(java.util.zip.ZipEntry("xl/worksheets/sheet1.xml"))
            zip.write(sheetXml.toByteArray(Charsets.UTF_8))
            zip.closeEntry()
        }
        return android.util.Base64.encodeToString(bos.toByteArray(), android.util.Base64.NO_WRAP)
    }

    @Test
    fun `ملف XLSX يُقرأ ويُعاين وتاريخ الانتهاء الرقمي يصبح تاريخاً`() {
        val sheet = """<?xml version="1.0" encoding="UTF-8"?><worksheet><sheetData>""" +
            """<row r="1"><c r="A1" t="inlineStr"><is><t>باركود</t></is></c>""" +
            """<c r="B1" t="inlineStr"><is><t>اسم الصنف</t></is></c>""" +
            """<c r="C1" t="inlineStr"><is><t>سعر البيع</t></is></c>""" +
            """<c r="D1" t="inlineStr"><is><t>الكمية</t></is></c>""" +
            """<c r="E1" t="inlineStr"><is><t>تاريخ الانتهاء</t></is></c></row>""" +
            """<row r="2"><c r="A2" t="inlineStr"><is><t>6281</t></is></c>""" +
            """<c r="B2" t="inlineStr"><is><t>أرز</t></is></c><c r="C2"><v>27</v></c>""" +
            """<c r="D2"><v>40</v></c><c r="E2"><v>46418</v></c></row>""" +
            "</sheetData></worksheet>"
        val res = page("POST", "/imports/upload", JSONObject().put("kind", "products")
            .put("filename", "items.xlsx").put("content_b64", xlsxBase64(sheet)).toString())
        assertEquals("import_preview.html", res.getString("template"))
        val ctx = res.getJSONObject("ctx")
        assertEquals(1, ctx.getInt("ok"))
        val r = ctx.getJSONArray("records").getJSONObject(0)
        assertEquals("أرز", r.getString("name"))
        assertEquals("2027-01-31", r.getString("expiry"))
        assertEquals(2700L, r.getLong("price_cents"))
    }

    @Test
    fun `ملف CSV بترميز Windows-1256 يُقرأ عربياً`() {
        val bytes = "اسم الصنف,سعر البيع\nشاي,8\n".toByteArray(java.nio.charset.Charset.forName("windows-1256"))
        val b64 = android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP)
        val ctx = page("POST", "/imports/upload", JSONObject().put("kind", "products")
            .put("filename", "old.csv").put("content_b64", b64).toString()).getJSONObject("ctx")
        assertEquals(1, ctx.getInt("ok"))
        assertEquals("شاي", ctx.getJSONArray("records").getJSONObject(0).getString("name"))
    }

    @Test
    fun `معاينة كتالوج إنجليزي تفصل البيع عن الشراء وتحفظ رصيد الموجود`() {
        val id = db.products().insert(ProductEntity(name = "تجربة", barcode = "CODE-TEST",
            priceCents = 1200L, stock = 20.0))
        val csv = "barcode,item_name,category,unit,cost_price,selling_price\n" +
            "CODE-TEST,تجربة,طعام,حبة,11,15\n"
        val preview = page("POST", "/imports/upload", JSONObject().put("kind", "products")
            .put("filename", "catalog.csv").put("content", csv).toString())
        assertEquals("import_preview.html", preview.getString("template"))
        val ctx = preview.getJSONObject("ctx")
        assertEquals(1, ctx.getInt("ok"))
        val record = ctx.getJSONArray("records").getJSONObject(0)
        assertEquals(1100L, record.getLong("cost_cents"))
        assertEquals(1500L, record.getLong("price_cents"))
        assertFalse(record.getBoolean("stock_provided"))
        assertEquals(20.0, db.products().getById(id)!!.stock, 0.0) // معاينة فقط
        page("POST", "/imports/commit", JSONObject().put("kind", "products")
            .put("token", ctx.getString("token")).toString())
        assertEquals(1500L, db.products().getById(id)!!.priceCents)
        assertEquals(20.0, db.products().getById(id)!!.stock, 0.0)
    }

    @Test
    fun `نموذج الاستيراد يُرسل للتنزيل بترويسة صحيحة وصيغة الإكسل القديمة تُرفض`() {
        val d = page("GET", "/imports/template/products.csv").getJSONObject("download")
        assertEquals("نموذج_الأصناف.csv", d.getString("name"))
        assertTrue(d.getString("text").startsWith("\uFEFFباركود"))
        assertEquals(404, page("GET", "/imports/template/xyz.csv").getInt("status"))
        val old = page("POST", "/imports/upload", JSONObject().put("kind", "products")
            .put("filename", "old.xls").put("content", "a,b").toString())
        assertEquals("/imports", old.getString("redirect"))
    }

    @Test
    fun loginLocksAfterFiveWrongPinsThenAcceptsRightPin() {
        page("GET", "/logout")
        repeat(5) { page("POST", "/auth", JSONObject().put("uid", ownerId).put("pin", "0000").toString()) }
        val locked = page("POST", "/auth", JSONObject().put("uid", ownerId).put("pin", "1111").toString())
        assertEquals("/login", locked.getString("redirect"))
        assertEquals("/login", page("GET", "/pos").getString("redirect"))
        val flash = page("GET", "/login").getJSONArray("flashes").toString()
        assertTrue(flash.contains("محاولات كثيرة"))
    }

    @Test
    fun legacyPlainPinIsUpgradedToHashOnLogin() {
        db.users().setPin(ownerId, "1111")
        page("GET", "/logout")
        page("POST", "/auth", JSONObject().put("uid", ownerId).put("pin", "1111").toString())
        val stored = db.users().getById(ownerId)!!.pin
        assertTrue(net.arena.rafiq.domain.PinHasher.isHashed(stored))
        assertTrue(net.arena.rafiq.domain.PinHasher.verify(stored, "1111"))
    }

    @Test
    fun ownerDisplayNameCanChangeWithoutChangingPermissionsPinOrStoreName() {
        val store = db.settings().get("store_name")!!.value
        page("POST", "/users", JSONObject().put("uid", ownerId.toString()).put("name", "المدير").toString())
        val owner = db.users().getById(ownerId)!!
        assertEquals("المدير", owner.name)
        assertEquals("owner", owner.role)
        assertTrue(net.arena.rafiq.domain.PinHasher.verify(owner.pin, "1111"))
        assertEquals(store, db.settings().get("store_name")!!.value)
        val users = page("GET", "/login").getJSONObject("ctx").getJSONArray("users")
        assertTrue((0 until users.length()).any { users.getJSONObject(it).optString("name") == "المدير" })
        page("POST", "/users", JSONObject().put("uid", ownerId.toString()).put("name", "مدير\nآخر").toString())
        assertEquals("المدير", db.users().getById(ownerId)!!.name)
    }

    @Test
    fun pinMustBeFourDigits() {
        page("POST", "/users", JSONObject().put("uid", ownerId.toString()).put("pin", "12a4").toString())
        assertTrue(net.arena.rafiq.domain.PinHasher.verify(db.users().getById(ownerId)!!.pin, "1111"))
    }

    @Test
    fun licenseGateBlocksUntilValidLicenseIsEntered() {
        val pair = net.arena.rafiq.license.LicenseTestKit.keyPair()
        val pub = net.arena.rafiq.license.LicenseTestKit.publicKeyB64(pair)
        val now = System.currentTimeMillis()
        val gated = NativeApi(db, pub, "DEV-7")
        gated.signInAs(ownerId)
        assertEquals("/license", JSONObject(gated.page("GET", "/pos", "")).getString("redirect"))

        val token = net.arena.rafiq.license.LicenseTestKit.token(pair, "DEV-7", now - 86_400_000L, now + 30L * 86_400_000L)
        gated.page("POST", "/license", JSONObject().put("token", token).toString())
        assertEquals(token, db.settings().get("license_token")!!.value)
        assertFalse(JSONObject(gated.page("GET", "/pos", "")).has("redirect"))
    }

    @Test
    fun releaseRequiresOwnerToChangeSeedPinBeforeSaleAndDisablesSeedWorkers() {
        val pair = net.arena.rafiq.license.LicenseTestKit.keyPair()
        val pub = net.arena.rafiq.license.LicenseTestKit.publicKeyB64(pair)
        val now = System.currentTimeMillis()
        val gated = NativeApi(db, pub, "DEV-SEC", requireSecuritySetup = true)
        gated.signInAs(ownerId)
        val token = net.arena.rafiq.license.LicenseTestKit.token(pair, "DEV-SEC",
            now - 86_400_000L, now + 30L * 86_400_000L)
        gated.page("POST", "/license", JSONObject().put("token", token).toString())
        assertEquals("/setup", JSONObject(gated.page("GET", "/pos", "")).getString("redirect"))
        val blocked = JSONObject(gated.api("GET", "/api/search?q=milk", ""))
        assertEquals(403, blocked.getInt("status"))
        assertTrue(JSONObject(blocked.getString("body")).getBoolean("security_setup_required"))
        gated.page("POST", "/setup", JSONObject().put("new_pin", "1111")
            .put("confirm_pin", "1111").toString())
        assertEquals(null, db.settings().get("security_ready"))
        gated.page("POST", "/setup", JSONObject().put("new_pin", "8642")
            .put("confirm_pin", "8642").toString())
        assertEquals("1", db.settings().get("security_ready")!!.value)
        assertTrue(net.arena.rafiq.domain.PinHasher.verify(db.users().getById(ownerId)!!.pin, "8642"))
        assertEquals(0, db.users().getAll().count { it.role == "worker" && it.active == 1 })
        assertEquals("pos.html", JSONObject(gated.page("GET", "/pos", "")).getString("template"))
        val workerId = db.users().getAll().first { it.role == "worker" }.id
        gated.page("POST", "/users", JSONObject().put("uid", workerId.toString())
            .put("pin", "9473").toString())
        assertEquals(1, db.users().getById(workerId)!!.active)
    }

    @Test
    fun licenseExpiryBlocksSaleApiEvenWhenPosWasAlreadyOpen() {
        val pair = net.arena.rafiq.license.LicenseTestKit.keyPair()
        val pub = net.arena.rafiq.license.LicenseTestKit.publicKeyB64(pair)
        val now = System.currentTimeMillis()
        val day = 86_400_000L
        val gated = NativeApi(db, pub, "TRIAL-DEVICE")
        gated.signInAs(ownerId)
        val valid = net.arena.rafiq.license.LicenseTestKit.token(pair, "TRIAL-DEVICE", now - day, now + 30 * day)
        db.settings().upsert(net.arena.rafiq.data.SettingEntity("license_token", valid))
        assertEquals("pos.html", JSONObject(gated.page("GET", "/pos", "")).getString("template"))
        assertEquals(200, JSONObject(gated.api("GET", "/api/search?q=", "")).getInt("status"))

        // تحاكي انتهاء الرخصة بينما بقيت صفحة البيع مفتوحة دون تنقّل.
        val expired = net.arena.rafiq.license.LicenseTestKit.token(pair, "TRIAL-DEVICE", now - 40 * day, now - day)
        db.settings().upsert(net.arena.rafiq.data.SettingEntity("license_token", expired))
        val pid = milk()
        CashRepository(db).open(0L, ownerId)
        val res = JSONObject(gated.api("POST", "/api/sale", saleBody(pid, 1, 1000L)))
        assertEquals(403, res.getInt("status"))
        val body = JSONObject(res.getString("body"))
        assertTrue(body.getBoolean("license_required"))
        assertFalse(body.getBoolean("ok"))
        assertTrue(db.invoices().byNumber(1L) == null)
        assertEquals(5.0, db.products().getById(pid)!!.stock, 0.001)
        assertEquals(403, JSONObject(gated.api("GET", "/api/search?q=", "")).getInt("status"))
    }

    @Test
    fun expiredLicenseAllowsOwnerOnlyEncryptedBackupPageButNoTrading() {
        val pair = net.arena.rafiq.license.LicenseTestKit.keyPair()
        val pub = net.arena.rafiq.license.LicenseTestKit.publicKeyB64(pair)
        val now = System.currentTimeMillis()
        val day = 86_400_000L
        val gated = NativeApi(db, pub, "RESCUE-DEVICE")
        val expired = net.arena.rafiq.license.LicenseTestKit.token(pair, "RESCUE-DEVICE",
            now - 40 * day, now - day)
        db.settings().upsert(net.arena.rafiq.data.SettingEntity("license_token", expired))
        assertEquals("/login", JSONObject(gated.page("GET", "/rescue", "")).getString("redirect"))
        assertEquals("login.html", JSONObject(gated.page("GET", "/login", "")).getString("template"))
        val login = JSONObject(gated.page("POST", "/login",
            JSONObject().put("uid", ownerId).put("pin", "1111").toString()))
        assertEquals("/rescue", login.getString("redirect"))
        assertEquals("rescue.html", JSONObject(gated.page("GET", "/rescue", "")).getString("template"))
        assertEquals("/license", JSONObject(gated.page("GET", "/settings", "")).getString("redirect"))
        assertEquals(403, JSONObject(gated.api("GET", "/api/search?q=x", "")).getInt("status"))
        gated.signInAs(db.users().getAll().first { it.role == "worker" }.id)
        assertEquals(403, JSONObject(gated.page("GET", "/rescue", "")).getInt("status"))
    }

    @Test
    fun clockRollbackBlocksLicense() {
        val pair = net.arena.rafiq.license.LicenseTestKit.keyPair()
        val pub = net.arena.rafiq.license.LicenseTestKit.publicKeyB64(pair)
        val now = System.currentTimeMillis()
        val token = net.arena.rafiq.license.LicenseTestKit.token(pair, "DEV-8", now - 86_400_000L, now + 30L * 86_400_000L)
        db.settings().upsert(net.arena.rafiq.data.SettingEntity("license_token", token))
        // آخر تشغيل مسجّل بعد الآن بيوم: الساعة رجعت إلى الوراء
        db.settings().upsert(net.arena.rafiq.data.SettingEntity("license_last_seen", (now + 86_400_000L).toString()))
        val gated = NativeApi(db, pub, "DEV-8")
        gated.signInAs(ownerId)
        assertEquals("/license", JSONObject(gated.page("GET", "/pos", "")).getString("redirect"))
    }

    @Test
    fun licenseKeysAreHiddenFromWebSettings() {
        db.settings().upsert(net.arena.rafiq.data.SettingEntity("license_token", "secret-token-value"))
        val s = api.page("GET", "/settings", "")
        assertFalse(s.contains("secret-token-value"))
    }

    @Test
    fun storeLogoIsSavedOnlyWhenItIsAnImageOfReasonableSize() {
        val ok = "data:image/png;base64,iVBORw0KGgo="
        page("POST", "/settings", JSONObject().put("store_name", "بقالة").put("store_logo", ok).toString())
        assertEquals(ok, db.settings().get("store_logo")!!.value)

        val huge = "data:image/png;base64," + "A".repeat(200_001)
        page("POST", "/settings", JSONObject().put("store_name", "بقالة").put("store_logo", huge).toString())
        assertEquals(ok, db.settings().get("store_logo")!!.value)

        page("POST", "/settings", JSONObject().put("store_name", "بقالة").put("store_logo", "").toString())
        assertEquals("", db.settings().get("store_logo")!!.value)
    }

    private class FakeCloudStorage : CloudConfigurationStorage {
        val records = mutableMapOf<String, CloudConfiguration>()
        override fun save(storeBindingId: String, projectUrl: String, publishableKey: String) {
            records[storeBindingId] = CloudConfiguration(projectUrl, publishableKey, storeBindingId)
        }
        override fun read(storeBindingId: String): CloudConfiguration? = records[storeBindingId]
    }

    @Test
    fun `جسر الصندوق يعطي التهيئة العامة فقط ويغلق المضيف عند خروج الحساب المحلي`() {
        val storage = FakeCloudStorage()
        val allowed = mutableListOf<String?>()
        api = NativeApi(db, cloudStorage = storage, requireCloudOnboarding = true,
            enableServerShiftPilot = true, onCloudHostReady = { allowed.add(it) })
        api.signInAs(ownerId)
        assertTrue(JSONObject(api.cloudShiftPublicConfig()).has("error"))
        val url = "https://abcdefghijklmnopqrst.supabase.co"
        val key = "sb_publishable_" + "A".repeat(32) // قيمة تجريبية وهمية فقط
        assertEquals("/", page("POST", "/cloud/setup", JSONObject()
            .put("project_url", url).put("publishable_key", key).toString()).getString("redirect"))
        val public = JSONObject(api.cloudShiftPublicConfig())
        assertEquals(url, public.getString("url"))
        assertEquals(key, public.getString("key"))
        assertEquals(2, public.length()) // لا كلمة مرور ولا توكن Auth ولا معرّف ربط
        assertEquals(url, allowed.last())
        page("GET", "/logout")
        assertEquals(null, allowed.last())
        assertTrue(JSONObject(api.cloudShiftPublicConfig()).has("error"))
    }

    @Test
    fun ownerFirstRunCloudSetupIsDynamicStoreBoundAndDoesNotActivateSync() {
        val storage = FakeCloudStorage()
        api = NativeApi(db, cloudStorage = storage, requireCloudOnboarding = true)
        api.signInAs(ownerId)
        assertEquals("/cloud/setup", page("GET", "/pos").getString("redirect"))
        val initial = page("GET", "/cloud/setup")
        assertEquals("cloud_setup.html", initial.getString("template"))
        assertTrue(initial.getJSONObject("ctx").getBoolean("first_run"))
        assertFalse(initial.getJSONObject("ctx").getBoolean("configured"))
        val key = "sb_publishable_" + "A".repeat(32) // fabricated public test value only
        val bad = JSONObject().put("project_url", "https://example.org")
            .put("publishable_key", key).toString()
        assertEquals("/cloud/setup", page("POST", "/cloud/setup", bad).getString("redirect"))
        assertEquals(0, storage.records.size)
        val proper = JSONObject().put("project_url", "https://abcdefghijklmnopqrst.supabase.co")
            .put("publishable_key", key).toString()
        assertEquals("/", page("POST", "/cloud/setup", proper).getString("redirect"))
        assertEquals(1, storage.records.size)
        val stored = storage.records.values.single()
        assertEquals("https://abcdefghijklmnopqrst.supabase.co", stored.projectUrl)
        assertEquals(key, stored.publishableKey)
        assertEquals("pos.html", page("GET", "/pos").getString("template"))
        val view = page("GET", "/cloud/setup")
        assertTrue(view.getJSONObject("ctx").getBoolean("configured"))
        assertFalse("never re-render a saved key", view.toString().contains(key))
        assertFalse("store binding stays server-side", view.toString().contains(stored.storeBindingId))
        val different = JSONObject().put("project_url", "https://zyxwvutsrqponmlkjihg.supabase.co")
            .put("publishable_key", key).toString()
        assertEquals("/cloud/setup", page("POST", "/cloud/setup", different).getString("redirect"))
        assertEquals(stored.projectUrl, storage.records.values.single().projectUrl)
        val worker = db.users().getAll().first { it.role == "worker" }
        api.signInAs(worker.id)
        assertEquals(403, page("GET", "/cloud/setup").getInt("status"))
        assertEquals(403, page("POST", "/cloud/setup", proper).getInt("status"))
    }

    @Test
    fun ownerCanSkipCloudSetupWithoutUploadingOrBlockingLocalWork() {
        val storage = FakeCloudStorage()
        api = NativeApi(db, cloudStorage = storage, requireCloudOnboarding = true)
        api.signInAs(ownerId)
        assertEquals("/", page("POST", "/cloud/setup/skip").getString("redirect"))
        assertEquals(0, storage.records.size)
        assertEquals("pos.html", page("GET", "/pos").getString("template"))
    }

    @Test
    fun workerNeedsWindowPermissionAndOwnerCanGrantIt() {
        val worker = db.users().getAll().first { it.role == "worker" }
        // نافذة الأصناف ليست ضمن الافتراضي للعامل
        api.signInAs(worker.id)
        val unavailable = page("GET", "/products")
        assertEquals(403, unavailable.getInt("status"))
        assertTrue(unavailable.getJSONObject("ctx").getString("msg").contains("لم تُفعّل"))
        // المالك يمنحها من الإعدادات
        api.signInAs(ownerId)
        page("POST", "/settings", JSONObject().put("store_name", "بقالة")
            .put("perm_present_${worker.id}", "1")
            .put("perm_${worker.id}_products", "1").toString())
        api.signInAs(worker.id)
        assertEquals(200, page("GET", "/products").getInt("status"))
        // ونافذة التقارير ما زالت مغلقة
        assertEquals(403, page("GET", "/reports").getInt("status"))
        // الإعدادات تبقى للمالك دائماً، برسالة مختلفة عن نافذة قابلة للمنح.
        val ownerOnly = page("GET", "/settings")
        assertEquals(403, ownerOnly.getInt("status"))
        assertEquals("هذه الشاشة للمالك فقط.", ownerOnly.getJSONObject("ctx").getString("msg"))
    }

    @Test
    fun workerWithRevokedPosPermissionCannotSellThroughJsonApi() {
        val worker = db.users().getAll().first { it.role == "worker" }
        val pid = milk()
        CashRepository(db).open(0L, ownerId)
        page("POST", "/settings", JSONObject().put("store_name", "بقالة")
            .put("perm_present_${worker.id}", "1").toString())
        api.signInAs(worker.id)
        val blocked = call("POST", "/api/sale", saleBody(pid, 1, 1000L))
        assertEquals(403, blocked.first)
        assertEquals(403, call("GET", "/api/search?q=حليب").first)
        assertEquals(null, db.invoices().byNumber(1L))
        assertEquals(5.0, db.products().getById(pid)!!.stock, 0.0)
        api.signInAs(ownerId)
        page("POST", "/settings", JSONObject().put("store_name", "بقالة")
            .put("perm_present_${worker.id}", "1")
            .put("perm_${worker.id}_pos", "1").toString())
        api.signInAs(worker.id)
        assertEquals(200, call("POST", "/api/sale", saleBody(pid, 1, 1000L)).first)
    }

    @Test
    fun customerStatementCanBePrinted() {
        page("POST", "/customers/add", JSONObject().put("name", "زبون للطباعة").toString())
        val cid = db.customers().getAll().first { it.name == "زبون للطباعة" }.id
        val res = page("GET", "/customers/$cid/print")
        assertEquals("statement_print.html", res.getString("template"))
        assertEquals(200, res.getInt("status"))
    }

    @Test
    fun supplierStatementCanBePrinted() {
        page("POST", "/suppliers/add", JSONObject().put("name", "مورد للطباعة").toString())
        val sid = db.supplierQueries().allList().first { it.name == "مورد للطباعة" }.id
        val res = page("GET", "/suppliers/$sid/print")
        assertEquals("supplier_print.html", res.getString("template"))
        assertEquals(200, res.getInt("status"))
    }

    @Test
    fun oldInvoiceCanBeOpenedByNumberAndMissingNumberIsReported() {
        val missing = page("POST", "/invoice/by-number", JSONObject().put("n", "999999").toString())
        assertEquals("/reports", missing.getString("redirect"))
    }

    private fun waLogCount(): Long =
        db.openHelper.readableDatabase.query("SELECT COUNT(*) FROM wa_log").use { c -> c.moveToFirst(); c.getLong(0) }

    @Test
    fun `البيع الآجل بلا بيانات واتساب يُسجَّل تخطياً ولا يعطّل البيع`() {
        val pid = milk()
        assertTrue(CashRepository(db).open(0L, ownerId) is RepoResult.Ok)
        val cid = customer("زبون واتساب", 0L)
        val body = JSONObject()
            .put("items", JSONArray().put(JSONObject().put("product_id", pid).put("qty", 2)))
            .put("payment_type", "credit")
            .put("customer_id", cid)
            .put("paid_cents", 0L)
            .toString()
        val (status, res) = call("POST", "/api/sale", body)
        assertEquals(200, status)
        assertTrue(res.getBoolean("ok"))
        db.openHelper.readableDatabase.query("SELECT status FROM wa_log").use { c ->
            assertTrue(c.moveToFirst())
            assertEquals("skipped", c.getString(0))
        }
    }

    @Test
    fun `البيع النقدي لا يُرسل شيئاً إلى واتساب`() {
        val pid = milk()
        assertTrue(CashRepository(db).open(0L, ownerId) is RepoResult.Ok)
        val (status, _) = call("POST", "/api/sale", saleBody(pid, 1, 1000L))
        assertEquals(200, status)
        assertEquals(0L, waLogCount())
    }

    @Test
    fun `مشاركة PDF يراجع الصلاحيات والزبون والدين ولا ترسل واتساب تلقائيا`() {
        val pid = milk()
        val cid = db.customers().insert(net.arena.rafiq.data.CustomerEntity(
            name = "زبون تجربة", phone = "777123456", openingCents = 500L))
        assertTrue(CashRepository(db).open(0L, ownerId) is RepoResult.Ok)
        val body = JSONObject()
            .put("items", JSONArray().put(JSONObject().put("product_id", pid).put("qty", 2)))
            .put("payment_type", "credit")
            .put("customer_id", cid)
            .put("paid_cents", 0L).toString()
        val (status, sale) = call("POST", "/api/sale", body)
        assertEquals(200, status)
        val id = sale.getLong("invoice_id")
        val before = waLogCount() // البيع الآجل بدون Cloud API مسجّل «تخطّي» فقط.
        val draft = api.prepareManualInvoiceShare(id)
        assertEquals(ownerId, draft.userId)
        assertEquals("زبون تجربة", draft.customerName)
        assertTrue(draft.phone.endsWith("777123456"))
        assertEquals("حليب", draft.document.lines.single().name)
        assertTrue(draft.document.total.contains("20"))
        assertTrue(draft.document.debtTotal.contains("25")) // دين سابق 5 + فاتورة 20
        val screen = page("GET", "/invoice/$id").getJSONObject("ctx")
        assertEquals(2500L, screen.getJSONObject("customer").getLong("balance_cents"))
        assertEquals(before, waLogCount()) // مجرد تحضير PDF لا يرسل أو يكتب سجلاً جديداً.

        api.signInAs(0L)
        assertTrue(runCatching { api.prepareManualInvoiceShare(id) }.isFailure)
        val worker = db.users().getAll().first { it.role == "worker" }.id
        db.settings().upsert(net.arena.rafiq.data.SettingEntity("perm_$worker", "find"))
        api.signInAs(worker)
        assertTrue(runCatching { api.prepareManualInvoiceShare(id) }.isFailure)
        api.signInAs(ownerId)
        db.openHelper.writableDatabase.execSQL("UPDATE invoices SET status='cancelled' WHERE id=?", arrayOf(id))
        assertTrue(runCatching { api.prepareManualInvoiceShare(id) }.isFailure)
    }

    @Test
    fun `فاتورة بلا رقم زبون لا تفتح مشاركة PDF`() {
        val pid = milk()
        val cid = db.customers().insert(net.arena.rafiq.data.CustomerEntity(name = "بدون هاتف"))
        assertTrue(CashRepository(db).open(0L, ownerId) is RepoResult.Ok)
        val body = JSONObject()
            .put("items", JSONArray().put(JSONObject().put("product_id", pid).put("qty", 1)))
            .put("payment_type", "credit").put("customer_id", cid).put("paid_cents", 0L).toString()
        val (status, sale) = call("POST", "/api/sale", body)
        assertEquals(200, status)
        assertTrue(runCatching { api.prepareManualInvoiceShare(sale.getLong("invoice_id")) }.isFailure)
    }

    private fun paymentRows(): List<String> =
        db.openHelper.readableDatabase.query("SELECT method, amount_cents, reference FROM invoice_payments ORDER BY id").use { c ->
            val out = ArrayList<String>()
            while (c.moveToNext()) out.add("${c.getString(0)}:${c.getLong(1)}:${c.getString(2)}")
            out
        }

    private fun drawerSaleMovements(): Long =
        db.openHelper.readableDatabase.query("SELECT COALESCE(SUM(amount_cents), 0) FROM cash_movements WHERE kind = 'sale'").use { c ->
            c.moveToFirst(); c.getLong(0)
        }

    @Test
    fun cashSaleWithTransferSplitsDrawerFromTransferAndKeepsReference() {
        val pid = milk()
        assertTrue(CashRepository(db).open(0L, ownerId) is RepoResult.Ok)
        // الإجمالي 2000: حوالة 1500 بمرجع، والباقي نقداً 500
        val body = JSONObject()
            .put("items", JSONArray().put(JSONObject().put("product_id", pid).put("qty", 2)))
            .put("payment_type", "cash")
            .put("received_cents", 500L)
            .put("non_cash", JSONArray().put(JSONObject().put("method", "transfer").put("amount_cents", 1500L).put("reference", "TRX-9")))
            .toString()
        val (status, res) = call("POST", "/api/sale", body)
        assertEquals(200, status)
        assertTrue(res.getBoolean("ok"))
        assertEquals(500L, drawerSaleMovements())                        // الدرج يرى النقد فقط
        assertEquals(listOf("cash:500:", "transfer:1500:TRX-9"), paymentRows())
    }

    @Test
    fun nonCashPartWithoutReferenceIsRejected() {
        val pid = milk()
        assertTrue(CashRepository(db).open(0L, ownerId) is RepoResult.Ok)
        val body = JSONObject()
            .put("items", JSONArray().put(JSONObject().put("product_id", pid).put("qty", 2)))
            .put("payment_type", "cash")
            .put("non_cash", JSONArray().put(JSONObject().put("method", "wallet").put("amount_cents", 2000L).put("reference", "")))
            .toString()
        val (status, res) = call("POST", "/api/sale", body)
        assertEquals(400, status)
        assertFalse(res.getBoolean("ok"))
        assertEquals(emptyList<String>(), paymentRows())
    }

    @Test
    fun creditSaleWithWalletPartLeavesOnlyTheRestAsDebt() {
        val pid = milk()
        assertTrue(CashRepository(db).open(0L, ownerId) is RepoResult.Ok)
        val cid = customer("زبون محفظة", 0L)
        // الإجمالي 2000: محفظة 1000 بمرجع، والدين 1000
        val body = JSONObject()
            .put("items", JSONArray().put(JSONObject().put("product_id", pid).put("qty", 2)))
            .put("payment_type", "credit")
            .put("customer_id", cid)
            .put("paid_cents", 0L)
            .put("non_cash", JSONArray().put(JSONObject().put("method", "wallet").put("amount_cents", 1000L).put("reference", "W-77")))
            .toString()
        val (status, _) = call("POST", "/api/sale", body)
        assertEquals(200, status)
        assertEquals(0L, drawerSaleMovements())
        assertEquals(listOf("wallet:1000:W-77", "debt:1000:"), paymentRows())
    }

    @Test
    fun `تقارير النقد تجمع النقد الفعلي والتحصيل وتستبعد التحويل والمحفظة`() {
        val pid = milk()
        val cid = customer("زبون تقارير", 0L)
        assertTrue(CashRepository(db).open(0L, ownerId) is RepoResult.Ok)
        val mixed = JSONObject()
            .put("items", JSONArray().put(JSONObject().put("product_id", pid).put("qty", 2)))
            .put("payment_type", "cash")
            .put("received_cents", 500L)
            .put("non_cash", JSONArray().put(JSONObject().put("method", "transfer").put("amount_cents", 1500L).put("reference", "TR-1")))
        assertEquals(200, call("POST", "/api/sale", mixed.toString()).first)
        val credit = JSONObject()
            .put("items", JSONArray().put(JSONObject().put("product_id", pid).put("qty", 2)))
            .put("payment_type", "credit")
            .put("customer_id", cid)
            .put("paid_cents", 0L)
            .put("non_cash", JSONArray().put(JSONObject().put("method", "wallet").put("amount_cents", 1000L).put("reference", "W-1")))
        assertEquals(200, call("POST", "/api/sale", credit.toString()).first)
        assertTrue(net.arena.rafiq.data.SalesRepository(db).recordPayment(cid, 300L, "", ownerId) is RepoResult.Ok)

        val stats = page("GET", "/").getJSONObject("ctx").getJSONObject("stats")
        assertEquals(4000L, stats.getJSONObject("sales_today").getLong("t"))
        assertEquals(500L, stats.getLong("cash_sales"))
        assertEquals(300L, stats.getLong("collections"))
        val report = page("GET", "/reports").getJSONObject("ctx")
        assertEquals(4000L, report.getJSONObject("summary").getLong("total"))
        assertEquals(800L, report.getJSONObject("summary").getLong("paid"))
        assertEquals(300L, report.getLong("collections"))
        // عمود العامل يعرض كل طرق السداد، وليس النقد؛ يُعنون بهذا المعنى في القالب.
        assertEquals(3000L, report.getJSONArray("by_worker").getJSONObject(0).getLong("p"))
        assertEquals(500L, drawerSaleMovements())
    }

    @Test
    fun `مراجعة كناش محفوظة للمالك وحده ولا تظهر ضمن إعدادات العامل أو تغيّر رصيداً`() {
        val cid = db.customers().insert(net.arena.rafiq.data.CustomerEntity(name = "زبون وهمي", openingCents = 0L))
        val hash = "c".repeat(64)
        val content = JSONObject().put("sha", hash).put("date", "2026-10-14").put("count", 3)
            .put("choice", JSONObject().put("index", 1).put("mode", "existing").put("customer_id", cid))
        val (status, saved) = call("POST", "/api/imports/knaash/review", content.toString())
        assertEquals(200, status)
        assertEquals(1, saved.getInt("reviewed"))
        assertEquals(0L, db.customers().getById(cid)!!.openingCents)
        assertTrue(db.importLogs().getAll().isEmpty())
        val reopened = call("GET", "/api/imports/knaash/review?sha=$hash&date=2026-10-14&count=3")
        assertEquals(200, reopened.first)
        assertEquals(cid, reopened.second.getJSONArray("choices").getJSONObject(0).getLong("customer_id"))
        val found = call("GET", "/api/imports/knaash/customers?q=زبون")
        assertEquals(200, found.first)
        assertEquals(cid, found.second.getJSONArray("customers").getJSONObject(0).getLong("id"))
        val ownerCtx = page("GET", "/customers").getJSONObject("ctx")
        assertFalse(ownerCtx.getJSONObject("S").has("knaash_review_v1"))
        val workerId = db.users().getAll().first { it.role == "worker" }.id
        api.signInAs(workerId)
        assertEquals(403, call("GET", "/api/imports/knaash/review?sha=$hash&date=2026-10-14&count=3").first)
        assertEquals(403, call("GET", "/api/imports/knaash/customers?q=زبون").first)
        assertEquals(403, call("POST", "/api/imports/knaash/review", content.toString()).first)
        assertEquals(403, call("DELETE", "/api/imports/knaash/review?sha=$hash").first)
        assertFalse(page("GET", "/customers").getJSONObject("ctx").getJSONObject("S").has("knaash_review_v1"))
    }

    @Test
    fun `مسودة كناش ترفض ملفاً مختلفاً وتبقى قراءة فقط دون زر ترحيل`() {
        val source = "d".repeat(64)
        val data = JSONObject().put("sha", source).put("date", "2026-10-14").put("count", 2)
            .put("choice", JSONObject().put("index", 1).put("mode", "new").put("name", "اسم تجربة"))
        assertEquals(200, call("POST", "/api/imports/knaash/review", data.toString()).first)
        val bad = JSONObject(data.toString()).put("sha", "e".repeat(64))
        assertEquals(409, call("POST", "/api/imports/knaash/review", bad.toString()).first)
        assertTrue(call("GET", "/api/imports/knaash/review?sha=${"e".repeat(64)}&date=2026-10-14&count=2")
            .second.getBoolean("other_file"))
        assertEquals(409, call("DELETE", "/api/imports/knaash/review?sha=${"e".repeat(64)}").first)
        assertEquals(200, call("DELETE", "/api/imports/knaash/review?sha=$source").first)
        assertEquals(0, db.customers().getAllIncludingInactive().size)
        assertTrue(db.importLogs().getAll().isEmpty())
    }
}
