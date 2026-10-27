package net.arena.rafiq.whatsapp

import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

/**
 * عميل Cloud API الرسمي من Meta. التوكن يُرسل في ترويسة Authorization فقط،
 * ولا يُكتب في أي ملف أو سجل. أخطاء Meta تُعاد برسالتها.
 */
class WhatsAppClient(private val phoneNumberId: String, private val token: String) {

    private val base = "https://graph.facebook.com/v21.0"

    /** يرفع الـPDF ويُعيد معرّف الوسائط. */
    fun uploadPdf(pdf: ByteArray, fileName: String): String {
        val boundary = "----rafiq" + System.currentTimeMillis()
        val conn = open("$base/$phoneNumberId/media", "POST").apply {
            doOutput = true
            setRequestProperty("Content-Type", "multipart/form-data; boundary=$boundary")
        }
        conn.outputStream.use { out ->
            fun part(s: String) = out.write(s.toByteArray(Charsets.UTF_8))
            part("--$boundary\r\nContent-Disposition: form-data; name=\"messaging_product\"\r\n\r\nwhatsapp\r\n")
            part("--$boundary\r\nContent-Disposition: form-data; name=\"type\"\r\n\r\napplication/pdf\r\n")
            part("--$boundary\r\nContent-Disposition: form-data; name=\"file\"; filename=\"$fileName\"\r\nContent-Type: application/pdf\r\n\r\n")
            out.write(pdf)
            part("\r\n--$boundary--\r\n")
        }
        return JSONObject(read(conn)).getString("id")
    }

    /** يرسل رسالة القالب ويُعيد معرّف الرسالة. */
    fun sendTemplate(payload: JSONObject): String {
        val conn = open("$base/$phoneNumberId/messages", "POST").apply {
            doOutput = true
            setRequestProperty("Content-Type", "application/json; charset=utf-8")
        }
        conn.outputStream.use { it.write(payload.toString().toByteArray(Charsets.UTF_8)) }
        val messages = JSONObject(read(conn)).getJSONArray("messages")
        return messages.getJSONObject(0).getString("id")
    }

    private fun open(url: String, method: String): HttpURLConnection =
        (URL(url).openConnection() as HttpURLConnection).apply {
            requestMethod = method
            connectTimeout = 15_000
            readTimeout = 60_000
            setRequestProperty("Authorization", "Bearer $token")
        }

    private fun read(conn: HttpURLConnection): String {
        val code = conn.responseCode
        val stream = if (code in 200..299) conn.inputStream else conn.errorStream
        val body = stream?.bufferedReader()?.use { it.readText() }.orEmpty()
        if (code !in 200..299) {
            val msg = runCatching { JSONObject(body).getJSONObject("error").getString("message") }.getOrNull()
            throw IOException(msg ?: "رمز الخطأ $code")
        }
        return body
    }
}
