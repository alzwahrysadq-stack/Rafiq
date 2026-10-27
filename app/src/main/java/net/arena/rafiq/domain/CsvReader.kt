package net.arena.rafiq.domain

/**
 * يقرأ نص CSV ويعيد صفوفاً (ترويسة → قيمة)، مطابقاً لسلوك csv.DictReader في النسخة الأصلية:
 * يكتشف الفاصل (؛ أو ، أو مسافة جدولية)، ويتجاهل الصفوف الفارغة، ويدعم الاقتباس والسطور داخل الخلايا.
 */
object CsvReader {

    /** يفكّ ترميز ملف CSV: UTF-8 أولاً، وإن فشل فـ Windows-1256 (ملفات إكسل العربية القديمة). */
    fun decode(bytes: ByteArray): String =
        try {
            Charsets.UTF_8.newDecoder().decode(java.nio.ByteBuffer.wrap(bytes)).toString()
        } catch (e: java.nio.charset.CharacterCodingException) {
            String(bytes, java.nio.charset.Charset.forName("windows-1256"))
        }

    fun parse(text: String): List<Row> {
        val src = text.removePrefix("\uFEFF")
        val sample = src.take(4000)
        val commas = sample.count { it == ',' }
        val delim = when {
            sample.count { it == ';' } > commas -> ';'
            sample.count { it == '\t' } > commas -> '\t'
            else -> ','
        }
        val records = splitRecords(src, delim)
        if (records.isEmpty()) return emptyList()
        val header = records[0]
        val out = ArrayList<Row>()
        for (r in records.drop(1)) {
            if (r.all { it.isBlank() }) continue
            val row = LinkedHashMap<String, String?>()
            header.forEachIndexed { i, h -> row[h] = r.getOrNull(i) }
            out.add(row)
        }
        return out
    }

    private fun splitRecords(src: String, delim: Char): List<List<String>> {
        val records = ArrayList<List<String>>()
        var row = ArrayList<String>()
        val field = StringBuilder()
        var inQuotes = false
        var i = 0
        while (i < src.length) {
            val c = src[i]
            if (inQuotes) {
                if (c == '"') {
                    if (i + 1 < src.length && src[i + 1] == '"') {
                        field.append('"')
                        i++
                    } else {
                        inQuotes = false
                    }
                } else {
                    field.append(c)
                }
            } else if (c == '"') {
                inQuotes = true
            } else if (c == delim) {
                row.add(field.toString())
                field.setLength(0)
            } else if (c == '\n') {
                row.add(field.toString())
                field.setLength(0)
                records.add(row)
                row = ArrayList()
            } else if (c != '\r') {
                field.append(c)
            }
            i++
        }
        if (field.isNotEmpty() || row.isNotEmpty()) {
            row.add(field.toString())
            records.add(row)
        }
        return records
    }
}
