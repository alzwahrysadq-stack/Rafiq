package net.arena.rafiq.whatsapp

import android.graphics.Paint
import android.text.TextPaint
import android.graphics.pdf.PdfDocument
import android.text.TextUtils
import java.io.ByteArrayOutputStream

/**
 * فاتورة PDF بصيغة A4 تُولَّد على الجهاز (بلا شبكة) للمشاركة اليدوية أو الرسالة المصرّح بها.
 * الحقول نفسها التي تظهر في الفاتورة المطبوعة.
 */
object InvoicePdf {

    data class Line(val name: String, val qty: String, val price: String, val total: String)

    data class Doc(
        val store: String,
        val number: Long,
        val date: String,
        val customer: String,
        val lines: List<Line>,
        val total: String,
        val paid: String,
        val due: String,
        val debtTotal: String,
        val footer: String,
    )

    private const val W = 595
    private const val H = 842
    private const val RIGHT = 555f
    private const val LEFT = 40f
    private const val BOTTOM = 790f

    fun render(doc: Doc): ByteArray {
        val pdf = PdfDocument()
        val title = Paint().apply { isAntiAlias = true; textSize = 18f; isFakeBoldText = true; textAlign = Paint.Align.RIGHT }
        val text = TextPaint().apply { isAntiAlias = true; textSize = 11f; textAlign = Paint.Align.RIGHT }
        val bold = TextPaint(text).apply { isFakeBoldText = true }
        val left = TextPaint(text).apply { textAlign = Paint.Align.LEFT }
        val line = Paint().apply { strokeWidth = 0.8f }

        var pageNo = 1
        var page = pdf.startPage(PdfDocument.PageInfo.Builder(W, H, pageNo).create())
        var c = page.canvas
        var y = 60f

        fun newPageIfNeeded(need: Float) {
            if (y + need > BOTTOM) {
                pdf.finishPage(page)
                pageNo++
                page = pdf.startPage(PdfDocument.PageInfo.Builder(W, H, pageNo).create())
                c = page.canvas
                y = 60f
            }
        }

        c.drawText(doc.store, RIGHT, y, title); y += 26f
        c.drawText("فاتورة رقم ${doc.number}", RIGHT, y, bold); c.drawText("التاريخ: ${doc.date}", LEFT + 200f, y, left); y += 16f
        c.drawText("الزبون: ${doc.customer}", RIGHT, y, text); y += 14f
        c.drawLine(LEFT, y, RIGHT, y, line); y += 18f

        // أربعة أعمدة من اليمين إلى اليسار؛ الاسم لا يطغى على السعر أو الإجمالي.
        c.drawText("الصنف", RIGHT, y, bold)
        c.drawText("الكمية", 315f, y, bold)
        c.drawText("السعر", 230f, y, bold)
        c.drawText("المجموع", 130f, y, bold)
        y += 8f
        c.drawLine(LEFT, y, RIGHT, y, line); y += 16f

        // لا نقطع الأعداد المالية بعلامة الحذف: صغّر حجم الخط عند الحاجة وأبقِ القيمة كاملة.
        fun drawNumber(value: String, right: Float, width: Float) {
            val fitted = TextPaint(text)
            val measured = fitted.measureText(value)
            if (measured > width) fitted.textSize *= width / measured
            c.drawText(value, right, y, fitted)
        }
        for (l in doc.lines) {
            newPageIfNeeded(18f)
            c = page.canvas
            val name = TextUtils.ellipsize(l.name, text, 220f, TextUtils.TruncateAt.END).toString()
            c.drawText(name, RIGHT, y, text)
            drawNumber(l.qty, 315f, 55f)
            drawNumber(l.price, 230f, 85f)
            drawNumber(l.total, 130f, 90f)
            y += 18f
        }

        newPageIfNeeded(120f)
        c = page.canvas
        y += 6f
        c.drawLine(LEFT, y, RIGHT, y, line); y += 20f
        c.drawText("الإجمالي: ${doc.total}", RIGHT, y, bold); y += 18f
        c.drawText("المدفوع: ${doc.paid}", RIGHT, y, text); y += 18f
        c.drawText("الباقي ديناً على هذه الفاتورة: ${doc.due}", RIGHT, y, bold); y += 18f
        c.drawText("إجمالي دين الزبون حتى اليوم: ${doc.debtTotal}", RIGHT, y, bold); y += 30f
        c.drawText(doc.footer, RIGHT, y, text)

        pdf.finishPage(page)
        return ByteArrayOutputStream().use { out ->
            pdf.writeTo(out)
            pdf.close()
            out.toByteArray()
        }
    }
}
