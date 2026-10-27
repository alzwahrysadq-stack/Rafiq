package net.arena.rafiq.owner

import android.app.Activity
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.graphics.Typeface
import android.os.Bundle
import android.text.InputType
import android.view.View
import android.widget.ArrayAdapter
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.Spinner
import android.widget.TextView
import android.widget.Toast
import net.arena.rafiq.license.LicenseVerifier
import net.arena.rafiq.license.StoreLicenseVerifier
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * تطبيق المالك: يُصدر رخص رفيق ويتحقق منها. المفتاح الخاص يبقى على هذا الهاتف فقط.
 * واجهة بسيطة بلا مكتبات UI، لتبقى سريعة وخفيفة.
 */
class MainActivity : Activity() {

    private lateinit var pubText: TextView
    private lateinit var copyPubButton: Button
    private var publicKeyReady: String? = null
    private lateinit var devInput: EditText
    private lateinit var storeIdInput: EditText
    private lateinit var seatCountInput: EditText
    private lateinit var nameInput: EditText
    private lateinit var amountInput: EditText
    private lateinit var periodSpinner: Spinner
    private lateinit var tokenOut: TextView
    private lateinit var checkToken: EditText
    private lateinit var checkDev: EditText
    private lateinit var checkResult: TextView
    private var lastToken: String = ""

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(16), dp(16), dp(16), dp(24))
            layoutDirection = View.LAYOUT_DIRECTION_RTL
        }
        setContentView(ScrollView(this).apply { addView(root) })

        root.addView(title("رفيق للمالك"))
        root.addView(note(
            "تنبيه: المفتاح الخاص محفوظ على هذا الهاتف فقط. لا تحذف التطبيق ولا تمسح بياناته، " +
                "وإلا لن تستطيع إصدار رخص جديدة بنفس المفتاح.",
        ))

        // ---- المفتاح العام
        root.addView(section("1) المفتاح العام"))
        root.addView(note("انسخ هذا المفتاح وضعه في أسرار GitHub باسم RAFIQ_LICENSE_PUBKEY ثم أعد بناء التطبيق الرئيسي."))
        pubText = body("جارٍ تجهيز المفاتيح...")
        root.addView(pubText)
        copyPubButton = button("نسخ المفتاح العام") {
            val key = publicKeyReady
            if (key == null) toast("انتظر ظهور المفتاح العام الصحيح أولاً")
            else copy(key, "نُسخ المفتاح العام")
        }.apply { isEnabled = false }
        root.addView(copyPubButton)

        // ---- رخصة متجر مشتركة، تبقى خاضعة لمقاعد وموافقة الخادم
        root.addView(section("2) رخصة متجر متعددة الأجهزة — مشروع اختبار فقط"))
        root.addView(note("أنشئ هوية المتجر ومقاعد الأجهزة في مشروع الاختبار أولاً. الرمز نفسه للأجهزة المعتمدة فقط؛ لا يكفي وحده لفتح بيع أو وردية."))
        storeIdInput = input("معرّف المتجر UUID من مشروع الاختبار", InputType.TYPE_CLASS_TEXT)
        seatCountInput = input("عدد الأجهزة المسموح (1–50)", InputType.TYPE_CLASS_NUMBER).apply { text.append("2") }
        nameInput = input("اسم المتجر / الزبون", InputType.TYPE_CLASS_TEXT)
        root.addView(storeIdInput)
        root.addView(seatCountInput)
        root.addView(nameInput)

        val row = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        amountInput = input("المدة", InputType.TYPE_CLASS_NUMBER).apply { text.append("1") }
        periodSpinner = Spinner(this).apply {
            adapter = ArrayAdapter(
                this@MainActivity,
                android.R.layout.simple_spinner_dropdown_item,
                LicenseIssuer.Period.values().map { it.label },
            )
            setSelection(LicenseIssuer.Period.MONTH.ordinal)
        }
        row.addView(amountInput, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
        row.addView(periodSpinner, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
        root.addView(row)

        root.addView(button("أصدِر رخصة المتجر المشتركة (RFQ2)") { issueStore() })
        root.addView(section("رخصة جهاز قديمة RFQ1 (غير مشتركة)"))
        devInput = input("معرّف جهاز واحد فقط لرخصة RFQ1", InputType.TYPE_CLASS_TEXT)
        root.addView(devInput)
        root.addView(button("أصدِر رخصة جهاز قديمة") { issue() })
        tokenOut = body("").apply { setTextIsSelectable(true) }
        root.addView(tokenOut)
        root.addView(button("نسخ الرخصة") {
            if (lastToken.isEmpty()) toast("أصدر رخصة أولاً") else copy(lastToken, "نُسخت الرخصة")
        })
        root.addView(button("مشاركة الرخصة") {
            if (lastToken.isEmpty()) {
                toast("أصدر رخصة أولاً")
            } else {
                startActivity(Intent.createChooser(
                    Intent(Intent.ACTION_SEND).apply { type = "text/plain"; putExtra(Intent.EXTRA_TEXT, lastToken) },
                    "مشاركة الرخصة",
                ))
            }
        })

        // ---- التحقق من رخصة (للاختبار قبل الإرسال)
        root.addView(section("3) اختبار رخصة"))
        checkDev = input("معرّف المتجر لـRFQ2 أو الجهاز لـRFQ1", InputType.TYPE_CLASS_TEXT)
        checkToken = input("الصق الرخصة هنا", InputType.TYPE_CLASS_TEXT)
        root.addView(checkDev)
        root.addView(checkToken)
        root.addView(button("تحقّق من الرخصة") { check() })
        checkResult = body("")
        root.addView(checkResult)

        // توليد المفاتيح عند أول تشغيل في الخلفية حتى لا تتجمد الواجهة
        Thread {
            val loaded = runCatching { OwnerKeys.publicKeyB64(this) }
            runOnUiThread {
                loaded.onSuccess { pub ->
                    publicKeyReady = pub
                    pubText.text = pub
                    copyPubButton.isEnabled = true
                }.onFailure {
                    publicKeyReady = null
                    pubText.text = "تعذّر تجهيز المفاتيح؛ لا تنسخ نص الخطأ. أعد فتح التطبيق وحاول مجدداً."
                    copyPubButton.isEnabled = false
                }
            }
        }.start()
    }

    private fun issueStore() {
        lastToken = ""
        tokenOut.text = ""
        val store = storeIdInput.text.toString()
        val name = nameInput.text.toString()
        val seats = seatCountInput.text.toString().toIntOrNull() ?: 0
        val amount = amountInput.text.toString().toIntOrNull() ?: 0
        val period = LicenseIssuer.Period.values()[periodSpinner.selectedItemPosition]
        try {
            val priv = OwnerKeys.load(this).first
            lastToken = LicenseIssuer.issueStore(priv, store, name, seats, amount, period)
            tokenOut.text = lastToken
            toast("أُصدرت رخصة المتجر للاختبار؛ الموافقة على كل جهاز في الخادم مطلوبة")
        } catch (e: IllegalArgumentException) {
            toast(e.message ?: "بيانات غير صحيحة")
        } catch (_: Exception) {
            toast("تعذّر إصدار رخصة المتجر")
        }
    }

    private fun issue() {
        lastToken = ""
        tokenOut.text = ""
        val dev = devInput.text.toString()
        val name = nameInput.text.toString()
        val amount = amountInput.text.toString().toIntOrNull() ?: 0
        val period = LicenseIssuer.Period.values()[periodSpinner.selectedItemPosition]
        try {
            val priv = OwnerKeys.load(this).first
            lastToken = LicenseIssuer.issue(priv, dev, name, amount, period)
            tokenOut.text = lastToken
            toast("أُصدرت الرخصة")
        } catch (e: IllegalArgumentException) {
            toast(e.message ?: "بيانات غير صحيحة")
        } catch (e: Exception) {
            toast("تعذّر إصدار الرخصة: ${e.message}")
        }
    }

    private fun check() {
        val pub = publicKeyReady
        if (pub == null) {
            checkResult.text = "المفتاح العام غير جاهز بعد."
            return
        }
        val token = checkToken.text.toString().trim()
        val expected = checkDev.text.toString().trim()
        if (token.startsWith("${StoreLicenseVerifier.PREFIX}.")) {
            val r = StoreLicenseVerifier.verify(token, pub, expected, System.currentTimeMillis())
            checkResult.text = if (r.ok && r.info != null) {
                val exp = SimpleDateFormat("yyyy-MM-dd", Locale.US).format(Date(r.info.expiresAt))
                "✅ ${r.reason}\nالمتجر: ${r.info.name}\nالمقاعد: ${r.info.seats}\nتنتهي: $exp\nالتفعيل يتطلب موافقة الخادم"
            } else "❌ ${r.reason}"
            return
        }
        val r = LicenseVerifier.verify(token, pub, expected, System.currentTimeMillis())
        checkResult.text = if (r.ok && r.info != null) {
            val exp = SimpleDateFormat("yyyy-MM-dd", Locale.US).format(Date(r.info.expiresAt))
            "✅ ${r.reason}\nالمرخّص له: ${r.info.name}\nتنتهي: $exp"
        } else {
            "❌ ${r.reason}"
        }
    }

    private fun copy(text: String, msg: String) {
        val cm = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        cm.setPrimaryClip(ClipData.newPlainText("rafiq", text))
        toast(msg)
    }

    private fun toast(msg: String) = Toast.makeText(this, msg, Toast.LENGTH_SHORT).show()

    private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()

    private fun title(t: String) = TextView(this).apply {
        text = t
        textSize = 22f
        setTypeface(typeface, Typeface.BOLD)
        setPadding(0, 0, 0, dp(8))
    }

    private fun section(t: String) = TextView(this).apply {
        text = t
        textSize = 17f
        setTypeface(typeface, Typeface.BOLD)
        setPadding(0, dp(18), 0, dp(6))
    }

    private fun note(t: String) = TextView(this).apply {
        text = t
        textSize = 13f
        setPadding(0, 0, 0, dp(6))
    }

    private fun body(t: String) = TextView(this).apply {
        text = t
        textSize = 14f
        setTextIsSelectable(true)
        setPadding(0, dp(4), 0, dp(4))
    }

    private fun input(hint: String, type: Int) = EditText(this).apply {
        this.hint = hint
        inputType = type
        textSize = 15f
    }

    private fun button(label: String, onClick: () -> Unit) = Button(this).apply {
        text = label
        setOnClickListener { onClick() }
    }
}
