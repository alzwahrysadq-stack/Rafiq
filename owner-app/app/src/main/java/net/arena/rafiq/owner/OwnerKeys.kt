package net.arena.rafiq.owner

import android.content.Context
import android.content.SharedPreferences
import android.util.Base64
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.PrivateKey
import java.security.PublicKey
import java.security.spec.PKCS8EncodedKeySpec
import java.security.spec.X509EncodedKeySpec

/**
 * مفاتيح المالك: زوج RSA-2048 يُنشأ مرة واحدة على هذا الهاتف.
 * المفتاح الخاص لا يُعرض ولا يُصدَّر ولا يُنسخ إلى أي مكان؛ يُخزَّن مشفّراً في EncryptedSharedPreferences.
 */
object OwnerKeys {
    private const val FILE = "owner_keys_v1"
    private const val K_PRIV = "private_pkcs8"
    private const val K_PUB = "public_x509"

    private fun prefs(ctx: Context): SharedPreferences {
        val master = MasterKey.Builder(ctx).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build()
        return EncryptedSharedPreferences.create(
            ctx,
            FILE,
            master,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
    }

    @Synchronized
    fun load(ctx: Context): Pair<PrivateKey, PublicKey> {
        val p = prefs(ctx)
        val priv = p.getString(K_PRIV, null)
        val pub = p.getString(K_PUB, null)
        if (priv != null && pub != null) {
            val kf = KeyFactory.getInstance("RSA")
            return kf.generatePrivate(PKCS8EncodedKeySpec(Base64.decode(priv, Base64.NO_WRAP))) to
                kf.generatePublic(X509EncodedKeySpec(Base64.decode(pub, Base64.NO_WRAP)))
        }
        val pair = KeyPairGenerator.getInstance("RSA").apply { initialize(2048) }.generateKeyPair()
        val saved = p.edit()
            .putString(K_PRIV, Base64.encodeToString(pair.private.encoded, Base64.NO_WRAP))
            .putString(K_PUB, Base64.encodeToString(pair.public.encoded, Base64.NO_WRAP))
            .commit()
        check(saved) { "تعذّر حفظ مفاتيح المالك" }
        return pair.private to pair.public
    }

    /** المفتاح العام فقط: هذا ما يُنسخ إلى بناء التطبيق الرئيسي (RAFIQ_LICENSE_PUBKEY). */
    fun publicKeyB64(ctx: Context): String = Base64.encodeToString(load(ctx).second.encoded, Base64.NO_WRAP)
}
