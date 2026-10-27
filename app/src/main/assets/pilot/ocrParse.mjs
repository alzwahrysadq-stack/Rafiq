// Rafiq OCR line parser (plan item 7 — OCR with MANDATORY human review).
// Converts raw OCR text lines (e.g. from a photographed paper price list or a supplier
// invoice) into PROPOSED product rows. Nothing here ever saves by itself: every row is
// a draft the owner must review/edit row-by-row before any product is created, and a
// barcode that already exists must be flagged, never silently merged (owner's rule).
export function normalizeDigits(s) {
  return String(s ?? "")
    .replace(/[٠-٩]/g, (d) => "٠١٢٣٤٥٦٧٨٩".indexOf(d))
    .replace(/[۰-۹]/g, (d) => "۰۱۲۳۴۵۶۷۸۹".indexOf(d))
    .replace(/٫/g, ".")
    .replace(/،/g, ",");
}

const UNIT_RE = /^(كجم|كيلو|جرام|غرام|غ|جم|لتر|مل|ملل|حبة|حبه|كرتون|عبوة|علبه|علبة|كيس|اكياس|أكياس|قطع|قطعة|سم|متر|دستة|اكياس)$/;
const GLUED_UNIT_RE = /^\d+(?:\.\d+)?\s*(g|gm|ml|kg|l)$/i;
const KEYWORD_RE = /^(سعر|البيع|الشراء|شراء|بيع|جملة|قطاعي|ريال|كمية|العدد|عدد|باركود|الصنف|اسم|ر\.ي)$/;
const isNumTok = (t) => /^\d{1,3}(?:,\d{3})+(?:\.\d+)?$|^\d+(?:\.\d+)?$/.test(t);
const numVal = (t) => Number(t.replace(/,/g, ""));

// One OCR text line -> proposed row {name, barcode, buy, sell, qty, flags[], raw}
export function parseOcrLine(rawLine) {
  const flags = [];
  let line = normalizeDigits(rawLine).replace(/\s+/g, " ").trim();
  const raw = line;
  if (!line) return null;

  // Barcode: a 9-14 digit run (EAN-13/UPC/local codes).
  let barcode = "";
  const bm = line.match(/\b\d{9,14}\b/);
  if (bm) { barcode = bm[0]; line = line.replace(bm[0], " "); }

  // Quantity hints: "عدد 5" / "كمية: 5" / "×5" / "x5"
  let qty = null;
  const qm = line.match(/(?:عدد|كمية|×|x|X)\s*[:：]?\s*(\d+(?:\.\d+)?)/);
  if (qm) { qty = Number(qm[1]); line = line.replace(qm[0], " "); }

  // Token pass: a number glued to a unit word (5 كجم / 250 جرام / 100g / 180ml) belongs
  // to the product NAME; bare numbers elsewhere are price candidates in reading order.
  const nameToks = [];
  const nums = [];
  const toks = line.split(" ").filter(Boolean);
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (KEYWORD_RE.test(t)) continue;
    if (GLUED_UNIT_RE.test(t.replace(/\s/g, ""))) { nameToks.push(t); continue; }
    if (isNumTok(t)) {
      if (i + 1 < toks.length && UNIT_RE.test(toks[i + 1])) { nameToks.push(t, toks[i + 1]); i++; continue; }
      nums.push(numVal(t)); continue;
    }
    nameToks.push(t);
  }
  let name = nameToks.join(" ").replace(/[|:؛•·\-–—_/\\]+/g, " ").replace(/\s+/g, " ").trim();
  if (!name) flags.push("الاسم مفقود — راجع السطر");
  if (name.length > 80) { name = name.slice(0, 80); flags.push("اسم طويل قُصّ — تحقق"); }

  // Prices conventionally close the line (شراء ثم بيع): take the last two bare numbers.
  let buy = 0, sell = 0;
  if (nums.length === 0) flags.push("لا سعر ظاهر — أدخل السعر يدويًا");
  else if (nums.length === 1) { sell = nums[0]; flags.push("سعر واحد فقط — اعتبرناه بيعًا، راجع الشراء"); }
  else {
    buy = nums[nums.length - 2]; sell = nums[nums.length - 1];
    if (nums.length > 2) flags.push("أرقام زائدة بالسطر — أخذنا الأخيرين (شراء/بيع)، راجع");
    if (buy > sell) flags.push("الشراء أكبر من البيع ظاهريًا — تأكد من الترتيب");
  }
  if (qty === null) { qty = 0; flags.push("الكمية غير ظاهرة — صفر بانتظار إدخالك"); }

  return { name, barcode, buy, sell, qty, flags, raw };
}

export function parseOcrText(text) {
  return String(text ?? "").split(/\r?\n/).map(parseOcrLine).filter(Boolean);
}
