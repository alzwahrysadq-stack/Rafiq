package net.arena.rafiq.web

import android.webkit.JavascriptInterface
import net.arena.rafiq.MainActivity
import net.arena.rafiq.cloud.CloudConfigRules
import net.arena.rafiq.cloud.CloudConfiguration
import net.arena.rafiq.cloud.CloudConfigurationStorage
import net.arena.rafiq.data.CashRepository
import net.arena.rafiq.data.CatalogRepository
import net.arena.rafiq.data.CustomerEntity
import net.arena.rafiq.data.InvoiceEntity
import net.arena.rafiq.data.DebtFollowUp
import net.arena.rafiq.data.ImportRepository
import net.arena.rafiq.data.KnaashReviewRepository
import net.arena.rafiq.data.ProductEntity
import net.arena.rafiq.data.RafiqDatabase
import net.arena.rafiq.data.RepoResult
import net.arena.rafiq.data.RequestedLine
import net.arena.rafiq.data.SaleRequest
import net.arena.rafiq.whatsapp.InvoicePdf
import net.arena.rafiq.whatsapp.WhatsAppRules
import net.arena.rafiq.data.SalesRepository
import net.arena.rafiq.data.StockSharing
import net.arena.rafiq.data.SupplierRepository
import net.arena.rafiq.data.ShiftEntity
import net.arena.rafiq.data.UserEntity
import net.arena.rafiq.domain.CashRules
import net.arena.rafiq.domain.CustomerCode
import net.arena.rafiq.domain.CsvReader
import net.arena.rafiq.domain.ImportRules
import net.arena.rafiq.domain.KnaashReviewRules
import net.arena.rafiq.domain.Row
import net.arena.rafiq.domain.XlsxReader
import net.arena.rafiq.domain.Money
import net.arena.rafiq.domain.ShelfRules
import net.arena.rafiq.domain.SupplierRules
import net.arena.rafiq.domain.PinHasher
import net.arena.rafiq.license.LicenseResult
import net.arena.rafiq.license.LicenseVerifier
import org.json.JSONArray
import org.json.JSONObject

/** أسماء أنواع الحركات في الصندوق، كما في KIND_LABEL بالنسخة الأصلية. */
private val KIND_LABEL = linkedMapOf(
    "open" to "بداية وردية", "sale" to "بيع نقدي", "collection" to "تحصيل دين",
    "expense" to "مصروف", "withdraw" to "سحب", "cancel" to "إلغاء فاتورة", "income" to "دخل يدوي",
    "supplier_pay" to "سداد مورد/مندوب",
)

/**
 * الكود الذي تستدعيه الواجهة بدلاً من خادم Flask.
 *  - page(method, path, body): صفحات HTML. يعيد القالب والبيانات، أو إعادة توجيه.
 *  - api(method, url, body): واجهات JSON للبحث والبيع (بأشكال الردود نفسها في app.py).
 * الجلسة (من سجّل الدخول) تُحفظ هنا في الذاكرة طوال عمر التطبيق.
 */
private const val LICENSE_TOKEN_KEY = "license_token"
private const val LICENSE_LAST_SEEN_KEY = "license_last_seen"
private const val SECURITY_MIGRATION_KEY = "security_v2"
private const val SECURITY_READY_KEY = "security_ready"
// الجولة 9: internal — جسر الواجهة الموحدة (CloudNativeBridge) يستعمل المفتاحين نفسيهما لحفظ
// الإعداد السحابي من شاشة التهيئة الموحدة عند غيابه (مسار المالك المشفر نفسه، بلا WebView storage).
internal const val CLOUD_BINDING_KEY = "cloud_store_binding_id"
internal const val CLOUD_SETUP_SEEN_KEY = "cloud_setup_seen"
private const val LICENSE_CLOCK_TOLERANCE_MS = 5 * 60_000L
private const val MAX_LOGIN_FAILS = 5
private const val MAX_LOGO_CHARS = 200_000
private const val LOCK_MS = 5 * 60_000L

/**
 * @param licensePublicKey مفتاح التحقق من الرخص (Base64 لـ X.509). فارغ = لا توجد بوابة رخصة (نسخ التطوير).
 * @param deviceId معرّف الجهاز (ANDROID_ID) الذي تُربط به الرخصة.
 * @param requireSecuritySetup في Release فقط: يمنع البيع قبل تغيير رمز المالك وإيقاف رموز العمال الافتراضية.
 */
