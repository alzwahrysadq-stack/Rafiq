package net.arena.rafiq.whatsapp

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class WhatsAppRulesTest {

    @Test
    fun sendsOnlyForCreditInvoiceWithRemainingDebt() {
        assertTrue(WhatsAppRules.needsSend("credit", 500L))
        assertFalse(WhatsAppRules.needsSend("credit", 0L))
        assertFalse(WhatsAppRules.needsSend("cash", 500L))
        assertFalse(WhatsAppRules.needsSend("cash", 0L))
    }

    @Test
    fun normalizesYemeniNumbers() {
        assertEquals("967711169221", WhatsAppRules.normalizePhone("711169221", "967"))
        assertEquals("967711169221", WhatsAppRules.normalizePhone("0711169221", "967"))
        assertEquals("967711169221", WhatsAppRules.normalizePhone("+967 711 169 221", "967"))
        assertEquals("967711169221", WhatsAppRules.normalizePhone("00967711169221", "967"))
        assertNull(WhatsAppRules.normalizePhone("12", "967"))
        assertNull(WhatsAppRules.normalizePhone("", "967"))
    }

    @Test
    fun templatePayloadCarriesDocumentHeaderAndTwoBodyValues() {
        val p = WhatsAppRules.templatePayload(
            to = "967711169221", template = "invoice_pdf", languageCode = "ar",
            mediaId = "M123", fileName = "invoice-7.pdf", totalText = "12,000 ريال", debtText = "8,000 ريال",
        )
        assertEquals("whatsapp", p.getString("messaging_product"))
        assertEquals("template", p.getString("type"))
        val t = p.getJSONObject("template")
        assertEquals("invoice_pdf", t.getString("name"))
        assertEquals("ar", t.getJSONObject("language").getString("code"))
        val header = t.getJSONArray("components").getJSONObject(0)
        assertEquals("header", header.getString("type"))
        val doc = header.getJSONArray("parameters").getJSONObject(0).getJSONObject("document")
        assertEquals("M123", doc.getString("id"))
        assertEquals("invoice-7.pdf", doc.getString("filename"))
        val body = t.getJSONArray("components").getJSONObject(1).getJSONArray("parameters")
        assertEquals("12,000 ريال", body.getJSONObject(0).getString("text"))
        assertEquals("8,000 ريال", body.getJSONObject(1).getString("text"))
    }
}
