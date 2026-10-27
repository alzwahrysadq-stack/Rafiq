package net.arena.rafiq

import android.app.Activity
import android.app.AlertDialog
import android.content.Context
import android.os.Build
import android.os.CancellationSignal
import android.text.InputType
import android.view.Gravity
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.Toast
import org.json.JSONObject
import java.security.MessageDigest

/**
 * قفل التطبيق المحلي (واجهة 130): بصمة (API 28+) أو رقم سري (PIN).
 * يقفل هذا الهاتف فقط — كلمة مرور الخادم تبقى هي الأصل، ولا شيء من هنا يمنح صلاحية.
 * النتيجة تُبلَّغ للويب عبر window.__rafiqLockChanged().
 */
class AppLock(private val activity: Activity) {
    private val prefs = activity.getSharedPreferences("rafiq_app_lock", Context.MODE_PRIVATE)
    private var cancelSignal: CancellationSignal? = null

    private fun webEval(js: String) {
        try {
            val web = (activity as? CloudPilotActivity)?.webViewForLock() ?: return
            activity.runOnUiThread { web.evaluateJavascript(js, null) }
        } catch (_: Exception) { }
    }

    private fun changed() = webEval("window.__rafiqLockChanged&&window.__rafiqLockChanged()")

    private fun hashPin(pin: String): String =
        MessageDigest.getInstance("SHA-256").digest(pin.toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it) }

    /** سبب تعطّل البصمة بلغة مفهومة — لا خانة تُأشَّر ثم تنكسر بصمت. */
    private fun bioAvailability(): Pair<Boolean, String?> {
        if (Build.VERSION.SDK_INT < 28) return false to "البصمة تحتاج أندرويد 9 فأعلى"
        val bm = activity.getSystemService(Context.BIOMETRIC_SERVICE) as? android.hardware.biometrics.BiometricManager
            ?: return false to "مستشعر البصمة غير متاح على هذا الهاتف"
        @Suppress("DEPRECATION")
        return when (bm.canAuthenticate()) {
            android.hardware.biometrics.BiometricManager.BIOMETRIC_SUCCESS -> true to null
            android.hardware.biometrics.BiometricManager.BIOMETRIC_ERROR_NONE_ENROLLED ->
                false to "لا توجد بصمة مسجلة على هذا الهاتف — أضفها من إعدادات أندرويد ثم عُد."
            android.hardware.biometrics.BiometricManager.BIOMETRIC_ERROR_NO_HARDWARE ->
                false to "هذا الهاتف لا يدعم البصمة — استخدم الرقم السري."
            else -> false to "مستشعر البصمة غير متاح الآن — استخدم الرقم السري."
        }
    }

    fun status(): JSONObject {
        val (available, reason) = bioAvailability()
        return JSONObject()
            .put("ok", true)
            .put("bio", prefs.getBoolean("bio", false))
            .put("pin", prefs.contains("pin_hash"))
            .put("bio_available", available || prefs.getBoolean("bio", false))
            .put("bio_reason", reason ?: JSONObject.NULL)
    }

    fun isLocked(): Boolean = prefs.getBoolean("bio", false) || prefs.contains("pin_hash")

    /** أوامر الجسر: set_pin / enable_bio / disable_pin / disable_bio / clear / unlock / status. */
    fun handle(action: String): JSONObject = when (action) {
        "status" -> status()
        "set_pin" -> { promptSetPin(); JSONObject().put("ok", true) }
        "enable_bio" -> enableBio()
        "disable_bio" -> { prefs.edit().putBoolean("bio", false).apply(); status() }
        "disable_pin" -> { prefs.edit().remove("pin_hash").apply(); status() }
        "clear" -> { prefs.edit().clear().apply(); status() }
        "unlock" -> { requestUnlock(); JSONObject().put("ok", true) }
        else -> JSONObject().put("ok", false).put("error", "أمر غير معروف")
    }

    private fun enableBio(): JSONObject {
        val (available, reason) = bioAvailability()
        if (!available) return JSONObject().put("ok", false).put("error", reason ?: "البصمة غير متاحة على هذا الهاتف")
        prefs.edit().putBoolean("bio", true).apply()
        return status()
    }

    private fun promptSetPin() {
        activity.runOnUiThread {
            val input = EditText(activity)
            input.inputType = InputType.TYPE_CLASS_NUMBER or InputType.TYPE_NUMBER_VARIATION_PASSWORD
            input.hint = "٤ أرقام على الأقل"
            input.gravity = Gravity.CENTER
            AlertDialog.Builder(activity)
                .setTitle("الرقم السري")
                .setView(input)
                .setPositiveButton("حفظ") { _, _ ->
                    val p = input.text?.toString()?.trim().orEmpty()
                    if (p.length >= 4) {
                        prefs.edit().putString("pin_hash", hashPin(p)).apply()
                        Toast.makeText(activity, "حُفظ الرقم السري", Toast.LENGTH_SHORT).show()
                        changed()
                    } else Toast.makeText(activity, "الرقم قصير — ٤ أرقام على الأقل", Toast.LENGTH_LONG).show()
                }
                .setNegativeButton("إلغاء", null)
                .show()
        }
    }

    /** قفل فتح التطبيق: البصمة أولًا ثم الرقم السري بديلًا. */
    fun requestUnlock() {
        activity.runOnUiThread {
            if (prefs.getBoolean("bio", false) && Build.VERSION.SDK_INT >= 28) promptBiometric(onFail = { promptPin() })
            else promptPin()
        }
    }

    private fun promptBiometric(onFail: () -> Unit) {
        if (Build.VERSION.SDK_INT < 28) { onFail(); return }
        try {
            cancelSignal?.cancel()
            val signal = CancellationSignal()
            cancelSignal = signal
            var fellBack = false
            val fallBack: () -> Unit = { if (!fellBack) { fellBack = true; onFail() } }
            val prompt = android.hardware.biometrics.BiometricPrompt.Builder(activity)
                .setTitle("قفل رفيق")
                .setSubtitle("استخدم بصمتك للدخول إلى المتجر")
                .setNegativeButton("استخدم الرقم السري", activity.mainExecutor) { _, _ -> fallBack() }
                .build()
            prompt.authenticate(signal, activity.mainExecutor, object : android.hardware.biometrics.BiometricPrompt.AuthenticationCallback() {
                override fun onAuthenticationSucceeded(result: android.hardware.biometrics.BiometricPrompt.AuthenticationResult) {
                    overlayOff()
                }
                override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                    // أي فشل/إلغاء = بديل الرقم السري مرة واحدة فقط
                    fallBack()
                }
            })
        } catch (_: Exception) { onFail() }
    }

    private fun promptPin() {
        activity.runOnUiThread {
            val input = EditText(activity)
            input.inputType = InputType.TYPE_CLASS_NUMBER or InputType.TYPE_NUMBER_VARIATION_PASSWORD
            input.hint = "الرقم السري"
            input.gravity = Gravity.CENTER
            val dialog = AlertDialog.Builder(activity)
                .setTitle("قفل رفيق")
                .setView(input)
                .setPositiveButton("دخول", null)
                .setNegativeButton("خروج") { _, _ -> activity.finish() }
                .create()
            dialog.setOnShowListener {
                dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
                    val p = input.text?.toString()?.trim().orEmpty()
                    if (prefs.getString("pin_hash", "") == hashPin(p)) {
                        dialog.dismiss(); overlayOff()
                    } else {
                        input.text?.clear()
                        Toast.makeText(activity, "الرقم السري غير صحيح", Toast.LENGTH_SHORT).show()
                    }
                }
            }
            dialog.setCancelable(false)
            dialog.show()
        }
    }

    private fun overlayOff() {
        try { (activity as? CloudPilotActivity)?.webViewForLock()?.visibility = android.view.View.VISIBLE } catch (_: Exception) { }
    }

    /** يُستدعى فور إقلاع النشاط: يخفي الواجهة حتى التحقق. */
    fun lockOnStart() {
        if (!isLocked()) return
        try { (activity as? CloudPilotActivity)?.webViewForLock()?.visibility = android.view.View.INVISIBLE } catch (_: Exception) { }
        requestUnlock()
    }
}
