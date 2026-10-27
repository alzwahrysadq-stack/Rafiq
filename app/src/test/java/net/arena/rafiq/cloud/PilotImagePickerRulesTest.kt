package net.arena.rafiq.cloud

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** منتقي الصور (129): الصفحة الموثوقة وحدها تفتحه، ولا يُقبل إلا ملف صورة مفرد محدود الحجم. */
class PilotImagePickerRulesTest {
    @Test fun onlyUnifiedPilotPageMayOpenThePicker() {
        assertTrue(PilotImagePickerRules.trustedPage(
            "https://appassets.androidplatform.net/assets/pilot/index.html"))
        assertFalse(PilotImagePickerRules.trustedPage(null))
        assertFalse(PilotImagePickerRules.trustedPage(""))
        assertFalse(PilotImagePickerRules.trustedPage(
            "https://appassets.androidplatform.net/assets/pilot/index.html?next=evil"))
        assertFalse(PilotImagePickerRules.trustedPage(
            "https://appassets.androidplatform.net/assets/pilot/other.html"))
        assertFalse(PilotImagePickerRules.trustedPage(
            "https://user@appassets.androidplatform.net/assets/pilot/index.html"))
        assertFalse(PilotImagePickerRules.trustedPage(
            "https://appassets.androidplatform.net:443/assets/pilot/index.html"))
        assertFalse(PilotImagePickerRules.trustedPage("https://example.com/assets/pilot/index.html"))
    }

    @Test fun acceptsSingleContentRasterImagesWithinSizeLimit() {
        assertTrue(PilotImagePickerRules.accepts(
            "content://media/external/images/media/42", "image/jpeg", 5_000))
        assertTrue(PilotImagePickerRules.accepts(
            "content://com.android.providers.media.documents/document/1", "image/png",
            PilotImagePickerRules.MAX_BYTES))
        assertFalse(PilotImagePickerRules.accepts(
            "file:///sdcard/photo.jpg", "image/jpeg", 5_000))
        assertFalse(PilotImagePickerRules.accepts(
            "content://media/external/file/9", "application/pdf", 5_000))
        assertFalse(PilotImagePickerRules.accepts(
            "content://media/external/file/9", "image/svg+xml", 5_000))
        assertFalse(PilotImagePickerRules.accepts(
            "content://media/external/file/9", "image/jpeg", 0))
        assertFalse(PilotImagePickerRules.accepts(
            "content://media/external/file/9", "image/jpeg", PilotImagePickerRules.MAX_BYTES + 1))
        assertFalse(PilotImagePickerRules.accepts(
            "content://user@app/evil/1", "image/jpeg", 5_000))
        assertFalse(PilotImagePickerRules.accepts(null, null, -2))
    }
}
