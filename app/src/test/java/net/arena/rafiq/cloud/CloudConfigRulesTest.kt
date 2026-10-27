package net.arena.rafiq.cloud

import android.util.Base64
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import java.nio.charset.StandardCharsets

@RunWith(RobolectricTestRunner::class)
class CloudConfigRulesTest {
    private fun rejected(block: () -> Unit) {
        try { block(); throw AssertionError("unsafe cloud configuration accepted") }
        catch (e: IllegalArgumentException) { assertTrue(e.message.orEmpty().startsWith("invalid_")) }
    }

    @Test fun onlyProjectSpecificHttpsUrlWithoutCredentialsOrPaths() {
        assertEquals("https://abcdefghijklmnopqrst.supabase.co",
            CloudConfigRules.projectUrl("  https://abcdefghijklmnopqrst.supabase.co/  "))
        for (invalid in listOf("https://example.com", "https://project.supabase.example",  "http://abcdefghijklmnopqrst.supabase.co",
            "https://abcdefghijklmnopqrst.supabase.co.evil.test", "https://user:pass@abcdefghijklmnopqrst.supabase.co",
            "https://abcdefghijklmnopqrst.supabase.co:443", "https://abcdefghijklmnopqrst.supabase.co/functions/v1",
            "https://abcdefghijklmnopqrst.supabase.co?token=x", "https://abcdefghijklmnopqrst.supabase.co/#x",
            "javascript:alert(1)")) {
            rejected { CloudConfigRules.projectUrl(invalid) }
        }
    }

    @Test fun acceptsOnlyPublishableOrAnonJwtAndNeverAServiceRoleKey() {
        val publishable = "sb_publishable_" + "A".repeat(32)
        assertEquals(publishable, CloudConfigRules.publishableKey(publishable))
        rejected { CloudConfigRules.publishableKey("sb_secret_" + "A".repeat(32)) }
        rejected { CloudConfigRules.publishableKey("service_role") }
        rejected { CloudConfigRules.publishableKey("sb_publishable_x\nInjected") }
        val anon = jwt("anon", System.currentTimeMillis() / 1000 + 3600)
        assertEquals(anon, CloudConfigRules.publishableKey(anon))
        rejected { CloudConfigRules.publishableKey(jwt("service_role", System.currentTimeMillis() / 1000 + 3600)) }
        rejected { CloudConfigRules.publishableKey(jwt("anon", 1)) }
    }

    private fun jwt(role: String, expires: Long): String {
        fun part(value: String) = Base64.encodeToString(value.toByteArray(StandardCharsets.UTF_8),
            Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)
        return part("{\"alg\":\"HS256\"}") + "." +
            part("{\"role\":\"$role\",\"exp\":$expires}") + "." + part("synthetic-test-signature")
    }
}