class NativeApi(
    private val db: RafiqDatabase,
    private val licensePublicKey: String = "",
    private val deviceId: String = "",
    private val requireSecuritySetup: Boolean = false,
    private val cloudStorage: CloudConfigurationStorage? = null,
    private val requireCloudOnboarding: Boolean = false,
    private val enableServerShiftPilot: Boolean = false,
    private val onCloudHostReady: ((String?) -> Unit)? = null,
) {

    @Volatile private var uid: Long? = null

    /**
     * ترقية الأمان الأولية: تُنفَّذ مرة عند أول طلب من الواجهة،
     * وطلبات الواجهة تأتي من خيط الخلفية. لا تُنفَّذ في البناء: قاعدة الهاتف ترفض الاستعلام
     * من الخيط الرئيسي، والبناء يحدث داخل onCreate للنشاط.
     */
    private val bootstrapped: Boolean by lazy {
        // جداول login_guard وwa_log تُنشأ الآن عند فتح القاعدة نفسها، كي تشملها اللقطة قبل أول صفحة.
        db.openHelper.writableDatabase
        // ترقية لمرة واحدة: إيقاف تلميح الرموز التجريبية في القواعد التي زُرعت قبل تغيير البذور
        if (db.settings().get(SECURITY_MIGRATION_KEY) == null) {
            db.settings().upsert(net.arena.rafiq.data.SettingEntity("demo_hint", "0"))
            db.settings().upsert(net.arena.rafiq.data.SettingEntity(SECURITY_MIGRATION_KEY, "1"))
        }
        true
    }

    private fun ensureBootstrap() = check(bootstrapped)
    private val flashes = mutableListOf<Pair<String, String>>()

    /** للاختبار وتسجيل الدخول البرمجي. */
    fun signInAs(userId: Long) {
        uid = userId
    }

    fun currentUser(): UserEntity? = uid?.let { db.users().getById(it) }?.takeIf { it.active == 1 }

    /* ======================= الصفحات ======================= */

    @JavascriptInterface
    fun page(method: String, path: String, body: String): String {
        // الأرشيف المحلي للقراءة فقط: كل كتابة مرفوضة صراحةً.
        if (MainActivity.archiveMode && !method.equals("GET", true))
            return """{"error":"archive_read_only"}"""
        ensureBootstrap()
        val p = path.substringBefore('?')
        val data = parseBody(body)
        // روابط مثل /find?q=… تحمل معاملاتها في المسار: تُدمج في البيانات إن لم تكن موجودة
        if (path.contains('?')) {
            for (pair in path.substringAfter('?').split('&')) {
                if (pair.isEmpty()) continue
                val key = java.net.URLDecoder.decode(pair.substringBefore('='), "UTF-8")
                if (!data.has(key)) {
                    data.put(key, java.net.URLDecoder.decode(pair.substringAfter('=', ""), "UTF-8"))
                }
            }
        }
        val m = method.uppercase()
        val out = try {
            pageRoute(m, p, data)
        } catch (e: Exception) {
            flashes.add("error" to (e.message ?: "خطأ غير متوقع"))
            redirect("/")
        }
        return out.toString()
    }

    /* ======================= صلاحيات العمال ======================= */

    /** النوافذ التي يستطيع المالك فتحها للعمال. الإعدادات وإدارة المستخدمين وإلغاء الفواتير للمالك وحده. */
    private val WORKER_SCREENS = listOf("pos", "find", "cash", "customers", "suppliers", "products", "reports", "imports")
    private val WORKER_SCREEN_LABELS = mapOf(
        "pos" to "البيع (نقطة البيع والفواتير)",
        "find" to "أين هذا الصنف؟",
        "cash" to "الصندوق والوردية",
        "customers" to "الزبائن وكشوف الحساب",
        "suppliers" to "الموردون",
        "products" to "الأصناف",
        "reports" to "التقارير",
        "imports" to "الاستيراد",
    )
    private val WORKER_DEFAULT = setOf("pos", "find", "cash", "customers", "suppliers")

    private fun workerScreens(userId: Long): Set<String> {
        val raw = db.settings().get("perm_$userId")?.value ?: return WORKER_DEFAULT
        return raw.split(',').map { it.trim() }.filter { it.isNotEmpty() }.toSet()
    }

    private fun canOpen(user: UserEntity, screen: String): Boolean =
        user.role == "owner" || screen in workerScreens(user.id)

    /** النافذة التي تنتمي إليها الصفحة، أو null للصفحات العامة (الرئيسية والخروج). */
    private fun screenOf(path: String): String? = when {
        path == "/pos" || path.startsWith("/invoice/") -> "pos"
        path == "/find" -> "find"
        path == "/cash/report" || path == "/reports" -> "reports"
        path == "/cash" || path.startsWith("/cash/") -> "cash"
        path == "/customers" || path.startsWith("/customers/") -> "customers"
        path == "/suppliers" || path.startsWith("/suppliers/") -> "suppliers"
        path == "/products" || path.startsWith("/products/") -> "products"
        path == "/imports" || path.startsWith("/imports/") -> "imports"
        else -> null
    }

    private fun pageRoute(method: String, path: String, data: JSONObject): JSONObject {
        if (path == "/logout") {
            // Same monitor as cloudShiftPublicConfig/cloudSetupRoute: no stale host callback can race logout.
            synchronized(this) {
                uid = null
                onCloudHostReady?.invoke(null)
            }
            return redirect("/login")
        }
        if (path == "/license") return licenseRoute(method, data)
        // استثناء قراءة فقط: عند انتهاء الرخصة يستطيع المالك تسجيل الدخول لإنقاذ نسخة مشفرة.
        // لا يُفتح له البيع ولا الإعدادات ولا أي API بلا رخصة سارية.
        if ((path == "/login" || path == "/auth") && method == "POST") return authenticate(data)
        if (path == "/login") return render("login.html", "login", path, loginContext())
        if (path == "/rescue") {
            val account = currentUser() ?: return redirect("/login")
            if (account.role != "owner") return forbidden(path)
            return render("rescue.html", "rescue", path, JSONObject()
                .put("u", userJson(account))
                .put("license_ok", licenseCheck(System.currentTimeMillis()).ok))
        }
        if (!licenseCheck(System.currentTimeMillis()).ok) return redirect("/license")

        val user = currentUser() ?: return redirect("/login")
        if (path == "/setup") return securitySetupRoute(method, user, data)
        if (securitySetupPending()) return if (user.role == "owner") redirect("/setup") else redirect("/login")
        if (path == "/cloud/setup" || path == "/cloud/setup/skip")
            return cloudSetupRoute(method, path, user, data)
        if (cloudSetupPending()) return if (user.role == "owner") redirect("/cloud/setup") else redirect("/login")
        if (path == "/cloud/pilot") return render("cloud_pilot.html", "cloud_pilot", path,
            JSONObject().put("u", userJson(user)))
        // فحص نافذة هذا الهاتف لا يمنح دوراً على الخادم؛ Auth/RLS يحسمان طلب الوردية.
        screenOf(path)?.let { if (!canOpen(user, it)) return forbiddenWorkerWindow(path) }
        if (enableServerShiftPilot && method == "POST" && path.startsWith("/cash/") && path != "/cash/report") {
            flashes.add("error" to "حركات الصندوق المحلية معروضة للقراءة فقط في اختبار الوردية؛ لا تُحوّلها إلى طلب خادمي")
            return redirect("/cash")
        }
        if (path.startsWith("/cash/") && method == "POST") return cashAction(path, user, data)
        if (path == "/customers" || path.startsWith("/customers/")) return customersRoute(method, path, user, data)
        if (path == "/products" || path.startsWith("/products/")) return productsRoute(method, path, user, data)
        if (path == "/suppliers" || path.startsWith("/suppliers/")) return suppliersRoute(method, path, user, data)
        if (path == "/settings") return settingsRoute(method, user, data)
        if (path == "/users") return usersRoute(method, user, data)
        if (path == "/imports" || path.startsWith("/imports/")) return importsRoute(method, path, user, data)
        if (path.startsWith("/invoice/")) return invoiceRoute(method, path, user, data)
        return when (path) {
            "/cash" -> render("cash.html", "cash", path, cashContext(user))
            "/cash/report" -> cashReport(path, user, data)
            "/", "/home" -> homePage(user)
            "/pos" -> render("pos.html", "pos", path, posContext(user))
            "/find" -> findPage(data.optString("q").trim(), user)
            "/reports" -> reportsPage(data, user)
            else -> notFound(path)
        }
    }

    /* ======================= الأصناف (للمالك فقط) ======================= */

    private fun productsRoute(method: String, path: String, user: UserEntity, data: JSONObject): JSONObject {
        val edit = Regex("^/products/(\\d+)/edit$").find(path)
        return when {
            method == "GET" && path == "/products" -> productsPage(
                data.optString("q").trim(), data.optString("expiry_alert") == "1",
            )
            method == "GET" && path == "/products/new" -> productForm(null)
            method == "POST" && path == "/products/new" -> saveProductRoute(null, data)
            method == "GET" && edit != null -> {
                val p = db.products().getById(edit.groupValues[1].toLong()) ?: return notFound(path)
                productForm(p)
            }
            method == "POST" && edit != null -> {
                val pid = edit.groupValues[1].toLong()
                if (db.products().getById(pid) == null) notFound(path) else saveProductRoute(pid, data)
            }
            else -> notFound(path)
        }
    }

    private fun productsPage(q: String, expiryAlert: Boolean): JSONObject {
        val days = expiryAlertDays()
        val cutoff = expiryCutoff(days)
        val rows = if (expiryAlert) db.catalog().expiringProducts(cutoff, 500)
            else db.catalog().searchProducts(q, 500)
        val ctx = JSONObject()
            .put("rows", JSONArray(rows.map { productJson(it) }))
            .put("q", q)
            .put("count", db.catalog().activeProductCount())
            .put("low", db.catalog().lowStockCount())
            .put("expiry_alert", expiryAlert)
            .put("expiry_days", days)
            .put("expiry_total", db.catalog().expiringCount(cutoff))
        return render("products.html", "products", "/products", ctx)
    }

    private fun productForm(p: ProductEntity?): JSONObject {
        val options = p?.barcode?.let { code -> db.products().allByBarcode(code) }
            .orEmpty().filter { it.id != p?.id && StockSharing.linkedRootId(db, it.id) == null }
        val ctx = JSONObject().put("p", p?.let { productJson(it) } ?: JSONObject.NULL)
            .put("share_choices", JSONArray(options.map { JSONObject()
                .put("id", it.id).put("name", it.name).put("stock", it.stock)
            }))
        val endpoint = if (p == null) "product_new" else "product_edit"
        return render("product_form.html", endpoint, if (p == null) "/products/new" else "/products/${p.id}/edit", ctx)
    }

    /** حفظ النموذج: نجاح إلى القائمة، وفشل إلى النموذج نفسه أو إلى القائمة إن أتى من الإضافة السريعة. */
    private fun saveProductRoute(pid: Long?, data: JSONObject): JSONObject {
        val form = HashMap<String, String?>()
        val keys = data.keys()
        while (keys.hasNext()) {
            val k = keys.next() as String
            form[k] = data.optString(k)
        }
        return when (val r = CatalogRepository(db).saveProduct(pid, form)) {
            is RepoResult.Ok -> {
                flashes.add("ok" to if (pid == null) "تمت إضافة الصنف" else "تم حفظ التعديل")
                redirect("/products")
            }
            is RepoResult.Failed -> {
                flashes.add("error" to r.message)
                if (data.optString("back") == "products") return redirect("/products")
                productForm(pid?.let { db.products().getById(it) })
            }
        }
    }

    private fun productJson(p: ProductEntity): JSONObject {
        val stockProduct = StockSharing.stockProduct(db, p)
        return JSONObject()
            .put("id", p.id)
            .put("name", p.name)
            .put("barcode", p.barcode ?: JSONObject.NULL)
            .put("unit", p.unit)
            .put("category", p.category)
            .put("cost_cents", p.costCents)
            .put("price_cents", p.priceCents)
            .put("stock", stockProduct?.stock ?: 0.0)
            .put("low_stock", stockProduct?.lowStock ?: 0.0)
            .put("shared_stock_with", StockSharing.linkedRootId(db, p.id) ?: JSONObject.NULL)
            .put("aisle", p.aisle)
            .put("shelf", p.shelf)
            .put("expiry", (stockProduct?.expiry ?: p.expiry) ?: JSONObject.NULL)
    }

    private fun forbiddenWorkerWindow(path: String): JSONObject = forbidden(
        path, "لم تُفعّل هذه النافذة لهذا العامل على هذا الهاتف. يمكن للمالك فتحها من الإعدادات المحلية.",
    )

    private fun forbidden(path: String, message: String = "هذه الشاشة للمالك فقط."): JSONObject {
        val ctx = JSONObject()
            .put("title", "غير مسموح")
            .put("icon", "🔒")
            .put("msg", message)
            .put("u", currentUser()?.let { userJson(it) } ?: JSONObject.NULL)
        return render("error.html", "error", path, ctx).put("status", 403)
    }

    /* ======================= لوحة المالك ======================= */

    private val PERIOD_LABEL = mapOf(
        "daily" to "يومي", "semi_daily" to "شبه يومي", "weekly" to "أسبوعي",
        "monthly" to "شهري", "irregular" to "عند الحاجة",
    )

    private fun expiryAlertDays(): Int = db.settings().get("expiry_alert_days")?.value?.toIntOrNull()
        ?.takeIf { it in 1..365 } ?: 30

    private fun debtFollowupDays(): Int = db.settings().get("debt_followup_days")?.value?.toIntOrNull()
        ?.takeIf { it in 1..365 } ?: 30

    private fun expiryCutoff(days: Int): String {
        val cal = java.util.Calendar.getInstance()
        cal.add(java.util.Calendar.DAY_OF_YEAR, days)
        return java.text.SimpleDateFormat("yyyy-MM-dd", java.util.Locale.US).format(cal.time)
    }

    /** كما home في النسخة الأصلية: للمالك فقط، والعامل يُحوَّل إلى البيع. */
    private fun homePage(user: UserEntity): JSONObject {
        if (user.role != "owner") return redirect("/pos")
        val today = todayIso()
        val catalog = db.catalog()
        val sales = SalesRepository(db)
        val suppliers = SupplierRepository(db)
        val expiryDays = expiryAlertDays()
        val expiryEnd = expiryCutoff(expiryDays)
        val expiryTotal = catalog.expiringCount(expiryEnd)
        val expired = catalog.expiredCount(today)

        val invoices = catalog.invoicesOn(today).filter { it.status == "open" }
        val debtBalances = catalog.allCustomerIds().mapNotNull { id ->
            db.customers().getById(id)?.let { it to sales.customerBalance(id) }
        }
        val debtsTotal = debtBalances.sumOf { it.second }
        val followupDays = debtFollowupDays()
        val debtAlerts = debtBalances.mapNotNull { (c, balance) ->
            DebtFollowUp.alert(db, c, balance, today, followupDays)
        }.sortedWith(compareByDescending<DebtFollowUp.Alert> { it.ageDays }
            .thenByDescending { it.balanceCents })

        // الموردون والمناديب: الرصيد الكلي لكل الموردين، والمتوقعون اليوم من النشطين
        val allSuppliers = db.supplierQueries().allList()
        val supplierDebt = allSuppliers.sumOf { suppliers.balance(it.id) }
        val rows = allSuppliers.filter { it.active == 1 }
            .sortedByDescending { suppliers.balance(it.id) }
            .map { s ->
                val days = SupplierRules.daysSince(s.lastVisitAt, today)
                val flags = SupplierRules.delegateFlags(
                    isDelegate = s.kind == "delegate", active = true,
                    periodicity = s.periodicity, daysSinceVisit = days,
                )
                DueRow(s, days, flags.dueToday, flags.overdue)
            }
        val dueRows = rows.filter { it.dueToday }
            .sortedWith(compareBy<DueRow>({ !it.overdue }, { -(it.days ?: 0) }))

        val shift = db.shifts().getOpen()
        val stats = JSONObject()
            .put("sales_today", JSONObject().put("t", invoices.sumOf { it.totalCents }).put("c", invoices.size))
            .put("cash_sales", catalog.netCashFromSalesOn(today))
            .put("collections", catalog.collectionsOn(today))
            .put("income_today", catalog.incomeOn(today))
            .put("new_debt", invoices.sumOf { it.dueCents })
            .put("debts_total", debtsTotal)
            .put("products", catalog.activeProductCount())
            .put("low_stock", catalog.lowStockCount())
            .put("supplier_debt", supplierDebt)
            .put("due_delegates", dueRows.count { it.supplier.kind == "delegate" })
            .put("due_total", dueRows.size)
            .put("late_total", rows.count { it.overdue })

        val top = JSONArray(dueRows.take(5).map { r ->
            JSONObject()
                .put("id", r.supplier.id)
                .put("name", r.supplier.name)
                .put("phone", r.supplier.phone)
                .put("goods", r.supplier.goods)
                .put("kind", r.supplier.kind)
                .put("periodicity", r.supplier.periodicity)
                .put("days", r.days ?: JSONObject.NULL)
                .put("overdue", r.overdue)
        })
        val ctx = JSONObject()
            .put("u", userJson(user))
            .put("today", today)
            .put("stats", stats)
            .put("shift", shiftJson(shift))
            .put("expected", if (shift != null) db.cashMovements().sumForShift(shift.id) else JSONObject.NULL)
            .put("due_list", top)
            .put("due_more", maxOf(0, dueRows.size - 5))
            .put("expiry_days", expiryDays)
            .put("expiry_total", expiryTotal)
            .put("expiry_expired", expired)
            .put("expiry_near", expiryTotal - expired)
            .put("expiry_rows", JSONArray(catalog.expiringProducts(expiryEnd, 6).map { p ->
                JSONObject().put("id", p.id).put("name", p.name)
                    .put("expiry", p.expiry ?: "").put("stock", p.stock)
                    .put("expired", p.expiry != null && p.expiry < today)
            }))
            .put("debt_followup_days", followupDays)
            .put("debt_followup_count", debtAlerts.size)
            .put("debt_followup_rows", JSONArray(debtAlerts.take(6).map { row ->
                JSONObject().put("id", row.customer.id).put("name", row.customer.name)
                    .put("balance_cents", row.balanceCents).put("age_days", row.ageDays)
                    .put("oldest", row.oldestDate)
            }))
            .put("PL", JSONObject().also { o -> PERIOD_LABEL.forEach { (k, v) -> o.put(k, v) } })
        return render("dashboard.html", "home", "/", ctx)
    }

    private class DueRow(
        val supplier: net.arena.rafiq.data.SupplierEntity,
        val days: Int?,
        val dueToday: Boolean,
        val overdue: Boolean,
    )

    /* ======================= الإعدادات والعاملون (للمالك) ======================= */

    private val SETTING_FLAGS = setOf("allow_negative_stock", "allow_price_edit", "demo_hint")
    private val SETTING_TEXT = listOf(
        "store_name", "store_phone", "country_code", "currency", "low_stock_default", "invoice_footer",
        "wa_phone_id", "wa_template", "wa_lang",
    )

    /** كما settings في النسخة الأصلية: الحفظ يكتب كل المفاتيح، والمفاتيح المنطقية تُكتب «1» أو «0». */
    private fun settingsRoute(method: String, user: UserEntity, data: JSONObject): JSONObject {
        if (user.role != "owner") return forbidden("/settings")
        if (method == "POST") {
            val days = data.optString("expiry_alert_days").trim().toIntOrNull()
            if (data.has("expiry_alert_days") && (days == null || days !in 1..365)) {
                flashes.add("error" to "تنبيه الصلاحية يتطلب عدداً بين يوم و365 يوماً")
                return redirect("/settings")
            }
            val followupDays = data.optString("debt_followup_days").trim().toIntOrNull()
            if (data.has("debt_followup_days") && (followupDays == null || followupDays !in 1..365)) {
                flashes.add("error" to "متابعة الديون تتطلب عدداً بين يوم و365 يوماً")
                return redirect("/settings")
            }
            val settings = db.settings()
            if (days != null) settings.upsert(net.arena.rafiq.data.SettingEntity("expiry_alert_days", days.toString()))
            if (followupDays != null) settings.upsert(net.arena.rafiq.data.SettingEntity("debt_followup_days", followupDays.toString()))
            for (k in SETTING_TEXT) {
                settings.upsert(net.arena.rafiq.data.SettingEntity(k, data.optString(k).trim()))
            }
            // توكن واتساب: يُستبدل فقط إن كُتب شيء جديد، ولا يُمسح بالحفظ العادي
            data.optString("wa_token").trim().takeIf { it.isNotEmpty() }?.let {
                settings.upsert(net.arena.rafiq.data.SettingEntity("wa_token", it))
            }
            for (k in SETTING_FLAGS) {
                settings.upsert(net.arena.rafiq.data.SettingEntity(k, if (data.optString(k) == "1") "1" else "0"))
            }
            // لا تمس أذونات عامل لم تُعرَض له خانات في النموذج (مثل قالب قديم معطوب).
            // إذا ظهرت علامته، يسمح إلغاء كل المربعات عمداً بجعل المجموعة فارغة.
            for (w in db.users().getAll().filter { it.role == "worker" }) {
                if (data.optString("perm_present_${w.id}") != "1") continue
                val allowed = WORKER_SCREENS.filter { data.optString("perm_${w.id}_$it") == "1" }
                settings.upsert(net.arena.rafiq.data.SettingEntity("perm_${w.id}", allowed.joinToString(",")))
            }
            // شعار المتجر: صورة PNG مصغّرة من المتصفح (data URL)، وبحد أقصى لحجم التخزين
            val logo = data.optString("store_logo").trim()
            if (logo.isEmpty() || (logo.startsWith("data:image/") && logo.length <= MAX_LOGO_CHARS)) {
                settings.upsert(net.arena.rafiq.data.SettingEntity("store_logo", logo))
            }
            flashes.add("ok" to "تم حفظ الإعدادات")
            return redirect("/settings")
        }
        val users = db.users().getAll().map { u ->
            val o = JSONObject().put("id", u.id).put("name", u.name).put("role", u.role)
                .put("active", u.active)
            if (u.role == "worker") {
                val set = workerScreens(u.id)
                WORKER_SCREENS.forEach { o.put("p_$it", it in set) }
            }
            o
        }
        val screens = JSONArray(WORKER_SCREENS.map { JSONObject().put("k", it).put("l", WORKER_SCREEN_LABELS[it] ?: it) })
        return render("settings.html", "settings", "/settings", JSONObject().put("users_list", JSONArray(users)).put("screens", screens))
    }

    /** اسم المستخدم الظاهر قابل للتعديل، وصلاحية owner/worker ثابتة. إضافة عامل تتطلب رمزاً صريحاً. */
    private fun usersRoute(method: String, user: UserEntity, data: JSONObject): JSONObject {
        if (user.role != "owner") return forbidden("/users")
        if (method != "POST") return redirect("/settings")
        val uidText = data.optString("uid").trim()
        val uid = uidText.toLongOrNull()
        val pin = data.optString("pin").trim()
        val name = data.optString("name").trim()
        fun invalid(message: String): JSONObject {
            flashes.add("error" to message)
            return redirect("/settings")
        }
        if (uidText.isNotEmpty() && uid == null) return invalid("معرّف المستخدم غير صالح")
        if (name.isNotEmpty() && (name.length > 60 || name.any { Character.isISOControl(it) })) {
            return invalid("اسم المستخدم يجب ألا يتجاوز 60 حرفاً ولا يحتوي أسطر تحكم")
        }
        val insecure = RafiqDatabase.SEED_USERS.map { it.third }.toSet() + "0000"
        if (pin.isNotEmpty() && requireSecuritySetup && pin in insecure) {
            return invalid("لا تستخدم الرموز التجريبية المعروفة؛ اختر رمزاً مختلفاً")
        }
        if (uid != null) {
            val target = db.users().getById(uid) ?: return invalid("المستخدم غير موجود")
            if (name.isEmpty() && pin.isEmpty()) return invalid("اكتب الاسم أو الرمز المراد تغييره")
            if (pin.isNotEmpty() && !PinHasher.isValidFormat(pin)) return invalid("الرمز يجب أن يكون 4 أرقام")
            if (name.isNotEmpty()) db.users().setName(uid, name)
            if (pin.isNotEmpty()) {
                db.users().setPin(uid, PinHasher.hash(pin))
                if (target.role == "worker" && target.active == 0) db.users().setWorkerActive(uid, 1)
            }
        } else {
            if (name.isEmpty()) return invalid("اكتب اسم العامل")
            if (!PinHasher.isValidFormat(pin)) return invalid("أدخل رمز العامل: 4 أرقام إلزامية")
            db.users().insert(net.arena.rafiq.data.UserEntity(name = name, role = "worker", pin = PinHasher.hash(pin)))
        }
        flashes.add("ok" to "تم الحفظ")
        return redirect("/settings")
    }

    /* ======================= الموردون والمناديب ======================= */

    private val SUPPLIER_KINDS = setOf("delegate", "fixed")

    private fun suppliersRoute(method: String, path: String, user: UserEntity, data: JSONObject): JSONObject {
        val detail = Regex("^/suppliers/(\\d+)$").find(path)
        val action = Regex("^/suppliers/(\\d+)/(edit|toggle|receive|pay|return|visit)$").find(path)
        return when {
            method == "POST" && path == "/suppliers/print-pick" ->
                redirect("/suppliers/${data.optString("sid").trim()}/print")
            method == "GET" && Regex("^/suppliers/(\\d+)/print$").find(path) != null ->
                supplierPrint(Regex("^/suppliers/(\\d+)/print$").find(path)!!.groupValues[1].toLong())
            method == "GET" && path == "/suppliers" -> suppliersPage(data.optString("q").trim(), user)
            method == "POST" && path == "/suppliers/add" ->
                if (user.role != "owner") forbidden(path) else addSupplier(data, user)
            method == "GET" && detail != null -> supplierDetail(detail.groupValues[1].toLong(), user)
            method == "POST" && action != null -> {
                val sid = action.groupValues[1].toLong()
                val act = action.groupValues[2]
                val ownerOnly = act == "edit" || act == "toggle" || act == "pay"
                when {
                    ownerOnly && user.role != "owner" -> forbidden(path)
                    db.supplierQueries().byId(sid) == null -> notFound(path)
                    else -> supplierAction(sid, act, data, user)
                }
            }
            else -> notFound(path)
        }
    }

    /** JSON لمورد مع أرصدته وأرصاد زياراته المحسوبة (كما SUPPLIER_BALANCE_SQL و sup_flags). */
    private fun supplierJson(s: net.arena.rafiq.data.SupplierEntity, today: String): JSONObject {
        val repo = SupplierRepository(db)
        val q = db.supplierQueries()
        val days = SupplierRules.daysSince(s.lastVisitAt, today)
        val flags = SupplierRules.delegateFlags(
            isDelegate = s.kind == "delegate", active = s.active == 1,
            periodicity = s.periodicity, daysSinceVisit = days,
        )
        return JSONObject()
            .put("id", s.id).put("name", s.name).put("phone", s.phone).put("kind", s.kind)
            .put("periodicity", s.periodicity).put("goods", s.goods)
            .put("returnable", s.returnable).put("note", s.note)
            .put("last_visit_at", s.lastVisitAt ?: JSONObject.NULL)
            .put("active", s.active)
            .put("balance_cents", repo.balance(s.id))
            .put("received_cents", q.sumKind(s.id, "receive"))
            .put("paid_cents", q.sumKind(s.id, "pay"))
            .put("returned_cents", q.sumKind(s.id, "return"))
            .put("days", days ?: JSONObject.NULL)
            .put("due_today", flags.dueToday)
            .put("overdue", flags.overdue)
    }

    private fun suppliersPage(q: String, user: UserEntity): JSONObject {
        val today = todayIso()
        val all = db.supplierQueries().allList()
        val repo = SupplierRepository(db)
        val matches = all.filter { it.active == 1 }.filter {
            q.isEmpty() || it.name.contains(q, true) || it.goods.contains(q, true) || it.phone.contains(q, true)
        }
        val rows = matches.map { supplierJson(it, today) }
            .sortedWith(compareByDescending<JSONObject> { it.getLong("balance_cents") }.thenBy { it.getString("name") })
            .take(300)
        val todayList = rows.filter { it.getBoolean("due_today") }
        val delegates = rows.count { it.getString("kind") == "delegate" }
        val ctx = JSONObject()
            .put("u", userJson(user))
            .put("rows", JSONArray(rows))
            .put("today_list", JSONArray(todayList))
            .put("q", q)
            .put("total", all.sumOf { repo.balance(it.id) })
            .put("received_all", db.supplierQueries().sumAllKind("receive"))
            .put("paid_all", db.supplierQueries().sumAllKind("pay"))
            .put("returned_all", db.supplierQueries().sumAllKind("return"))
            .put("delegates", delegates)
            .put("fixed", rows.size - delegates)
            .put("PL", periodLabels())
        return render("suppliers.html", "suppliers", "/suppliers", ctx)
    }

    private fun periodLabels(): JSONObject =
        JSONObject().also { o -> PERIOD_LABEL.forEach { (k, v) -> o.put(k, v) } }

    private fun addSupplier(data: JSONObject, user: UserEntity): JSONObject {
        val name = data.optString("name").trim()
        if (name.isEmpty()) {
            flashes.add("error" to "اكتب اسم المورد أو المندوب")
            return redirect("/suppliers")
        }
        val kind = data.optString("kind").takeIf { it in SUPPLIER_KINDS } ?: "delegate"
        val periodicity = data.optString("periodicity").takeIf { PERIOD_LABEL.containsKey(it) } ?: "weekly"
        db.suppliers().insert(
            net.arena.rafiq.data.SupplierEntity(
                name = name, phone = data.optString("phone").trim(), kind = kind,
                periodicity = periodicity, goods = data.optString("goods").trim(),
                returnable = if (data.optString("returnable") == "1") 1 else 0,
                note = data.optString("note").trim(),
            )
        )
        flashes.add("ok" to "تمت إضافة: $name")
        return redirect("/suppliers")
    }

    /** كشف حساب مورد قابل للطباعة: الحركات بالترتيب الزمني مع الرصيد الجاري بعد كل حركة. */
    private fun supplierPrint(sid: Long): JSONObject {
        val sup = db.supplierQueries().byId(sid) ?: return notFound("/suppliers/$sid/print")
        var run = 0L
        val labels = mapOf("receive" to "استلام بضاعة", "pay" to "سداد", "return" to "مرتجع")
        val ev = db.supplierQueries().transactionsOf(sid).map { t ->
            run += if (t.kind == "receive") t.amountCents else -t.amountCents
            JSONObject()
                .put("ts", t.createdAt)
                .put("label", labels[t.kind] ?: t.kind)
                .put("amount_fmt", Money.format(t.amountCents))
                .put("note", t.note)
                .put("balance_fmt", Money.format(run))
        }
        val ctx = JSONObject()
            .put("s", JSONObject().put("name", sup.name).put("phone", sup.phone).put("balance_fmt", Money.format(run)))
            .put("ev", JSONArray(ev))
            .put("today", java.text.SimpleDateFormat("yyyy-MM-dd HH:mm", java.util.Locale.US).format(java.util.Date()))
            .put("u", JSONObject.NULL)
        return render("supplier_print.html", "supplier_print", "/suppliers/$sid/print", ctx)
    }

    private fun supplierDetail(sid: Long, user: UserEntity): JSONObject {
        val sup = db.supplierQueries().byId(sid) ?: return notFound("/suppliers/$sid")
        val today = todayIso()
        val users = db.users().getAll().associateBy { it.id }
        val repo = SupplierRepository(db)
        // الرصيد الجاري بعد كل حركة، من الأقدم إلى الأحدث ثم يُعكس للعرض
        var run = 0L
        val events = db.supplierQueries().transactionsOf(sid).map { t ->
            run += if (t.kind == "receive") t.amountCents else -t.amountCents
            JSONObject()
                .put("ts", t.createdAt).put("seq", t.id).put("kind", t.kind)
                .put("amount", t.amountCents).put("note", t.note).put("ref", t.invoiceRef)
                .put("user", t.userId?.let { users[it]?.name } ?: JSONObject.NULL)
                .put("balance_after", run)
        }.reversed()
        val visits = db.supplierQueries().visitsOf(sid).map { v ->
            JSONObject()
                .put("id", v.id).put("created_at", v.createdAt)
                .put("uname", v.userId?.let { users[it]?.name } ?: JSONObject.NULL)
        }
        val s = supplierJson(sup, today)
        val ctx = JSONObject()
            .put("u", userJson(user))
            .put("s", s)
            .put("ev", JSONArray(events))
            .put("visits", JSONArray(visits))
            .put("PL", periodLabels())
        return render("supplier_detail.html", "supplier_detail", "/suppliers/$sid", ctx)
    }

    /** الحركات والتعديل والإيقاف: كل فعل يعيد التوجيه برسالة، كما في النسخة الأصلية. */
    private fun supplierAction(sid: Long, act: String, data: JSONObject, user: UserEntity): JSONObject {
        val repo = SupplierRepository(db)
        val detailPath = "/suppliers/$sid"
        val amount = Money.parse(data.optString("amount"), null)
        val note = data.optString("note")
        val sup = db.supplierQueries().byId(sid)!!
        return when (act) {
            "edit" -> {
                repo.updateDetails(
                    sid, name = data.optString("name"), phone = data.optString("phone"),
                    kind = data.optString("kind").takeIf { it in SUPPLIER_KINDS } ?: sup.kind,
                    periodicity = data.optString("periodicity").takeIf { PERIOD_LABEL.containsKey(it) } ?: sup.periodicity,
                    goods = data.optString("goods"), returnable = data.optString("returnable") == "1",
                    note = note,
                )
                flashes.add("ok" to "تم حفظ تعديل البيانات ✔")
                redirect(detailPath)
            }
            "toggle" -> {
                if (sup.active == 1) {
                    when (val r = repo.setActive(sid, false)) {
                        is RepoResult.Failed -> {
                            flashes.add("error" to "${r.message} سدّد أو سوِّ المبلغ أولاً.")
                            redirect(detailPath)
                        }
                        is RepoResult.Ok -> {
                            flashes.add("ok" to "أُوقف التعامل مع «${sup.name}» — كشفه القديم محفوظ ويمكن إعادة تفعيله متى شئت")
                            redirect("/suppliers")
                        }
                    }
                } else {
                    repo.setActive(sid, true)
                    flashes.add("ok" to "أُعيد تفعيل «${sup.name}» ✔")
                    redirect(detailPath)
                }
            }
            "visit" -> {
                val r = repo.visit(sid, user.id)
                if (r is RepoResult.Ok) {
                    flashes.add("ok" to "سُجّلت زيارة: ${sup.name} — ✔ مرّ اليوم")
                    if (data.optString("back") == "suppliers") redirect("/suppliers") else redirect(detailPath)
                } else {
                    flashes.add("error" to (r as RepoResult.Failed).message)
                    redirect(detailPath)
                }
            }
            else -> {
                val r: RepoResult<Unit> = when (act) {
                    "receive" -> repo.receive(sid, amount, note, user.id, data.optString("ref"))
                    "pay" -> repo.pay(sid, amount, note, user.id)
                    else -> repo.returnGoods(sid, amount, note, user.id)
                }
                when (r) {
                    is RepoResult.Ok -> flashes.add("ok" to when (act) {
                        "receive" -> "تم تسجيل الاستلام (أضيف إلى ما علينا له)"
                        "pay" -> "تم تسجيل السداد وخصمه من الدرج"
                        else -> "تم تسجيل المرتجع (خُصم من ما علينا له)"
                    })
                    is RepoResult.Failed -> flashes.add("error" to r.message)
                }
                redirect(detailPath)
            }
        }
    }

    /* ======================= التقارير (للمالك) ======================= */

    /** كما reports في النسخة الأصلية: يوم محدد (الافتراضي اليوم)، وملخص ومبيعات وديون وموردون. */
    private fun reportsPage(data: JSONObject, user: UserEntity): JSONObject {
        val d = data.optString("date").ifBlank { todayIso() }
        val catalog = db.catalog()
        val sales = SalesRepository(db)
        val suppliers = SupplierRepository(db)

        val all = catalog.invoicesOn(d)
        val open = all.filter { it.status == "open" }
        val collections = catalog.collectionsOn(d)
        val summary = JSONObject()
            .put("count", open.size)
            .put("total", open.sumOf { it.totalCents })
            .put("paid", catalog.netCashFromSalesOn(d) + collections)
            .put("due", open.sumOf { it.dueCents })
            .put("cancelled", all.count { it.status == "cancelled" })

        val users = db.users().getAll().associateBy { it.id }
        val byWorker = open.groupBy { it.userId }
            .map { (uid, list) ->
                JSONObject()
                    .put("name", users[uid]?.name ?: "")
                    .put("c", list.size)
                    .put("t", list.sumOf { it.totalCents })
                    .put("p", list.sumOf { it.paidCents })
            }
            .sortedByDescending { it.getLong("t") }

        val top = catalog.topItems(d).map { r ->
            JSONObject().put("name", r.name).put("q", r.q).put("t", r.t)
        }

        val invoices = all.sortedByDescending { it.id }.take(300).map { i ->
            JSONObject()
                .put("id", i.id)
                .put("number", i.number)
                .put("created_at", i.createdAt)
                .put("uname", users[i.userId]?.name ?: JSONObject.NULL)
                .put("cname", i.customerId?.let { db.customers().getById(it)?.name } ?: JSONObject.NULL)
                .put("total_cents", i.totalCents)
                .put("due_cents", i.dueCents)
                .put("payment_type", i.paymentType)
                .put("status", i.status)
        }

        val allSuppliers = db.supplierQueries().allList()
        val supDebtTotal = allSuppliers.sumOf { suppliers.balance(it.id) }
        val supDebts = allSuppliers
            .filter { it.active == 1 }
            .map { it to suppliers.balance(it.id) }
            .filter { it.second > 0 }
            .sortedByDescending { it.second }
            .take(20)
            .map { (s, bal) ->
                JSONObject()
                    .put("id", s.id).put("name", s.name).put("kind", s.kind)
                    .put("phone", s.phone).put("returnable", s.returnable)
                    .put("balance_cents", bal)
                    .put("last_visit_at", s.lastVisitAt ?: JSONObject.NULL)
            }

        val debtsTotal = catalog.allCustomerIds().sumOf { sales.customerBalance(it) }
        val debts = db.customers().getAll()
            .map { it to sales.customerBalance(it.id) }
            .filter { it.second > 0 }
            .sortedByDescending { it.second }
            .take(50)
            .map { (c, bal) ->
                JSONObject()
                    .put("id", c.id).put("name", c.name).put("phone", c.phone)
                    .put("balance_cents", bal)
                    .put("last_invoice_at", catalog.lastOpenInvoiceAt(c.id) ?: JSONObject.NULL)
            }

        val ctx = JSONObject()
            .put("u", userJson(user))
            .put("d", d)
            .put("summary", summary)
            .put("collections", collections)
            .put("expenses", catalog.expensesOn(d))
            .put("withdraws", catalog.withdrawsOn(d))
            .put("sup_pays_today", catalog.supplierPaidOn(d))
            .put("by_worker", JSONArray(byWorker))
            .put("top", JSONArray(top))
            .put("invoices", JSONArray(invoices))
            .put("debts", JSONArray(debts))
            .put("debts_total", debtsTotal)
            .put("sup_debts", JSONArray(supDebts))
            .put("sup_debt_total", supDebtTotal)
        ctx.put("accounts_customers", JSONArray(db.customers().getAll().sortedBy { it.name }.map {
            JSONObject().put("id", it.id).put("name", it.name)
        }))
        ctx.put("accounts_suppliers", JSONArray(db.supplierQueries().allList().sortedBy { it.name }.map {
            JSONObject().put("id", it.id).put("name", it.name)
        }))
        return render("reports.html", "reports", "/reports", ctx)
    }

    /* ======================= أين الصنف؟ ======================= */

    /** كما find_item في النسخة الأصلية: بحث بالاسم/الباركود، أو بالموقع إن كانت العبارة «ممر 3». */
    private fun findPage(q: String, user: UserEntity): JSONObject {
        var res: List<ProductEntity> = emptyList()
        var mode = ""
        if (q.isNotEmpty()) {
            res = db.catalog().searchProducts(q, 60)
            mode = "name"
            ShelfRules.parseLocationQuery(q)?.let { code ->
                val byLoc = db.catalog().productsAtLocation(code)
                if (byLoc.isNotEmpty()) {
                    res = byLoc
                    mode = "location"
                }
            }
        }
        val ctx = JSONObject()
            .put("u", userJson(user))
            .put("q", q)
            .put("mode", mode)
            .put("res", JSONArray(res.map { productForPage(it) }))
        return render("find.html", "find_item", "/find", ctx)
    }

    /** الصنف كما يراه القالب: أرقام خام للرصيد والحد، والموقع مفصّلاً. */
    private fun productForPage(p: ProductEntity): JSONObject {
        val root = StockSharing.stockProduct(db, p)
        return JSONObject()
            .put("id", p.id)
            .put("name", p.name)
            .put("barcode", p.barcode ?: "")
            .put("unit", p.unit)
            .put("aisle", p.aisle)
            .put("shelf", p.shelf)
            .put("price_cents", p.priceCents)
            .put("stock", root?.stock ?: 0.0)
            .put("low_stock", root?.lowStock ?: 0.0)
    }

    /* ======================= الصندوق ======================= */

    private fun cashContext(user: UserEntity): JSONObject {
        val shift = db.shifts().getOpen()
        val movements = shift?.let { db.cashMovements().getByShift(it.id).sortedByDescending { m -> m.id }.take(200) }
            ?: emptyList()
        val sums = HashMap<String, Long>()
        for (m in movements) sums[m.kind] = (sums[m.kind] ?: 0L) + m.amountCents
        fun t(k: String): Long = sums[k] ?: 0L
        val totals = JSONObject()
        if (shift != null) {
            for (k in listOf("sale", "collection", "income", "expense", "withdraw", "cancel", "supplier_pay")) {
                totals.put(k, t(k))
            }
            // مجاميع الوردية حسب طريقة الدفع: النقد للدرج، والباقي يظهر منفصلاً
            val byMethod = SalesRepository(db).methodTotals(shift.id)
            for (m in listOf("cash", "transfer", "wallet", "deposit", "debt")) {
                totals.put("m_$m", byMethod[m] ?: 0L)
            }
            totals.put("in_all", t("sale") + t("collection") + t("income"))
            totals.put("out_all", kotlin.math.abs(t("expense")) + kotlin.math.abs(t("withdraw")) + kotlin.math.abs(t("supplier_pay")))
        }
        val names = db.users().getAll().associate { it.id to it.name }
        val movementsJson = JSONArray(movements.map { m ->
            JSONObject()
                .put("id", m.id)
                .put("kind", m.kind)
                .put("amount_cents", m.amountCents)
                .put("reason", m.reason)
                .put("note", m.note)
                .put("created_at", m.createdAt)
                .put("uname", m.userId?.let { names[it] } ?: JSONObject.NULL)
        })
        val last = db.shifts().lastClosed()
        val lastJson: Any = last?.let {
            JSONObject()
                .put("closed_at", it.closedAt ?: "")
                .put("cname", it.closedBy?.let { id -> names[id] } ?: "")
                .put("difference_cents", it.differenceCents ?: 0L)
                .put("difference_reason", it.differenceReason)
                .put("opened_at", it.openedAt)
                .put("expected_cents", it.expectedCents ?: 0L)
                .put("counted_cents", it.countedCents ?: 0L)
        } ?: JSONObject.NULL
        return JSONObject()
            .put("u", userJson(user))
            .put("server_shift_pilot", enableServerShiftPilot)
            .put("shift", shiftJson(shift))
            .put("expected", if (shift != null) db.cashMovements().sumForShift(shift.id) else JSONObject.NULL)
            .put("movements", movementsJson)
            .put("totals", totals)
            .put("last", lastJson)
            .put("K", JSONObject().also { o -> KIND_LABEL.forEach { (k, v) -> o.put(k, v) } })
            .put("REASON_IN", JSONArray(CashRules.REASONS_IN))
            .put("REASON_OUT", JSONArray(CashRules.REASONS_OUT))
            .put("REASON_DIFF", JSONArray(CashRules.REASONS_DIFF))
            .put("DENOM", JSONArray(CashRules.DENOMINATIONS))
    }

    /** أفعال الصندوق: كل فعل يعيد توجيهاً إلى /cash مع رسالة، كما في النسخة الأصلية. */
    private fun cashAction(path: String, user: UserEntity, data: JSONObject): JSONObject {
        val cash = CashRepository(db)
        when (path) {
            "/cash/open" -> {
                // لا تُحوِّل الإدخال الخاطئ إلى صفر؛ هذا المسار المحلي باقٍ مستقلاً عن قرار الخادم.
                val raw = data.optString("amount").trim()
                val digit = "0-9٠-٩"
                val valid = Regex("^(?:[$digit]+|[$digit]{1,3}(?:[,٬][$digit]{3})+)(?:[.٫][$digit]{1,2})?$").matches(raw)
                val amount = if (valid) Money.parse(raw, null) else null
                if (amount == null || amount < 0L || amount > 99999999900L) {
                    flashes.add("error" to "اكتب مبلغ افتتاح صحيحاً؛ لا يُستبدل الإدخال غير الصالح بصفر")
                } else when (val r = cash.open(amount, user.id)) {
                    is RepoResult.Ok -> flashes.add("ok" to "تم فتح الوردية المحلية")
                    is RepoResult.Failed -> flashes.add("error" to r.message)
                }
            }
            "/cash/close" -> {
                val counted = Money.parse(data.optString("counted"), null)
                when (val r = cash.close(counted, data.optString("difference_reason"), user.id)) {
                    is RepoResult.Ok -> {
                        val diff = r.value
                        if (diff == 0L) {
                            flashes.add("ok" to "تم إغلاق الوردية — الصندوق مطابق تماماً ✔")
                        } else {
                            val kind = if (diff > 0) "زيادة" else "عجز"
                            flashes.add("error" to "تم إغلاق الوردية — الفرق $kind: ${Money.format(kotlin.math.abs(diff))}")
                        }
                    }
                    is RepoResult.Failed -> flashes.add("error" to r.message)
                }
            }
            "/cash/income", "/cash/expense", "/cash/withdraw" -> {
                val kind = path.substringAfterLast('/')
                val amount = Money.parse(data.optString("amount"), null)
                val reason = data.optString("reason").trim()
                val note = data.optString("note").trim()
                when (val r = cash.manualMovement(kind, amount, reason, note, user.id)) {
                    is RepoResult.Ok -> flashes.add("ok" to when (kind) {
                        "income" -> "تم تسجيل الدخل في الدرج"
                        "expense" -> "تم تسجيل المصروف من الدرج"
                        else -> "تم تسجيل السحب"
                    })
                    is RepoResult.Failed -> flashes.add("error" to r.message)
                }
            }
            else -> return notFound(path)
        }
        return redirect("/cash")
    }

    /* ======================= الزبائن والديون ======================= */

    private fun customersRoute(method: String, path: String, user: UserEntity, data: JSONObject): JSONObject {
        val detail = Regex("^/customers/(\\d+)$").find(path)
        val action = Regex("^/customers/(\\d+)/(debit|pay)$").find(path)
        val printMatch = Regex("^/customers/(\\d+)/print$").find(path)
        return when {
            method == "POST" && path == "/customers/print-pick" ->
                redirect("/customers/${data.optString("cid").trim()}/print")
            method == "GET" && printMatch != null -> customerPrint(printMatch.groupValues[1].toLong())
            method == "GET" && path == "/customers" -> customersPage(
                data.optString("q").trim(), user, data.optString("followup") == "1",
            )
            method == "POST" && path == "/customers/add" -> addCustomer(data)
            method == "GET" && detail != null -> customerDetail(detail.groupValues[1].toLong(), user)
            method == "POST" && action != null -> {
                val cid = action.groupValues[1].toLong()
                val sales = SalesRepository(db)
                val amount = Money.parse(data.optString("amount"), null)
                val note = data.optString("note").trim()
                val r = if (action.groupValues[2] == "debit") {
                    sales.recordDebit(cid, amount, note, user.id)
                } else {
                    sales.recordPayment(cid, amount, note, user.id)
                }
                when (r) {
                    is RepoResult.Ok -> flashes.add("ok" to if (action.groupValues[2] == "debit")
                        "تم تسجيل الدين على الزبون (أعطيت)" else "تم تسجيل الدفعة")
                    is RepoResult.Failed -> flashes.add("error" to r.message)
                }
                redirect("/customers/$cid")
            }
            else -> notFound(path)
        }
    }

    private fun customersPage(q: String, user: UserEntity, followup: Boolean): JSONObject {
        val sales = SalesRepository(db)
        val needle = q
        val today = todayIso()
        val days = debtFollowupDays()
        val exactCode = CustomerCode.parseExplicit(needle)
        val rows = db.customers().getAll()
            .filter { it.active == 1 && (needle.isEmpty() || it.name.contains(needle) || it.phone.contains(needle) || it.id == exactCode) }
            .map { c ->
                Triple(c, sales.customerBalance(c.id), db.catalog().lastActivity(c.id))
            }
            .filter { (c, bal, _) -> !followup || DebtFollowUp.alert(db, c, bal, today, days) != null }
            .sortedWith(compareByDescending<Triple<net.arena.rafiq.data.CustomerEntity, Long, String>> { it.second }
                .thenBy { it.first.name })
            .take(300)
        val ctx = JSONObject()
            .put("u", userJson(user))
            .put("q", q)
            .put("followup", followup)
            .put("debt_followup_days", days)
            .put("rows", JSONArray(rows.map { (c, bal, last) ->
                JSONObject().put("id", c.id).put("code", CustomerCode.display(c.id))
                    .put("name", c.name).put("phone", c.phone)
                    .put("balance_cents", bal).put("last_activity", last)
            }))
            .put("given", db.catalog().openingTotal() + db.catalog().openDueTotal() + db.catalog().ledgerTotal())
            .put("taken", db.catalog().paymentsTotal())
            .put("remaining", db.customers().getAll().sumOf { sales.customerBalance(it.id) })
        return render("customers.html", "customers", "/customers", ctx)
    }

    private fun addCustomer(data: JSONObject): JSONObject {
        val name = data.optString("name").trim()
        val phone = data.optString("phone").trim()
        val opening = Money.parse(data.optString("opening"), 0L) ?: 0L
        val back = data.optString("back").ifBlank { "/customers" }
        if (name.isEmpty()) {
            flashes.add("error" to "اكتب اسم الزبون")
            return redirect(back)
        }
        db.customers().insert(net.arena.rafiq.data.CustomerEntity(name = name, phone = phone, openingCents = opening))
        flashes.add("ok" to "تمت إضافة الزبون: $name")
        return redirect(back)
    }

    /** كشف حساب قابل للطباعة: كل الحركات مع الرصيد بعد كل حركة، وإجمالي الدين حتى الآن. */
    private fun customerPrint(cid: Long): JSONObject {
        val c = db.customers().getById(cid) ?: return notFound("/customers/$cid/print")
        val snapshot = SalesRepository(db).accountSnapshot(cid) ?: return notFound("/customers/$cid/print")
        val ev = JSONArray(snapshot.events.map { e ->
            JSONObject()
                .put("ts", e.ts)
                .put("kind", when (e.kind) {
                    net.arena.rafiq.domain.CustomerStatement.Kind.GIVEN -> "given"
                    net.arena.rafiq.domain.CustomerStatement.Kind.TAKEN -> "taken"
                    net.arena.rafiq.domain.CustomerStatement.Kind.OPENING_CREDIT -> "credit_opening"
                })
                .put("amount_fmt", Money.format(e.amountCents))
                .put("note", e.note)
                .put("user", e.userName ?: "")
                .put("balance_fmt", Money.format(e.balanceAfterCents))
        })
        val ctx = JSONObject()
            .put("c", JSONObject().put("name", c.name).put("code", CustomerCode.display(cid))
                .put("phone", c.phone ?: "")
                .put("balance_cents", snapshot.balanceCents)
                .put("balance_fmt", Money.format(snapshot.balanceCents)))
            .put("audit_ok", snapshot.reconciles)
            .put("ev", ev)
            .put("today", java.text.SimpleDateFormat("yyyy-MM-dd HH:mm", java.util.Locale.US).format(java.util.Date()))
            .put("u", JSONObject.NULL)
        return render("statement_print.html", "statement_print", "/customers/$cid/print", ctx)
    }

    private fun customerDetail(cid: Long, user: UserEntity): JSONObject {
        val c = db.customers().getById(cid) ?: return notFound("/customers/$cid")
        val snapshot = SalesRepository(db).accountSnapshot(cid) ?: return notFound("/customers/$cid")
        val evJson = JSONArray(snapshot.events.map { e ->
            JSONObject()
                .put("ts", e.ts)
                .put("kind", when (e.kind) {
                    net.arena.rafiq.domain.CustomerStatement.Kind.GIVEN -> "given"
                    net.arena.rafiq.domain.CustomerStatement.Kind.TAKEN -> "taken"
                    net.arena.rafiq.domain.CustomerStatement.Kind.OPENING_CREDIT -> "credit_opening"
                })
                .put("amount", e.amountCents)
                .put("note", e.note)
                .put("balance_after", e.balanceAfterCents)
                .put("invoice_id", e.invoiceId ?: JSONObject.NULL)
                .put("user", e.userName ?: JSONObject.NULL)
        })
        val invoices = db.catalog().invoicesOfCustomer(cid).map { i ->
            JSONObject().put("id", i.id).put("number", i.number).put("created_at", i.createdAt)
                .put("total_cents", i.totalCents).put("paid_cents", i.paidCents)
                .put("due_cents", i.dueCents).put("status", i.status)
        }
        // القالب يستعمل ev الكاملة؛ كان يُقرأ pays (آخر 200) مرة ثانية دون أن يُعرض.
        val ctx = JSONObject()
            .put("u", userJson(user))
            .put("c", JSONObject().put("id", c.id).put("code", CustomerCode.display(cid))
                .put("name", c.name).put("phone", c.phone)
                .put("note", c.note).put("opening_cents", c.openingCents)
                .put("balance_cents", snapshot.balanceCents))
            .put("audit_ok", snapshot.reconciles)
            .put("ev", evJson)
            .put("invoices", JSONArray(invoices))
        return render("customer_detail.html", "customer_detail", "/customers/$cid", ctx)
    }

    private fun authenticate(data: JSONObject): JSONObject {
        val id = data.optString("uid").toLongOrNull()
        val pin = data.optString("pin").trim()
        val user = id?.let { db.users().getById(it) }
        if (user == null || user.active != 1 || (securitySetupPending() && user.role != "owner")) return failedLogin()
        val now = System.currentTimeMillis()
        val (fails, lockedUntil) = guardRead(user.id)
        if (now < lockedUntil) {
            val minutes = (lockedUntil - now) / 60_000L + 1
            flashes.add("error" to "محاولات كثيرة. انتظر $minutes دقيقة ثم حاول مجدداً")
            return redirect("/login")
        }
        if (PinHasher.verify(user.pin, pin)) {
            guardClear(user.id)
            // ترقية الرمز القديم (نص عادي) إلى تجزئة عند أول دخول ناجح
            if (!PinHasher.isHashed(user.pin)) db.users().setPin(user.id, PinHasher.hash(pin))
            synchronized(this) {
                uid = user.id
                onCloudHostReady?.invoke(null) // لا يرث مستخدم جديد مضيف الجلسة السابقة.
            }
            return redirect(when {
                !licenseCheck(System.currentTimeMillis()).ok -> if (user.role == "owner") "/rescue" else "/license"
                securitySetupPending() -> "/setup"
                cloudSetupPending() && user.role == "owner" -> "/cloud/setup"
                cloudSetupPending() -> "/login"
                else -> "/"
            })
        }
        val next = fails + 1
        if (next >= MAX_LOGIN_FAILS) guardWrite(user.id, 0, now + LOCK_MS) else guardWrite(user.id, next, 0L)
        return failedLogin()
    }

    private fun failedLogin(): JSONObject {
        flashes.add("error" to "الرمز غير صحيح، حاول مرة أخرى")
        return redirect("/login")
    }

    /* عدّاد محاولات الدخول الفاشلة: يُحفظ في قاعدة البيانات فلا يُصفَّر بإعادة تشغيل التطبيق */
    private fun guardRead(userId: Long): Pair<Int, Long> {
        db.openHelper.readableDatabase.query(
            "SELECT fails, locked_until FROM login_guard WHERE uid = ?",
            arrayOf<Any>(userId),
        ).use { c ->
            return if (c.moveToFirst()) c.getInt(0) to c.getLong(1) else 0 to 0L
        }
    }

    private fun guardWrite(userId: Long, fails: Int, lockedUntil: Long) {
        db.openHelper.writableDatabase.execSQL(
            "INSERT OR REPLACE INTO login_guard (uid, fails, locked_until) VALUES (?, ?, ?)",
            arrayOf<Any>(userId, fails, lockedUntil),
        )
    }

    private fun guardClear(userId: Long) {
        db.openHelper.writableDatabase.execSQL("DELETE FROM login_guard WHERE uid = ?", arrayOf<Any>(userId))
    }

    /* ======================= الرخصة ======================= */

    /** يتحقق من الرخصة المحفوظة، ويكشف إرجاع ساعة الجهاز إلى الوراء (لمنع تمديد الرخصة بتغيير الوقت). */
    private fun licenseCheck(now: Long): LicenseResult {
        if (licensePublicKey.isBlank()) return LicenseResult(true, "بوابة الرخصة غير مفعّلة في هذا البناء")
        val token = db.settings().get(LICENSE_TOKEN_KEY)?.value
            ?: return LicenseResult(false, "لا توجد رخصة مُفعّلة على هذا الجهاز")
        val lastSeen = db.settings().get(LICENSE_LAST_SEEN_KEY)?.value?.toLongOrNull() ?: 0L
        if (now + LICENSE_CLOCK_TOLERANCE_MS < lastSeen) {
            return LicenseResult(false, "ساعة الجهاز رجعت إلى الوراء. صحّح التاريخ والوقت ثم أعد المحاولة")
        }
        val result = LicenseVerifier.verify(token, licensePublicKey, deviceId, now)
        if (result.ok && now > lastSeen) {
            db.settings().upsert(net.arena.rafiq.data.SettingEntity(LICENSE_LAST_SEEN_KEY, now.toString()))
        }
        return result
    }

    private fun licenseRoute(method: String, data: JSONObject): JSONObject {
        val now = System.currentTimeMillis()
        if (method == "POST") {
            val token = data.optString("token").trim()
            val check = if (licensePublicKey.isBlank()) LicenseResult(true, "") else LicenseVerifier.verify(token, licensePublicKey, deviceId, now)
            if (!check.ok) {
                flashes.add("error" to check.reason)
                return redirect("/license")
            }
            db.settings().upsert(net.arena.rafiq.data.SettingEntity(LICENSE_TOKEN_KEY, token))
            db.settings().upsert(net.arena.rafiq.data.SettingEntity(LICENSE_LAST_SEEN_KEY, now.toString()))
            flashes.add("ok" to "تم تفعيل الرخصة")
            return redirect("/")
        }
        val st = licenseCheck(now)
        val fmt = java.text.SimpleDateFormat("yyyy-MM-dd", java.util.Locale.US)
        val ctx = JSONObject()
            .put("ok", st.ok)
            .put("reason", st.reason)
            .put("device", deviceId)
            .put("name", st.info?.name ?: "")
            .put("expires", st.info?.let { fmt.format(java.util.Date(it.expiresAt)) } ?: "")
            .put("u", currentUser()?.let { userJson(it) } ?: JSONObject.NULL)
        return render("license.html", "license", "/license", ctx)
    }

    private fun securitySetupPending(): Boolean = requireSecuritySetup &&
        db.settings().get(SECURITY_READY_KEY)?.value != "1"

    private fun cloudSetupPending(): Boolean = requireCloudOnboarding && cloudStorage != null &&
        db.settings().get(CLOUD_SETUP_SEEN_KEY)?.value != "1"

    /**
     * 6أ/توحيد: تهيئة الإقلاع للواجهة الموحدة — بلا بوابة مستخدم محلي أو ترخيص محلي؛
     * الوجود الوحيد المطلوب: ربط سحابي محفوظ على هذا الهاتف. القرار النهائي للخدمة السحابية نفسها.
     */
    fun pilotConfigurationForLaunch(): CloudConfiguration? {
        ensureBootstrap()
        val binding = db.settings().get(CLOUD_BINDING_KEY)?.value ?: return null
        return cloudStorage?.read(binding)
    }

    /** استدعاء من جسر هاتف محلي فقط؛ Auth/RLS يقرران صلاحية العميل السحابي نفسه. */
    fun pilotConfiguration(): CloudConfiguration? {
        ensureBootstrap()
        if (currentUser() == null || !licenseCheck(System.currentTimeMillis()).ok ||
            securitySetupPending() || cloudSetupPending()) return null
        val binding = db.settings().get(CLOUD_BINDING_KEY)?.value ?: return null
        return cloudStorage?.read(binding)
    }

    /** مفتاح Publishable/Anon عام فقط؛ تسلسل القراءة والتصريح بالمضيف مع تغيير الإعداد. */
    @JavascriptInterface
    @Synchronized
    fun cloudShiftPublicConfig(): String = try {
        if (!enableServerShiftPilot) {
            onCloudHostReady?.invoke(null)
            JSONObject().put("error", "الوردية الخادمية غير مفعّلة في هذا البناء").toString()
        } else {
            val config = pilotConfiguration()
            if (config == null) {
                onCloudHostReady?.invoke(null)
                JSONObject().put("error", "أدخل إعداد مشروع المتجر على هذا الهاتف أولاً").toString()
            } else {
                onCloudHostReady?.invoke(config.projectUrl)
                JSONObject().put("url", config.projectUrl).put("key", config.publishableKey).toString()
            }
        }
    } catch (_: Exception) {
        // Corrupt/unreadable configuration must not leave a previous host allowed.
        try { onCloudHostReady?.invoke(null) } catch (_: Exception) { /* fail closed */ }
        JSONObject().put("error", "تعذر فتح إعداد المشروع المحفوظ؛ لا تعتبر الوردية المحلية بديلاً").toString()
    }

    /** معرّف ربط محلي لتشفير ملف التهيئة؛ ليس عضوية متجر موثقة في Supabase. */
    @Synchronized private fun cloudStoreBinding(): String {
        db.settings().get(CLOUD_BINDING_KEY)?.value?.let { return it }
        val id = java.util.UUID.randomUUID().toString()
        db.settings().upsert(net.arena.rafiq.data.SettingEntity(CLOUD_BINDING_KEY, id))
        return id
    }

    /** حفظ إعداد جديد وتصفير مضيف الوردية تحت قفل قراءة cloudShiftPublicConfig نفسه. */
    @Synchronized
    private fun cloudSetupRoute(method: String, path: String, user: UserEntity, data: JSONObject): JSONObject {
        if (user.role != "owner" || currentUser()?.id != user.id) return forbidden(path)
        val storage = cloudStorage ?: return render("error.html", "error", path, JSONObject()
            .put("title", "التهيئة السحابية غير متاحة")
            .put("msg", "لم يُجهَّز التخزين الآمن على هذا الجهاز؛ لم يُحفظ شيء")
            .put("u", userJson(user))).put("status", 503)
        val binding = cloudStoreBinding()
        if (path == "/cloud/setup/skip") {
            if (method != "POST" || !cloudSetupPending()) return notFound(path)
            db.settings().upsert(net.arena.rafiq.data.SettingEntity(CLOUD_SETUP_SEEN_KEY, "1"))
            flashes.add("error" to "جرى التخطي: يعمل التطبيق محلياً فقط، والمزامنة السحابية غير مفعّلة")
            return redirect("/")
        }
        if (method == "POST") {
            try {
                val url = CloudConfigRules.projectUrl(data.optString("project_url"))
                val key = CloudConfigRules.publishableKey(data.optString("publishable_key"))
                val previous = try { storage.read(binding) } catch (_: Exception) { null }
                if (previous != null && previous.projectUrl != url && data.optString("confirm_replace") != "1") {
                    flashes.add("error" to "تغيير مشروع المتجر يحتاج تأكيداً صريحاً؛ لن تُنقل الديون بين المشروعين")
                    return redirect("/cloud/setup")
                }
                // أغلق المضيف السابق قبل الكتابة، حتى إذا فشل الحفظ جزئياً؛ لا يعاد السماح
                // به إلا بقراءة الإعداد المحفوظ مجدداً عبر cloudShiftPublicConfig.
                onCloudHostReady?.invoke(null)
                storage.save(binding, url, key)
                db.settings().upsert(net.arena.rafiq.data.SettingEntity(CLOUD_SETUP_SEEN_KEY, "1"))
                flashes.add("ok" to "حُفظت البيانات مشفرة على هذا الهاتف؛ لم يُفعّل الاتصال أو المزامنة بعد")
                return redirect("/")
            } catch (_: IllegalArgumentException) {
                flashes.add("error" to "استخدم رابط مشروع HTTPS ومفتاح Publishable/Anon العام فقط؛ لا تُدخل مفتاح الخدمة")
                return redirect("/cloud/setup")
            } catch (_: Exception) {
                flashes.add("error" to "تعذر الحفظ الآمن؛ لم تُفعّل المزامنة. تحقق من حماية الجهاز وأعد المحاولة")
                return redirect("/cloud/setup")
            }
        }
        if (method != "GET") return notFound(path)
        val saved = try { storage.read(binding) } catch (_: Exception) {
            flashes.add("error" to "تعذر فتح الإعداد المحفوظ؛ أعد إدخال بيانات مشروعك قبل استعمال السحابة")
            null
        }
        return render("cloud_setup.html", "cloud_setup", path, JSONObject()
            .put("u", userJson(user))
            .put("configured", saved != null)
            .put("project_url", saved?.projectUrl ?: "")
            .put("first_run", cloudSetupPending())
            .put("cloud_verified", false))
    }

    /** في Release فقط: لا يستطيع عامل بدء البيع بالرموز المعروفة من النسخ التجريبية. */
    private fun securitySetupRoute(method: String, user: UserEntity, data: JSONObject): JSONObject {
        if (user.role != "owner") return forbidden("/setup")
        if (!securitySetupPending()) return redirect("/")
        if (method == "POST") {
            val pin = data.optString("new_pin").trim()
            val confirm = data.optString("confirm_pin").trim()
            val insecure = RafiqDatabase.SEED_USERS.map { it.third }.toSet() + "0000"
            if (!PinHasher.isValidFormat(pin) || pin != confirm || pin in insecure || PinHasher.verify(user.pin, pin)) {
                flashes.add("error" to "اختر رمزاً جديداً من 4 أرقام مختلفاً عن الرموز التجريبية، وأكّده كما هو")
                return redirect("/setup")
            }
            db.beginTransaction()
            try {
                db.users().setPin(user.id, PinHasher.hash(pin))
                for (worker in db.users().getAll().filter { it.role == "worker" && it.active == 1 }) {
                    if (insecure.any { PinHasher.verify(worker.pin, it) }) {
                        db.users().setWorkerActive(worker.id, 0)
                    }
                }
                db.settings().upsert(net.arena.rafiq.data.SettingEntity(SECURITY_READY_KEY, "1"))
                db.setTransactionSuccessful()
            } finally {
                db.endTransaction()
            }
            flashes.add("ok" to "تم تأمين الحسابات. أضف عمالاً برموز جديدة من الإعدادات عند الحاجة")
            return redirect("/")
        }
        return render("setup.html", "setup", "/setup", JSONObject().put("u", userJson(user)))
    }

    private fun loginContext(): JSONObject {
        val users = db.users().getAll()
            .filter { it.active == 1 && (!securitySetupPending() || it.role == "owner") }
            .sortedWith(compareByDescending<UserEntity> { it.role }.thenBy { it.id })
        return JSONObject()
            .put("users", JSONArray(users.map { u ->
                JSONObject().put("id", u.id).put("name", u.name).put("role", u.role)
            }))
    }

    private fun posContext(user: UserEntity): JSONObject {
        val customers = db.customers().getAll()
            .filter { it.active == 1 }
            .sortedBy { it.name }
            .map { JSONObject().put("id", it.id).put("name", it.name) }
        return JSONObject()
            .put("shift", shiftJson(db.shifts().getOpen()))
            .put("customers", JSONArray(customers))
            .put("u", userJson(user))
    }

    private fun shiftJson(s: ShiftEntity?): Any = s?.let {
        JSONObject().put("id", it.id).put("opened_at", it.openedAt).put("opening_cents", it.openingCents)
    } ?: JSONObject.NULL

    private fun userJson(u: UserEntity): JSONObject =
        JSONObject().put("id", u.id).put("name", u.name).put("role", u.role)

    private fun settingsJson(): JSONObject {
        val merged = LinkedHashMap(RafiqDatabase.DEFAULT_SETTINGS)
        // مفاتيح الرخصة داخلية ولا تُرسل إلى الواجهة
        db.settings().getAll().filter {
            !it.key.startsWith("license_") && !it.key.startsWith(StockSharing.KEY_PREFIX) &&
                !it.key.startsWith("knaash_review_") &&
                it.key != SECURITY_READY_KEY && it.key != CLOUD_BINDING_KEY &&
                it.key != CLOUD_SETUP_SEEN_KEY && it.key != "wa_token"
        }.forEach { merged[it.key] = it.value }
        val o = JSONObject()
        merged.forEach { (k, v) -> o.put(k, v) }
        // التوكن لا يُرسل إلى الواجهة أبداً: تُعرض حالته فقط
        o.put("wa_token_set", waSetting("wa_token").isNotEmpty())
        o.put("wa_last", waLastStatus())
        return o
    }

    /** يعرض قالباً بسياق كامل (الإعدادات والمستخدم والرسائل). */
    private fun render(template: String, endpoint: String, path: String, ctx: JSONObject): JSONObject {
        ctx.put("S", settingsJson())
        if (!ctx.has("u")) ctx.put("u", JSONObject.NULL)
        val pending = JSONArray(flashes.map { JSONArray(listOf(it.first, it.second)) })
        flashes.clear()
        return JSONObject()
            .put("status", 200)
            .put("template", template)
            .put("endpoint", endpoint)
            .put("path", path)
            .put("ctx", ctx)
            .put("flashes", pending)
    }

    /* ============================ تقرير الصندوق ============================ */

    /** تقرير يومي للمالك: لكل وردية بدأت في اليوم، حركاتها ومجاميعها والمعدود والفارق، مع دخل اليوم وخروجه. */
    private fun cashReport(path: String, user: UserEntity, data: JSONObject): JSONObject {
        val day = data.optString("date").trim().ifBlank { todayIso() }
        val users = db.users().getAll().associate { it.id to it.name }
        val catalog = db.catalog()
        val kinds = listOf("open", "sale", "collection", "income", "expense", "withdraw", "cancel", "supplier_pay")
        val blocks = catalog.shiftsOn(day).map { sh ->
            val movs = db.cashMovements().getByShift(sh.id)
            val closed = sh.status == "closed"
            val tot = JSONObject()
            for (k in kinds) tot.put(k, movs.filter { it.kind == k }.sumOf { it.amountCents })
            val expected = movs.sumOf { it.amountCents }
            val movsJson = JSONArray(movs.map { m ->
                JSONObject()
                    .put("kind", m.kind).put("amount_cents", m.amountCents)
                    .put("reason", m.reason).put("note", m.note)
                    .put("created_at", m.createdAt)
                    .put("uname", m.userId?.let { users[it] } ?: JSONObject.NULL)
            })
            val shiftJson = JSONObject()
                .put("id", sh.id)
                .put("opened_at", sh.openedAt)
                .put("closed_at", sh.closedAt ?: JSONObject.NULL)
                .put("opener", sh.openedBy?.let { users[it] } ?: JSONObject.NULL)
                .put("closer", sh.closedBy?.let { users[it] } ?: JSONObject.NULL)
                .put("status", sh.status)
            JSONObject()
                .put("shift", shiftJson)
                .put("movs", movsJson)
                .put("tot", tot)
                .put("expected", expected)
                .put("in_all", tot.getLong("sale") + tot.getLong("collection") + tot.getLong("income"))
                .put("out_all", kotlin.math.abs(tot.getLong("expense")) + kotlin.math.abs(tot.getLong("withdraw")) +
                    kotlin.math.abs(tot.getLong("supplier_pay")))
                .put("counted", if (closed) sh.countedCents ?: JSONObject.NULL else JSONObject.NULL)
                .put("diff", if (closed) sh.differenceCents ?: JSONObject.NULL else JSONObject.NULL)
                .put("diff_reason", if (closed) sh.differenceReason else "")
        }
        val dayMovs = catalog.movementsOn(day)
        val dayIn = dayMovs.filter { it.amountCents > 0 && it.kind != "open" }.sumOf { it.amountCents }
        val dayOut = dayMovs.filter { it.amountCents < 0 }.sumOf { -it.amountCents }
        val blocksJson = JSONArray(blocks)
        val ctx = JSONObject()
            .put("d", day)
            .put("blocks", blocksJson)
            .put("K", JSONObject().also { o -> KIND_LABEL.forEach { (k, v) -> o.put(k, v) } })
            .put("day_in", dayIn)
            .put("day_out", dayOut)
            .put("last", if (blocks.isEmpty()) JSONObject.NULL else blocks.last())
        return render("cash_report.html", "cash_report", "/cash/report", ctx)
    }

    /* ============================ الفاتورة ============================ */

    private fun invoiceRoute(method: String, path: String, user: UserEntity, data: JSONObject): JSONObject {
        if (path == "/invoice/by-number") {
            val inv = data.optString("n").trim().toLongOrNull()?.let { db.invoices().byNumber(it) }
            if (inv == null) {
                flashes.add("error" to "لا توجد فاتورة بهذا الرقم")
                return redirect("/reports")
            }
            return redirect("/invoice/${inv.id}")
        }
        val rest = path.removePrefix("/invoice/")
        val id = rest.substringBefore('/').toLongOrNull() ?: return notFound(path)
        return when {
            method == "GET" && rest == id.toString() -> invoicePage(id, path, user, data)
            method == "POST" && rest == "$id/cancel" ->
                if (user.role != "owner") forbidden(path) else invoiceCancel(id, user)
            else -> notFound(path)
        }
    }

    private fun invoicePage(id: Long, path: String, user: UserEntity, data: JSONObject): JSONObject {
        val inv = db.invoices().getById(id) ?: return notFound(path)
        val items = db.invoiceItems().getByInvoice(id)
        val customer = inv.customerId?.let { db.customers().getById(it) }
        val worker = db.users().getById(inv.userId)
        val invJson = JSONObject()
            .put("id", inv.id)
            .put("number", inv.number)
            .put("created_at", inv.createdAt)
            .put("payment_type", inv.paymentType)
            .put("status", inv.status)
            .put("subtotal_cents", inv.subtotalCents)
            .put("discount_cents", inv.discountCents)
            .put("total_cents", inv.totalCents)
            .put("paid_cents", inv.paidCents)
            .put("due_cents", inv.dueCents)
            .put("received_cents", inv.receivedCents ?: JSONObject.NULL)
            .put("change_cents", inv.changeCents ?: JSONObject.NULL)
        val itemsJson = JSONArray(items.map { it ->
            JSONObject()
                .put("name", it.name).put("barcode", it.barcode).put("unit", it.unit)
                .put("price_cents", it.priceCents).put("qty", it.qty).put("total_cents", it.totalCents)
        })
        val customerJson: Any = customer?.let {
            JSONObject().put("id", it.id).put("name", it.name).put("phone", it.phone)
                .put("balance_cents", SalesRepository(db).customerBalance(it.id))
        } ?: JSONObject.NULL
        val paymentsJson = JSONArray(SalesRepository(db).paymentsOf(id).map { (m, amount, ref) ->
            JSONObject()
                .put("label", net.arena.rafiq.domain.PaymentRules.LABELS[m] ?: m)
                .put("amount", Money.format(amount))
                .put("ref", ref)
        })
        val workerJson: Any = worker?.let { JSONObject().put("name", it.name) } ?: JSONObject.NULL
        val ctx = JSONObject()
            .put("inv", invJson)
            .put("items", itemsJson)
            .put("customer", customerJson)
            .put("worker", workerJson)
            .put("payments", paymentsJson)
            .put("u", userJson(user))
            .put("a4", data.optString("a4") == "1")
            .put("autoprint", data.optString("print") == "1")
        return render("invoice.html", "invoice", "/invoice/$id", ctx)
    }

    /** إلغاء فاتورة مفتوحة للمالك: يُرجع المخزون ويعكس المدفوع في الدرج، ثم يعود إلى التقارير. */
    private fun invoiceCancel(id: Long, user: UserEntity): JSONObject {
        val number = db.invoices().getById(id)?.number
        return when (val r = SalesRepository(db).cancelInvoice(id, user.id)) {
            is RepoResult.Failed -> {
                flashes.add("error" to r.message)
                redirect("/reports")
            }
            is RepoResult.Ok -> {
                flashes.add("ok" to "تم إلغاء الفاتورة رقم $number وإرجاع المخزون")
                redirect("/reports")
            }
        }
    }

    /* ============================ الاستيراد ============================ */

    /** معاينة بانتظار التأكيد، تُحفظ في الذاكرة بمفتاح رمزي حتى التأكيد أو إعادة التشغيل. */
    private class PendingImport(
        val kind: String,
        val filename: String,
        val products: List<ImportRules.ProductRecord>,
    )

    private val pendingImports = HashMap<String, PendingImport>()

    private fun importsRoute(method: String, path: String, user: UserEntity, data: JSONObject): JSONObject {
        // #50: مسار CSV القديم يضيف أرصدة العملاء بالاسم مرة ثانية عند إعادة رفع الملف.
        // نوقف القراءة والكتابة للديون حتى تتوفر مراجعة هوية/مجاميع وبصمة مصدر ذَرّية.
        if (method == "POST" && path in setOf("/imports/upload", "/imports/commit") &&
            data.optString("kind") == "debts") {
            flashes.add("error" to "استيراد الديون القديم مُعطل لحماية الأرصدة؛ PDF كناش يحتاج مراجعة وربط الزبائن قبل أي ترحيل")
            return redirect("/imports")
        }
        return when {
            method == "GET" && path == "/imports" -> importsPage(user)
            method == "POST" && path == "/imports/upload" -> importsUpload(data)
            method == "POST" && path == "/imports/commit" -> importsCommit(data, user)
            method == "GET" && path.startsWith("/imports/template/") -> importsTemplate(path)
            else -> notFound(path)
        }
    }

    /** نموذج CSV للتحميل: يُرسل إلى الجهاز ليُحفظ عبر واجهة الحفظ في أندرويد. */
    private fun importsTemplate(path: String): JSONObject {
        val kind = path.removePrefix("/imports/template/").removeSuffix(".csv")
        val (name, body) = when (kind) {
            "products" -> "نموذج_الأصناف.csv" to
                "باركود,اسم الصنف,الوحدة,التصنيف,سعر الشراء,سعر البيع,الكمية,تاريخ الانتهاء\n" +
                "6281000123456,أرز بسمتي 5 كيلو,كيس,مواد غذائية,22.00,26.50,40,2027-01-31\n" +
                "6281000998877,لبن طازج 1 لتر,حبة,ألبان,6.75,8.00,24,2026-11-20\n"
            else -> return notFound(path)
        }
        return JSONObject()
            .put("status", 200)
            .put("download", JSONObject().put("name", name).put("text", "\uFEFF" + body))
    }

    private fun importsPage(user: UserEntity): JSONObject {
        val users = db.users().getAll().associate { it.id to it.name }
        val rows = db.importLogs().getAll().take(15).map { l ->
            JSONObject()
                .put("kind", l.kind)
                .put("filename", l.filename)
                .put("added", l.added)
                .put("updated", l.updated)
                .put("errors", l.errors)
                .put("created_at", l.createdAt)
                .put("uname", l.userId?.let { users[it] } ?: "")
        }
        return render("imports.html", "imports", "/imports", JSONObject()
            .put("logs", JSONArray(rows))
            .put("u", userJson(user)))
    }

    private fun importsUpload(data: JSONObject): JSONObject {
        val kind = data.optString("kind")
        if (kind != "products") return redirect("/imports")
        val filename = data.optString("filename").trim()
        val content = data.optString("content")
        val b64 = data.optString("content_b64")
        if (filename.isEmpty() || (content.isBlank() && b64.isEmpty())) {
            flashes.add("error" to "اختر ملفاً أولاً")
            return redirect("/imports")
        }
        val ext = filename.substringAfterLast('.', "").lowercase(java.util.Locale.ROOT)
        if (ext == "xls") {
            flashes.add("error" to "ملف إكسل القديم (XLS) غير مدعوم: احفظه بصيغة XLSX أو CSV")
            return redirect("/imports")
        }
        if (ext != "csv" && ext != "xlsx") {
            flashes.add("error" to "الصيغة المدعومة: CSV أو XLSX")
            return redirect("/imports")
        }
        val rows: List<Row> = try {
            if (b64.isNotEmpty()) {
                val bytes = android.util.Base64.decode(b64, android.util.Base64.DEFAULT)
                if (ext == "xlsx") XlsxReader.read(bytes) else CsvReader.parse(CsvReader.decode(bytes))
            } else {
                CsvReader.parse(content)
            }
        } catch (e: Exception) {
            flashes.add("error" to "تعذّر قراءة الملف: ${e.message ?: "ملف تالف"}")
            return redirect("/imports")
        }
        if (rows.isEmpty()) {
            flashes.add("error" to "الملف فارغ أو غير مفهوم")
            return redirect("/imports")
        }
        val products = ImportRules.prepareProducts(rows) { Money.parse(it, null) }
        val token = java.util.UUID.randomUUID().toString().replace("-", "")
        pendingImports[token] = PendingImport(kind, filename, products)

        val statuses = products.map { it.status }
        val records = JSONArray(products.map { r ->
            JSONObject()
                .put("row", r.row).put("status", r.status.name.lowercase(java.util.Locale.ROOT))
                .put("error", r.error).put("name", r.name).put("barcode", r.barcode)
                .put("unit", r.unit).put("category", r.category)
                .put("cost_cents", r.costCents).put("price_cents", r.priceCents)
                .put("stock", r.stock).put("stock_provided", r.stockProvided)
                .put("expiry", r.expiry ?: JSONObject.NULL)
                .put("aisle", r.aisle).put("shelf", r.shelf)
        })
        return render("import_preview.html", "imports", "/imports", JSONObject()
            .put("kind", kind)
            .put("token", token)
            .put("ext", ".csv")
            .put("filename", filename)
            .put("records", records)
            .put("ok", statuses.count { it == ImportRules.Status.OK })
            .put("warn", statuses.count { it == ImportRules.Status.WARN })
            .put("err", statuses.count { it == ImportRules.Status.ERROR })
            .put("total", statuses.size))
    }

    private fun importsCommit(data: JSONObject, user: UserEntity): JSONObject {
        val kind = data.optString("kind")
        val token = data.optString("token").filter { it in '0'..'9' || it in 'a'..'f' }
        val pending = pendingImports[token]
        if (pending == null || pending.kind != kind) {
            flashes.add("error" to "انتهت صلاحية الملف، أعد الرفع")
            return redirect("/imports")
        }
        if (kind != "products") {
            flashes.add("error" to "استيراد الديون من CSV غير آمن في هذه النسخة؛ لم يُحفظ أي رصيد")
            return redirect("/imports")
        }
        pendingImports.remove(token)
        val c = ImportRepository(db).commitProducts(pending.products, pending.filename, user.id)
        flashes.add("ok" to "تم استيراد الأصناف: جديد ${c.added} • محدَّث ${c.updated} • أخطاء متجاوَزة ${c.errors}")
        return redirect("/imports")
    }

    /** يوم الجهاز بصيغة SQLite/HTML date: أرقام ASCII دائماً حتى لو لغة الهاتف عربية. */
    private fun todayIso(): String = java.text.SimpleDateFormat("yyyy-MM-dd", java.util.Locale.US)
        .format(java.util.Date())

    private fun redirect(to: String): JSONObject = JSONObject().put("status", 302).put("redirect", to)

    private fun notFound(path: String): JSONObject {
        val ctx = JSONObject()
            .put("title", "الصفحة غير متوفرة")
            .put("icon", "🚧")
            .put("msg", "هذه الشاشة قيد التجهيز في هذه النسخة: $path")
            .put("u", currentUser()?.let { userJson(it) } ?: JSONObject.NULL)
        return render("error.html", "error", path, ctx).put("status", 404)
    }

    /** جسم الطلب: JSON من fetch، أو نموذج urlencoded من النماذج الأصلية. */
    private fun parseBody(body: String): JSONObject {
        val t = body.trim()
        if (t.isEmpty()) return JSONObject()
        if (t.startsWith("{")) return try { JSONObject(t) } catch (e: Exception) { JSONObject() }
        val o = JSONObject()
        for (pair in t.split('&')) {
            if (pair.isEmpty()) continue
            val k = java.net.URLDecoder.decode(pair.substringBefore('='), "UTF-8")
            val v = java.net.URLDecoder.decode(pair.substringAfter('=', ""), "UTF-8")
            o.put(k, v)
        }
        return o
    }

    /* ======================= واجهات JSON ======================= */

    private fun canUseApi(user: UserEntity, path: String): Boolean = when (path) {
        "/api/sale" -> canOpen(user, "pos")
        "/api/search", "/api/find" -> canOpen(user, "pos") || canOpen(user, "find") || canOpen(user, "products")
        "/api/customers" -> canOpen(user, "pos") || canOpen(user, "customers")
        "/api/imports/knaash/review", "/api/imports/knaash/customers" -> user.role == "owner"
        else -> true // مسار غير معروف: سيرد 404 من route ولا يغيّر البيانات
    }

    /** يعيد نصاً بصيغة {"status": رقم, "body": نص JSON}. */
    @JavascriptInterface
    fun api(method: String, url: String, body: String): String {
        ensureBootstrap()
        val path = url.substringBefore('?')
        val query = url.substringAfter('?', "")
        val result = try {
            val user = currentUser()
            if (user == null) {
                401 to JSONObject().put("ok", false).put("error", "انتهت الجلسة، سجّل الدخول من جديد")
            } else {
                // شاشة البيع قد تبقى مفتوحة بعد انتهاء الرخصة أو سحب صلاحيتها من العامل.
                val license = licenseCheck(System.currentTimeMillis())
                when {
                    !license.ok -> 403 to JSONObject().put("ok", false)
                        .put("license_required", true).put("error", license.reason)
                    securitySetupPending() -> 403 to JSONObject().put("ok", false)
                        .put("security_setup_required", true).put("error", "غيّر رمز المالك أولاً قبل تشغيل البيع")
                    !canUseApi(user, path) -> 403 to JSONObject().put("ok", false)
                        .put("error", "لا تملك صلاحية هذه العملية")
                    else -> route(method.uppercase(), path, query, body)
                }
            }
        } catch (e: Exception) {
            400 to JSONObject().put("ok", false).put("error", e.message ?: "خطأ غير متوقع")
        }
        return JSONObject().put("status", result.first).put("body", result.second.toString()).toString()
    }

    private fun route(method: String, path: String, query: String, body: String): Pair<Int, JSONObject> {
        return when {
            method == "GET" && path == "/api/search" -> {
                val list = CatalogRepository(db).search(param(query, "q"))
                200 to JSONObject().put("ok", true).put("products", JSONArray(list.map { product(it) }))
            }
            method == "POST" && path == "/api/find" -> find(parseBody(body))
            method == "POST" && path == "/api/sale" -> sale(parseBody(body))
            method == "GET" && path == "/api/customers" -> customers(param(query, "q"))
            method == "POST" && path == "/api/customers" -> createCustomerApi(parseBody(body))
            method == "GET" && path == "/api/imports/knaash/customers" -> knaashCustomerSearch(param(query, "q"))
            method == "GET" && path == "/api/imports/knaash/review" -> knaashReviewLoad(query)
            method == "POST" && path == "/api/imports/knaash/review" ->
                if (body.length > 10_000) 413 to JSONObject().put("ok", false).put("error", "بيانات المراجعة كبيرة جداً")
                else knaashReviewSave(parseBody(body))
            method == "DELETE" && path == "/api/imports/knaash/review" -> knaashReviewClear(query)
            else -> 404 to JSONObject().put("ok", false).put("error", "غير متوفر في هذه النسخة")
        }
    }

    private fun find(req: JSONObject): Pair<Int, JSONObject> {
        val code = req.optString("code").trim()
        if (code.isEmpty()) return 400 to JSONObject().put("ok", false).put("error", "اكتب الباركود أو الاسم")
        val exact = db.products().allByBarcode(code)
        if (exact.size == 1) {
            return 200 to JSONObject().put("ok", true).put("product", product(exact[0]))
        }
        if (exact.size > 1) {
            return 200 to JSONObject().put("ok", true)
                .put("choices", JSONArray(exact.map { product(it) }))
        }
        val rows = db.catalog().searchProducts(code, 8)
        if (rows.size == 1) {
            return 200 to JSONObject().put("ok", true).put("product", product(rows[0]))
        }
        return 200 to JSONObject().put("ok", false).put("error", "لم يُعثر على الصنف")
            .put("suggestions", JSONArray(rows.map { product(it) }))
    }

    private fun sale(req: JSONObject): Pair<Int, JSONObject> {
        val items = req.optJSONArray("items")
        if (items == null || items.length() == 0) {
            return 400 to JSONObject().put("ok", false).put("error", "الفاتورة فارغة")
        }
        val lines = (0 until items.length()).map { i ->
            val line = items.getJSONObject(i)
            RequestedLine(
                productId = line.getLong("product_id"),
                qty = line.optDouble("qty", 1.0).takeIf { q -> !q.isNaN() },
                priceCents = if (line.has("price_cents") && !line.isNull("price_cents")) line.getLong("price_cents") else null,
            )
        }
        val request = SaleRequest(
            lines = lines,
            paymentType = req.optString("payment_type", "cash"),
            discountCents = req.optLong("discount_cents", 0L),
            customerId = if (req.has("customer_id") && !req.isNull("customer_id")) req.getLong("customer_id") else null,
            receivedCents = if (req.has("received_cents") && !req.isNull("received_cents")) req.getLong("received_cents") else null,
            paidCents = if (req.has("paid_cents") && !req.isNull("paid_cents")) req.getLong("paid_cents") else null,
            nonCash = req.optJSONArray("non_cash")?.let { arr ->
                (0 until arr.length()).map { i ->
                    val o = arr.getJSONObject(i)
                    net.arena.rafiq.domain.PaymentRules.Part(
                        method = o.optString("method"),
                        amountCents = o.optLong("amount_cents", 0L),
                        reference = o.optString("reference"),
                    )
                }
            } ?: emptyList(),
        )
        val userId = currentUser()!!.id
        return when (val r = SalesRepository(db).createSale(request, userId)) {
            is RepoResult.Ok -> {
                // الإرسال لا يعطّل البيع أبداً: أي خطأ هنا يُسجَّل فقط
                runCatching { queueWhatsAppInvoice(r.value.invoiceId) }
                200 to JSONObject()
                    .put("ok", true)
                    .put("invoice_id", r.value.invoiceId)
                    .put("number", r.value.number)
                    .put("total", Money.format(r.value.totalCents))
                    .put("change", r.value.changeCents?.let { Money.format(it) } ?: JSONObject.NULL)
            }
            is RepoResult.Failed -> 400 to JSONObject().put("ok", false).put("error", r.message)
        }
    }

    /* ======================= واتساب: إرسال الفاتورة PDF تلقائياً عند الدين ======================= */

    private val waExecutor by lazy { java.util.concurrent.Executors.newSingleThreadExecutor() }

    private fun waSetting(key: String, fallback: String = ""): String =
        db.settings().get(key)?.value?.trim()?.takeIf { it.isNotEmpty() } ?: fallback

    private fun logWa(invoiceId: Long, status: String, detail: String) {
        db.openHelper.writableDatabase.execSQL(
            "INSERT INTO wa_log(created_at, invoice_id, status, detail) VALUES(datetime('now','localtime'), ?, ?, ?)",
            arrayOf<Any>(invoiceId, status, detail.take(300)),
        )
    }

    /** آخر حالة إرسال لعرضها في الإعدادات. */
    private fun waLastStatus(): String =
        db.openHelper.readableDatabase.query("SELECT created_at, status, detail FROM wa_log ORDER BY id DESC LIMIT 1").use { c ->
            if (c.moveToFirst()) "${c.getString(0)} — ${c.getString(1)}: ${c.getString(2)}" else ""
        }

    data class ManualInvoiceShare(
        val document: InvoicePdf.Doc,
        val invoiceNumber: Long,
        val customerName: String,
        val phone: String,
        val userId: Long,
    )

    /** قراءة فقط مع صلاحيات الخادم: ملف PDF محلي، وليس إرسالاً آلياً أو ربطاً بـCloud API. */
    fun prepareManualInvoiceShare(invoiceId: Long): ManualInvoiceShare {
        ensureBootstrap()
        val user = currentUser() ?: throw IllegalStateException("سجّل الدخول من جديد قبل مشاركة الفاتورة")
        if (!licenseCheck(System.currentTimeMillis()).ok || securitySetupPending() || !canOpen(user, "pos")) {
            throw IllegalStateException("لا تملك صلاحية فتح الفاتورة أو انتهت الرخصة")
        }
        val inv = db.invoices().getById(invoiceId)
            ?: throw IllegalArgumentException("رقم الفاتورة غير موجود")
        if (inv.status != "open") throw IllegalStateException("لا تُشارك فاتورة ملغاة")
        val customer = inv.customerId?.let { db.customers().getById(it) }
            ?: throw IllegalStateException("لا يوجد زبون مرتبط بهذه الفاتورة")
        val phone = WhatsAppRules.normalizePhone(customer.phone, waSetting("country_code", "967"))
            ?: throw IllegalStateException("لم يُسجّل لهذا الزبون رقم هاتف صالح")
        return ManualInvoiceShare(invoicePdfDocument(inv, customer), inv.number, customer.name, phone, user.id)
    }

    private fun invoicePdfDocument(inv: InvoiceEntity, customer: CustomerEntity): InvoicePdf.Doc {
        val currency = waSetting("currency", "ريال")
        val items = db.invoiceItems().getByInvoice(inv.id).map {
            val q = if (it.qty % 1.0 == 0.0) it.qty.toLong().toString() else it.qty.toString()
            InvoicePdf.Line(it.name, q, Money.format(it.priceCents), Money.format(it.totalCents))
        }
        return InvoicePdf.Doc(
            store = waSetting("store_name", "المتجر"),
            number = inv.number,
            date = inv.createdAt,
            customer = customer.name,
            lines = items,
            total = "${Money.format(inv.totalCents)} $currency",
            paid = "${Money.format(inv.paidCents)} $currency",
            due = "${Money.format(inv.dueCents)} $currency",
            debtTotal = "${Money.format(SalesRepository(db).customerBalance(customer.id))} $currency",
            footer = waSetting("invoice_footer"),
        )
    }

    /**
     * معاينة جافة (المرحلة أ): بيانات رسالة الواتساب بلا إرسال ولا شبكة ولا كتابة في wa_log.
     * تُستعمل من زر «معاينة الرسالة» قبل قرار المالك بتفعيل الإرسال الفعلي.
     */
    @JavascriptInterface
    fun smsSend(json: String): String {
        return try {
            val o = org.json.JSONObject(json)
            val slot = o.optInt("slot", 1)
            val dest = o.optString("dest")
            val body = o.optString("body")
            val task = o.optString("task")
            val act = net.arena.rafiq.MainActivity.instance
                ?: return """{"status":"unknown","error":"no_activity"}"""
            val sender = net.arena.rafiq.sms.SmsSender(act)
            val r = sender.send(slot, dest, body, task)
            org.json.JSONObject().put("status", r.status).put("segments", r.segments)
                .put("error", r.error ?: org.json.JSONObject.NULL).toString()
        } catch (e: Exception) {
            """{"status":"unknown","error":"bridge_error"}"""
        }
    }

    @JavascriptInterface
    fun smsHandoff(json: String): String {
        return try {
            val o = org.json.JSONObject(json)
            val act = net.arena.rafiq.MainActivity.instance
                ?: return """{"status":"failed"}"""
            val st = net.arena.rafiq.sms.SmsSender(act).handoff(o.optString("dest"), o.optString("body"))
            org.json.JSONObject().put("status", st).toString()
        } catch (e: Exception) {
            """{"status":"failed"}"""
        }
    }

    @JavascriptInterface
    fun smsRequestPermission(): String {
        net.arena.rafiq.sms.SmsSender(net.arena.rafiq.MainActivity.instance ?: return """{"status":"no_activity"}""")
            .requestPermission(net.arena.rafiq.MainActivity.instance)
        return """{"status":"requested"}"""
    }

    @JavascriptInterface
    fun smsPermissionState(): String {
        val act = net.arena.rafiq.MainActivity.instance
            ?: return """{"granted":false}"""
        val granted = net.arena.rafiq.sms.SmsSender(act).hasPermission()
        return """{"granted":$granted}"""
    }

    // ===== 6أ: جسور المزامنة للواجهة الموحدة (طابور/مرآة/مراس) — جداول جديدة فقط =====
    @JavascriptInterface
    fun ofxAdd(json: String): String = try {
        val o = JSONObject(json)
        db.ofx().add(net.arena.rafiq.data.OfxOpEntity(
            id = o.getString("id"), kind = o.getString("kind"), payload = o.optString("payload"),
            status = "queued", queuedAt = o.optString("queuedAt"), anchor = o.optString("anchor")))
        """{"ok":true}"""
    } catch (e: Exception) { """{"ok":false}""" }

    @JavascriptInterface
    fun ofxList(): String {
        val arr = JSONArray()
        for (r in db.ofx().recent()) arr.put(JSONObject().put("id", r.id).put("kind", r.kind)
            .put("payload", r.payload).put("status", r.status).put("attempts", r.attempts)
            .put("serverRef", r.serverRef).put("note", r.note).put("queuedAt", r.queuedAt))
        return arr.toString()
    }

    @JavascriptInterface
    fun ofxQueuedCount(): String = db.ofx().queuedCount().toString()

    @JavascriptInterface
    fun ofxSettle(id: String, status: String, ref: String, note: String): String {
        db.ofx().settle(id, status, ref, note); return """{"ok":true}"""
    }

    @JavascriptInterface
    fun mirrorPut(json: String): String = try {
        val arr = JSONArray(json)
        val rows = mutableListOf<net.arena.rafiq.data.MirrorRowEntity>()
        for (i in 0 until arr.length()) {
            val o = arr.getJSONObject(i)
            rows.add(net.arena.rafiq.data.MirrorRowEntity(o.getString("tbl"), o.getString("id"), o.optString("json"), o.optString("updatedAt")))
        }
        db.mirror().put(rows); """{"ok":true}"""
    } catch (e: Exception) { """{"ok":false}""" }

    @JavascriptInterface
    fun mirrorGet(tbl: String): String {
        val arr = JSONArray()
        for (r in db.mirror().all(tbl)) arr.put(JSONObject().put("id", r.id).put("json", r.json).put("updatedAt", r.updatedAt))
        return arr.toString()
    }

    @JavascriptInterface
    fun metaGet(k: String): String = db.syncMeta().get(k) ?: ""

    @JavascriptInterface
    fun metaSet(k: String, v: String): String {
        db.syncMeta().set(net.arena.rafiq.data.SyncMetaEntity(k, v)); return """{"ok":true}"""
    }

    @JavascriptInterface
    fun waPreview(invoiceId: Long): String {
        val inv = db.invoices().getById(invoiceId)
            ?: return JSONObject().put("ok", false).put("reason", "invoice_missing").toString()
        if (!WhatsAppRules.needsSend(inv.paymentType, inv.dueCents))
            return JSONObject().put("ok", false).put("reason", "not_credit_due").toString()
        val customer = inv.customerId?.let { db.customers().getById(it) }
            ?: return JSONObject().put("ok", false).put("reason", "customer_missing").toString()
        val phone = WhatsAppRules.normalizePhone(customer.phone, waSetting("country_code", "967"))
            ?: return JSONObject().put("ok", false).put("reason", "phone_invalid").toString()
        val currency = waSetting("currency", "ريال")
        val debt = SalesRepository(db).customerBalance(customer.id)
        val body = WhatsAppRules.previewBody(
            "${Money.format(inv.totalCents)} $currency",
            "${Money.format(debt)} $currency")
        val settingsComplete = waSetting("wa_phone_id").isNotEmpty() &&
            waSetting("wa_token").isNotEmpty() && waSetting("wa_template").isNotEmpty()
        return JSONObject().put("ok", true).put("to", phone).put("body", body)
            .put("settings_complete", settingsComplete).toString()
    }

    /**
     * بعد البيع الآجل الذي بقي فيه دين: يبني الفاتورة PDF ثم يرسلها بقالب واتساب في خيط خلفي.
     * تُسجَّل الحالة في wa_log: sent أو failed أو skipped (لم تُضبط البيانات أو لا رقم صالح).
     */
    private fun queueWhatsAppInvoice(invoiceId: Long) {
        val inv = db.invoices().getById(invoiceId) ?: return
        if (!WhatsAppRules.needsSend(inv.paymentType, inv.dueCents)) return
        val customerId = inv.customerId ?: return
        val customer = db.customers().getById(customerId) ?: return
        val phoneId = waSetting("wa_phone_id")
        val token = waSetting("wa_token")
        val template = waSetting("wa_template")
        if (phoneId.isEmpty() || token.isEmpty() || template.isEmpty()) {
            logWa(invoiceId, "skipped", "لم تُضبط بيانات واتساب في الإعدادات")
            return
        }
        val phone = WhatsAppRules.normalizePhone(customer.phone, waSetting("country_code", "967"))
        if (phone == null) {
            logWa(invoiceId, "skipped", "لا يوجد رقم واتساب صالح للزبون")
            return
        }
        val lang = waSetting("wa_lang", "ar")
        val doc = invoicePdfDocument(inv, customer)
        val totalText = doc.total
        val debtText = doc.debtTotal
        val fileName = "invoice-${inv.number}.pdf"
        waExecutor.execute {
            try {
                val client = net.arena.rafiq.whatsapp.WhatsAppClient(phoneId, token)
                val media = client.uploadPdf(InvoicePdf.render(doc), fileName)
                val payload = WhatsAppRules.templatePayload(phone, template, lang, media, fileName, totalText, debtText)
                client.sendTemplate(payload)
                logWa(invoiceId, "sent", "أُرسلت إلى $phone")
            } catch (e: Exception) {
                logWa(invoiceId, "failed", e.message ?: "فشل الإرسال")
            }
        }
    }

    private fun customerForApi(c: net.arena.rafiq.data.CustomerEntity, balance: Long): JSONObject =
        JSONObject().put("id", c.id).put("code", CustomerCode.display(c.id))
            .put("name", c.name).put("phone", c.phone)
            .put("balance_cents", balance).put("balance", Money.format(balance))

    private fun customers(q: String): Pair<Int, JSONObject> {
        val needle = q.trim()
        // الرمز الصريح #00042 بحث مطابق فقط: لا يطابق هاتف زبون آخر ولا اسمه.
        val rows = if (needle.startsWith('#')) {
            val id = CustomerCode.parseExplicit(needle)
            listOfNotNull(id?.let { db.customers().getById(it) }?.takeIf { it.active == 1 })
        } else {
            db.customers().getAll()
                .filter { it.active == 1 && (needle.isEmpty() || it.name.contains(needle) || it.phone.contains(needle)) }
                .sortedBy { it.name }
                .take(20)
        }
        val sales = SalesRepository(db)
        return 200 to JSONObject().put("ok", true)
            .put("customers", JSONArray(rows.map { c -> customerForApi(c, sales.customerBalance(c.id)) }))
    }

    /** البحث داخل رفيق للمراجعة فقط؛ لا يختار الاسم الشبيه نيابةً عن المالك. */
    private fun knaashCustomerSearch(q: String): Pair<Int, JSONObject> {
        val list = KnaashReviewRepository(db).searchCustomers(q)
        val sales = SalesRepository(db)
        return 200 to JSONObject().put("ok", true).put("customers", JSONArray(list.map { (c, previous) ->
            JSONObject().put("id", c.id).put("code", CustomerCode.display(c.id))
                .put("name", c.name).put("phone", c.phone)
                .put("balance_cents", sales.customerBalance(c.id))
                .put("has_history", previous)
        }))
    }

    private fun knaashStateJson(state: KnaashReviewRepository.State): JSONObject =
        JSONObject().put("ok", true).put("reviewed", state.choices.size)
            .put("other_file", state.otherFile)
            .put("previous_sha256", state.previousSha256)
            .put("previous_date", state.previousDate)
            .put("previous_count", state.previousCount)
            .put("problem", state.currentProblem ?: "")
            .put("choices", JSONArray(state.choices.map { c ->
                JSONObject().put("index", c.index).put("mode", c.mode)
                    .also { row ->
                        if (c.mode == "existing") row.put("customer_id", c.customerId)
                        if (c.mode == "new") row.put("name", c.name).put("phone", c.phone)
                        if (c.mode == "zero") row.put("reported_balance_cents", c.reportedBalanceCents)
                    }
            }))

    private fun knaashReviewLoad(query: String): Pair<Int, JSONObject> {
        val result = KnaashReviewRepository(db).load(param(query, "sha"), param(query, "date"),
            param(query, "count").toIntOrNull() ?: 0)
        return when (result) {
            is RepoResult.Ok -> 200 to knaashStateJson(result.value)
            is RepoResult.Failed -> 400 to JSONObject().put("ok", false).put("error", result.message)
        }
    }

    private fun knaashReviewSave(data: JSONObject): Pair<Int, JSONObject> {
        val row = data.optJSONObject("choice")
            ?: return 400 to JSONObject().put("ok", false).put("error", "اختر صفاً واحداً لمراجعته")
        val choice = KnaashReviewRules.Choice(
            index = row.optInt("index"), mode = row.optString("mode"),
            customerId = if (row.has("customer_id") && !row.isNull("customer_id")) row.getLong("customer_id") else null,
            name = row.optString("name"), phone = row.optString("phone"),
            reportedBalanceCents = if (row.has("reported_balance_cents") && !row.isNull("reported_balance_cents"))
                row.getLong("reported_balance_cents") else null,
        )
        val result = KnaashReviewRepository(db).save(data.optString("sha"), data.optString("date"),
            data.optInt("count"), choice)
        return when (result) {
            is RepoResult.Ok -> 200 to knaashStateJson(result.value)
            is RepoResult.Failed -> 409 to JSONObject().put("ok", false).put("error", result.message)
        }
    }

    private fun knaashReviewClear(query: String): Pair<Int, JSONObject> =
        when (val result = KnaashReviewRepository(db).clear(param(query, "sha"))) {
            is RepoResult.Ok -> 200 to JSONObject().put("ok", true)
            is RepoResult.Failed -> 409 to JSONObject().put("ok", false).put("error", result.message)
        }

    /** إنشاء زبون في شاشة الآجل: نعيد الهوية المُنشأة نفسها، فلا نختار الاسم الأول بالخطأ. */
    private fun createCustomerApi(data: JSONObject): Pair<Int, JSONObject> {
        val name = data.optString("name").trim()
        val phone = data.optString("phone").trim()
        if (name.isEmpty() || name.length > 120 || name.any { Character.isISOControl(it) }) {
            return 400 to JSONObject().put("ok", false).put("error", "اكتب اسماً صحيحاً للزبون (حتى 120 حرفاً)")
        }
        if (phone.length > 40 || phone.any { Character.isISOControl(it) }) {
            return 400 to JSONObject().put("ok", false).put("error", "رقم الهاتف غير صالح")
        }
        val id = db.customers().insert(net.arena.rafiq.data.CustomerEntity(name = name, phone = phone))
        val created = db.customers().getById(id)!!
        return 200 to JSONObject().put("ok", true).put("customer", customerForApi(created, 0L))
    }

    private fun product(p: ProductEntity): JSONObject {
        val root = StockSharing.stockProduct(db, p)
        return JSONObject()
            .put("id", p.id)
            .put("name", p.name)
            .put("barcode", p.barcode ?: "")
            .put("unit", p.unit)
            .put("price_cents", p.priceCents)
            .put("stock", root?.stock ?: 0.0)
            .put("low_stock", root?.lowStock ?: 0.0)
            .put("shared_stock_with", StockSharing.linkedRootId(db, p.id) ?: JSONObject.NULL)
            .put("price", Money.format(p.priceCents))
            .put("loc", ShelfRules.locationText(p.aisle, p.shelf))
    }

    private fun param(query: String, key: String): String {
        for (pair in query.split('&')) {
            if (pair.substringBefore('=') == key) {
                return java.net.URLDecoder.decode(pair.substringAfter('=', ""), "UTF-8")
            }
        }
        return ""
    }
}
