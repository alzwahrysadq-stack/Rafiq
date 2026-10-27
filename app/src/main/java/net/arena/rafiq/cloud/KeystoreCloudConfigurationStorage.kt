package net.arena.rafiq.cloud

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.nio.charset.StandardCharsets
import java.security.KeyStore
import java.util.UUID
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Encrypted per-install config. Never put the URL/key into Room, WebView storage or a backup. */
class KeystoreCloudConfigurationStorage(context: Context) : CloudConfigurationStorage {
    private val directory = context.noBackupFilesDir
    private fun keyAlias(storeId: String) = "net.arena.rafiq.cloud.config.v1.$storeId"
    private fun file(storeId: String) = AtomicFile(File(directory, "cloud_config_${storeId}.bin"))

    private fun binding(raw: String): String {
        val value = try { UUID.fromString(raw).toString() }
            catch (_: Exception) { throw IllegalArgumentException("invalid_store_binding") }
        if (value != raw) throw IllegalArgumentException("invalid_store_binding")
        return value
    }

    private fun secretKey(storeId: String): SecretKey {
        val alias = keyAlias(storeId)
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getKey(alias, null) as? SecretKey)?.let { return it }
        val spec = KeyGenParameterSpec.Builder(alias,
            KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setKeySize(256)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setRandomizedEncryptionRequired(true)
            .build()
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
            .apply { init(spec) }.generateKey()
    }

    @Synchronized override fun save(storeBindingId: String, projectUrl: String, publishableKey: String) {
        val storeId = binding(storeBindingId)
        val record = file(storeId)
        val url = CloudConfigRules.projectUrl(projectUrl)
        val key = CloudConfigRules.publishableKey(publishableKey)
        val plain = JSONObject().put("v", 1).put("store", storeId)
            .put("url", url).put("key", key).toString().toByteArray(StandardCharsets.UTF_8)
        try {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply {
                init(Cipher.ENCRYPT_MODE, secretKey(storeId))
                updateAAD(storeId.toByteArray(StandardCharsets.UTF_8))
            }
            val iv = cipher.iv
            check(iv.size == 12) { "cloud_configuration_unavailable" }
            val encrypted = byteArrayOf(1) + iv + cipher.doFinal(plain)
            var output: FileOutputStream? = null
            try {
                val stream = record.startWrite()
                output = stream
                stream.write(encrypted)
                record.finishWrite(stream)
            } catch (_: Exception) {
                output?.let { record.failWrite(it) }
                throw IllegalStateException("cloud_configuration_unavailable")
            }
        } finally {
            plain.fill(0)
        }
    }

    @Synchronized override fun read(storeBindingId: String): CloudConfiguration? {
        val storeId = binding(storeBindingId)
        val record = file(storeId)
        if (!record.baseFile.exists()) return null
        try {
            if (record.baseFile.length() !in 30..8192) throw IllegalStateException("cloud_configuration_unreadable")
            val blob = record.openRead().use { it.readBytes() }
            if (blob.size < 30 || blob[0] != 1.toByte()) throw IllegalStateException("cloud_configuration_unreadable")
            val key = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
                .getKey(keyAlias(storeId), null) as? SecretKey
                ?: throw IllegalStateException("cloud_configuration_unreadable")
            val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply {
                init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, blob.copyOfRange(1, 13)))
                updateAAD(storeId.toByteArray(StandardCharsets.UTF_8))
            }
            val plain = cipher.doFinal(blob.copyOfRange(13, blob.size))
            try {
                val payload = JSONObject(String(plain, StandardCharsets.UTF_8))
                if (payload.optInt("v") != 1 || payload.optString("store") != storeId) {
                    throw IllegalStateException("cloud_configuration_unreadable")
                }
                return CloudConfiguration(
                    CloudConfigRules.projectUrl(payload.getString("url")),
                    CloudConfigRules.publishableKey(payload.getString("key")), storeId,
                )
            } finally {
                plain.fill(0)
            }
        } catch (_: Exception) {
            // Do not erase the record or fall back to plaintext: owner must reconfigure safely.
            throw IllegalStateException("cloud_configuration_unreadable")
        }
    }
}
