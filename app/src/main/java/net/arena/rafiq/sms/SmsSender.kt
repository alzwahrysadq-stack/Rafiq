package net.arena.rafiq.sms

import android.Manifest
import android.app.Activity
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.telephony.SmsManager
import android.telephony.SubscriptionManager

/**
 * الإرسال من شريحة الجهاز الذي يعينه المالك لكل متجر.
 * لا READ_SMS أبدًا؛ لا بوابة خارجية؛ لا أسرار في APK.
 * حد الاعتمادية: انقطاع التطبيق بين الإرسال وكتابة الإقرار قد يترك حالة unknown للمراجعة.
 */
class SmsSender(private val context: Context) {

    fun hasPermission(): Boolean =
        context.checkSelfPermission(Manifest.permission.SEND_SMS) == PackageManager.PERMISSION_GRANTED

    fun requestPermission(activity: Activity?) {
        activity ?: return
        // الشرح قبل الطلب (سياسة runtime): يُعرض في الواجهة قبل requestPermissions.
        activity.requestPermissions(arrayOf(Manifest.permission.SEND_SMS), REQ_SMS)
    }

    /** المسار المطابق لسياسة المتجر عندما لا يُسمح بالإرسال التلقائي: فتح تطبيق الرسائل بتأكيد بشري. */
    fun handoff(dest: String, body: String): String {
        return try {
            val intent = Intent(Intent.ACTION_SENDTO, Uri.parse("sms:$dest"))
            intent.putExtra("sms_body", body)
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            context.startActivity(intent)
            "manual_handoff"
        } catch (e: Exception) {
            "failed"
        }
    }

    data class Result(val status: String, val segments: Int, val error: String? = null)

    fun send(slot: Int, dest: String, body: String, taskTag: String): Result {
        if (!hasPermission()) return Result("blocked", 0, "permission_required")
        return try {
            val manager = managerForSlot(slot)
            val parts = ArrayList(SmsRules.splitParts(body))
            val n = parts.size
            val sentIntents = ArrayList<PendingIntent>(n)
            val deliveryIntents = ArrayList<PendingIntent>(n)
            for (i in 0 until n) {
                sentIntents.add(broadcastIntent(context, "RAFIQ_SMS_SENT", taskTag, i))
                deliveryIntents.add(broadcastIntent(context, "RAFIQ_SMS_DELIVERED", taskTag, i))
            }
            manager.sendMultipartTextMessage(dest, null, parts, sentIntents, deliveryIntents)
            Result(SmsRules.mapSendResult(true, null), n)
        } catch (e: SecurityException) {
            Result("blocked", 0, "permission_required")
        } catch (e: IllegalArgumentException) {
            Result("failed", 0, "PERMANENT_FAILURE")
        } catch (e: Exception) {
            Result(SmsRules.mapSendResult(false, classify(e)), 0, classify(e))
        }
    }

    private fun classify(e: Exception): String = when (e) {
        is java.lang.IllegalStateException -> "RADIO_OFF"
        else -> "UNKNOWN"
    }

    private fun managerForSlot(slot: Int): SmsManager {
        return try {
            val sub = context.getSystemService(SubscriptionManager::class.java)
            val list = sub?.activeSubscriptionInfoList
            val info = list?.getOrNull(if (slot == 2) 1 else 0)
            if (info != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP_MR1) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    context.getSystemService(SmsManager::class.java)
                        ?: SmsManager.getDefault()
                } else @Suppress("DEPRECATION") SmsManager.getSmsManagerForSubscriptionId(info.subscriptionId)
            } else @Suppress("DEPRECATION") SmsManager.getDefault()
        } catch (e: Exception) {
            @Suppress("DEPRECATION") SmsManager.getDefault()
        }
    }

    private fun broadcastIntent(context: Context, action: String, taskTag: String, part: Int): PendingIntent {
        val intent = Intent(action).putExtra("task", taskTag).putExtra("part", part)
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        return PendingIntent.getBroadcast(context, (taskTag.hashCode() + part), intent, flags)
    }

    companion object {
        const val REQ_SMS = 4310
    }
}
