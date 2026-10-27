/*
 * «الوضع حسب العميل» من كناش: استخراج نصي محلي للمعاينة فقط.
 * لا إرسال شبكة، لا OCR، لا تطابق اسم تلقائي ولا كتابة إلى قاعدة رفيق.
 */
(function (root, create) {
  if (typeof module === 'object' && module.exports) module.exports = create();
  else root.KnaashPdf = create();
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';
  const MAX_CENTS = 100000000000000;
  const MONEY = /^(?:\d+(?:\.\d{3})*,\d{2}|-)$/;
  const PRINTED = /^\d+(?:\.\d{3})*,\d{2}$/;
  const ARABIC = /[\u0600-\u06ff\u0750-\u077f\ufb50-\ufdff\ufe70-\ufeff]/;
  const clean = s => String(s == null ? '' : s)
    .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '').trim();
  const fail = msg => { throw new Error(msg); };
  const x = item => item.transform[4];
  const y = item => item.transform[5];

  function amount(raw, allowBlank) {
    const value = clean(raw);
    if (allowBlank && value === '-') return 0;
    if (!PRINTED.test(value)) fail('تعذّر قراءة مبلغ من التقرير؛ لم تُقبل معاينة ناقصة.');
    const fields = value.replace(/\./g, '').split(',');
    const result = Number(fields[0]) * 100 + Number(fields[1]);
    if (!Number.isSafeInteger(result) || result > MAX_CENTS) fail('مبلغ خارج الحد الحسابي الآمن.');
    return result;
  }
  function plus(a, b) {
    const value = a + b;
    if (!Number.isSafeInteger(value) || Math.abs(value) > MAX_CENTS) fail('إجمالي أرصدة خارج الحد الآمن.');
    return value;
  }
  function date(raw) {
    const m = /(?:^|\D)(\d{2})\/(\d{2})\/(\d{4})(?:\D|$)/.exec(clean(raw));
    if (!m) return null;
    const day = +m[1], month = +m[2], year = +m[3];
    const actual = new Date(Date.UTC(year, month - 1, day));
    return actual.getUTCDate() === day && actual.getUTCMonth() === month - 1 &&
      actual.getUTCFullYear() === year ? `${m[3]}-${m[2]}-${m[1]}` : null;
  }
  function group(items) {
    const lines = [];
    for (const item of items) {
      if (!item.str || (!clean(item.str) && !/^\s+$/.test(item.str)) ||
          !item.transform || !Number.isFinite(x(item)) || !Number.isFinite(y(item))) continue;
      let line = lines.find(candidate => Math.abs(candidate.y - y(item)) < 4);
      if (!line) { line = {y: y(item), items: []}; lines.push(line); }
      line.items.push(item);
    }
    return lines.sort((a, b) => b.y - a.y);
  }
  function moneyItems(line) {
    return line.items.filter(item => MONEY.test(clean(item.str))).sort((a, b) => x(b) - x(a));
  }
  // PDF.js يعيد بعض الحروف العربية كأشكال عرض منفردة في ترتيبها المرئي (RTL).
  function nameFrom(line, givenX, idX, index) {
    const name = line.items.filter(item => x(item) > givenX + 40 && x(item) < idX - 5 &&
      (ARABIC.test(item.str) || /^\s+$/.test(item.str)))
      .sort((a, b) => x(b) - x(a)).map(item => item.str).join('')
      .normalize('NFKC').replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
      .replace(/\s+/g, ' ').trim();
    if (!name || name.length > 150 || !ARABIC.test(name)) fail('اسم الصف ' + index + ' غير مقروء.');
    return name;
  }

  async function inspect(bytes, pdfjs) {
    if (!(bytes instanceof Uint8Array) || bytes.length < 5 || bytes.length > 10 * 1024 * 1024 ||
        String.fromCharCode(...bytes.slice(0, 5)) !== '%PDF-') fail('اختر PDF محلياً لا يزيد على 10 ميغابايت.');
    if (!pdfjs || typeof pdfjs.getDocument !== 'function') fail('قارئ PDF المحلي غير متاح.');
    const task = pdfjs.getDocument({
      data: bytes, isEvalSupported: false, enableScripting: false,
      useSystemFonts: false, disableFontFace: true, stopAtErrors: true,
    });
    let pdf;
    try {
      pdf = await task.promise;
      if (pdf.numPages < 1 || pdf.numPages > 100) fail('عدد صفحات PDF غير صالح لهذا التقرير.');
      const rows = [], pages = [];
      for (let n = 1; n <= pdf.numPages; n++) {
        const page = await pdf.getPage(n);
        try {
          const width = page.getViewport({scale: 1}).width;
          const lines = group((await page.getTextContent()).items);
          const numbered = [];
          for (const line of lines) {
            const ids = line.items.filter(item => x(item) > width * 0.93 && /^\d{1,4}$/.test(clean(item.str)));
            if (!ids.length) continue;
            if (ids.length !== 1) fail('أرقام صفوف PDF ملتبسة.');
            const index = Number(clean(ids[0].str));
            const cells = moneyItems(line);
            if (cells.length !== 3) fail('أعمدة الصف ' + index + ' ناقصة أو مكررة.');
            const given = amount(cells[0].str, true);
            const taken = amount(cells[1].str, true);
            const printed = amount(cells[2].str, false);
            const signed = given - taken;
            if (!Number.isSafeInteger(signed) || Math.abs(signed) !== printed) {
              fail('رصيد الصف ' + index + ' لا يساوي أعطيت − أخذت.');
            }
            const sourceName = nameFrom(line, x(cells[0]), x(ids[0]), index);
            const phones = line.items.filter(item => x(item) > x(cells[0]) + 20 &&
              x(item) < x(ids[0]) - 5 && /^\+?\d{9,15}$/.test(clean(item.str)))
              .map(item => clean(item.str));
            if (phones.length > 1) fail('رقم هاتف ملتبس في الصف ' + index + '.');
            rows.push({index, page: n, line: numbered.length + 1, sourceName,
              phone: phones[0] || '', givenCents: given, takenCents: taken,
              printedBalanceCents: printed, balanceCents: signed,
              kind: signed > 0 ? 'debt' : signed < 0 ? 'credit' : 'zero'});
            numbered.push(line);
            if (rows.length > 10000) fail('عدد صفوف PDF أكبر من الحد الآمن.');
          }
          pages.push({lines, numbered});
        } finally { if (page.cleanup) page.cleanup(); }
      }
      if (!rows.length || !pages[0].numbered.length || !pages[pages.length - 1].numbered.length) {
        fail('هذا PDF لا يحتوي كشف أرصدة نصياً كاملاً؛ لا تخمين أو OCR تلقائي.');
      }
      if (rows.some((r, i) => r.index !== i + 1)) fail('ترقيم عملاء PDF غير متصل أو مكرر.');
      const first = pages[0], last = pages[pages.length - 1];
      const above = first.lines.filter(line => line.y > first.numbered[0].y + 2);
      const header = above.flatMap(line => moneyItems(line).map(item => ({item, line})))
        .sort((a, b) => b.line.y - a.line.y);
      if (header.length !== 3) fail('مجاميع عنوان كناش ناقصة أو تغير ترتيبها.');
      // تخطيط التقرير الحالي: أخذت/عدد العملاء، أعطيت، ثم مقدار صافي الرصيد.
      const printedCounts = header[0].line.items.filter(item => /^\d{1,4}$/.test(clean(item.str)) &&
        x(item) > x(header[0].item));
      if (printedCounts.length !== 1) fail('عدد العملاء المطبوع غير مقروء.');
      const count = Number(clean(printedCounts[0].str));
      const headerGiven = amount(header[1].item.str, false);
      const headerTaken = amount(header[0].item.str, false);
      const headerNetAbs = amount(header[2].item.str, false);
      const dates = [...new Set(above.flatMap(line => line.items.map(item => date(item.str)).filter(Boolean)))];
      if (dates.length !== 1) fail('تاريخ التقرير غير مقروء أو متعارض.');
      const below = last.lines.filter(line => line.y < last.numbered[last.numbered.length - 1].y - 1);
      const footer = below.flatMap(moneyItems).sort((a, b) => x(b) - x(a));
      if (footer.length !== 3) fail('مجاميع ختام PDF ناقصة أو مكررة.');
      const given = rows.reduce((s, r) => plus(s, r.givenCents), 0);
      const taken = rows.reduce((s, r) => plus(s, r.takenCents), 0);
      const net = rows.reduce((s, r) => plus(s, r.balanceCents), 0);
      if (count !== rows.length || given !== headerGiven || given !== amount(footer[0].str, false) ||
          taken !== headerTaken || taken !== amount(footer[1].str, false) ||
          Math.abs(net) !== headerNetAbs || Math.abs(net) !== amount(footer[2].str, false) ||
          net !== given - taken) fail('صفوف PDF لا تطابق عدد العملاء ومجاميع العنوان والخاتمة.');
      const debt = rows.filter(r => r.kind === 'debt');
      const credit = rows.filter(r => r.kind === 'credit');
      const zero = rows.filter(r => r.kind === 'zero');
      const grossDebt = debt.reduce((s, r) => plus(s, r.balanceCents), 0);
      const grossCredit = credit.reduce((s, r) => plus(s, -r.balanceCents), 0);
      if (grossDebt - grossCredit !== net || debt.length + credit.length + zero.length !== rows.length) {
        fail('الأرصدة الموقّعة غير متطابقة.');
      }
      return {pageCount: pdf.numPages, sourceCount: count, reportDateIso: dates[0],
        totals: {givenCents: given, takenCents: taken, netCents: net,
          grossDebtCents: grossDebt, grossCreditCents: grossCredit},
        counts: {debt: debt.length, credit: credit.length, zero: zero.length}, rows};
    } finally {
      if (pdf && pdf.destroy) await pdf.destroy();
      else if (task.destroy) await task.destroy();
    }
  }
  return {inspect, amount};
});
