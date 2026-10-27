package net.arena.rafiq.domain

import java.io.ByteArrayInputStream
import java.util.zip.ZipInputStream
import javax.xml.parsers.DocumentBuilderFactory
import org.w3c.dom.Element
import org.w3c.dom.Node

/**
 * يقرأ الورقة الأولى من ملف XLSX بلا مكتبات خارجية (XLSX ملف zip فيه XML).
 * الصف الأول هو الترويسة كما في openpyxl في النسخة الأصلية، والصفوف الفارغة تُتجاهل.
 */
object XlsxReader {

    fun read(bytes: ByteArray): List<Row> {
        val entries = unzip(bytes)
        val shared = entries["xl/sharedStrings.xml"]?.let { sharedStrings(it) } ?: emptyList()
        val sheetName = if (entries.containsKey("xl/worksheets/sheet1.xml")) "xl/worksheets/sheet1.xml"
            else entries.keys.filter { it.startsWith("xl/worksheets/sheet") && it.endsWith(".xml") }.minOrNull()
            ?: throw IllegalArgumentException("لا توجد ورقة في الملف")
        val grid = sheetGrid(entries.getValue(sheetName), shared)
        if (grid.isEmpty()) return emptyList()
        val header = grid[1] ?: return emptyList()
        val width = header.keys.maxOrNull() ?: return emptyList()
        val names = (0..width).map { header[it] ?: "" }
        val maxRow = grid.keys.maxOrNull() ?: return emptyList()
        val out = ArrayList<Row>()
        for (r in 2..maxRow) {
            val cells = grid[r] ?: continue
            if (cells.values.all { it.isBlank() }) continue
            val row = LinkedHashMap<String, String?>()
            names.forEachIndexed { i, h -> row[h] = cells[i] }
            out.add(row)
        }
        return out
    }

    private fun unzip(bytes: ByteArray): Map<String, ByteArray> {
        val out = HashMap<String, ByteArray>()
        ZipInputStream(ByteArrayInputStream(bytes)).use { zin ->
            while (true) {
                val entry = zin.nextEntry ?: break
                if (!entry.isDirectory) out[entry.name] = zin.readBytes()
                zin.closeEntry()
            }
        }
        return out
    }

    private fun parseXml(data: ByteArray): org.w3c.dom.Document {
        val factory = DocumentBuilderFactory.newInstance()
        factory.isNamespaceAware = false
        try {
            factory.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true)
        } catch (e: Exception) {
            // بعض المحللات لا تدعم هذه الميزة؛ الملفات المصدَّرة من إكسل لا تحوي DTD أصلاً
        }
        return factory.newDocumentBuilder().parse(ByteArrayInputStream(data))
    }

    private fun sharedStrings(data: ByteArray): List<String> {
        val nodes = parseXml(data).getElementsByTagName("si")
        return (0 until nodes.length).map { textOf(nodes.item(it)) }
    }

    private fun textOf(node: Node): String {
        val ts = (node as Element).getElementsByTagName("t")
        return (0 until ts.length).joinToString("") { ts.item(it).textContent ?: "" }
    }

    /** رقم الصف → (رقم العمود من 0 → النص) */
    private fun sheetGrid(data: ByteArray, shared: List<String>): Map<Int, Map<Int, String>> {
        val cells = parseXml(data).getElementsByTagName("c")
        val grid = HashMap<Int, HashMap<Int, String>>()
        for (i in 0 until cells.length) {
            val c = cells.item(i) as Element
            val ref = c.getAttribute("r")
            if (ref.isEmpty()) continue
            val col = columnIndex(ref.takeWhile { it.isLetter() })
            val row = ref.dropWhile { it.isLetter() }.toIntOrNull() ?: continue
            grid.getOrPut(row) { HashMap() }[col] = cellText(c, shared)
        }
        return grid
    }

    private fun columnIndex(letters: String): Int =
        letters.uppercase().fold(0) { acc, ch -> acc * 26 + (ch - 'A' + 1) } - 1

    private fun cellText(c: Element, shared: List<String>): String = when (c.getAttribute("t")) {
        "s" -> shared.getOrNull(valueOf(c).trim().toIntOrNull() ?: -1) ?: ""
        "inlineStr" -> textOf(c)
        else -> valueOf(c).trim()
    }

    private fun valueOf(c: Element): String {
        val v = c.getElementsByTagName("v")
        return if (v.length > 0) v.item(0).textContent ?: "" else ""
    }
}
