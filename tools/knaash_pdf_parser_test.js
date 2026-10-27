// اختبار هندسة جدول كناش ببيانات اصطناعية فقط؛ PDF الزبائن الحقيقي لا يدخل المستودع أو CI.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vendor = path.resolve(__dirname, '../app/src/main/assets/knaash');
for (const [name, hash] of [
  ['pdf.min.js', '44ec6f011027ee77791386b66c14876a5fc29e20bf0433c07c6726fff7212b72'],
  ['pdf.worker.min.js', 'bd88805178a26c729db8c0107a5b630cb900ec070f4d8c7529a3e45530afd41d'],
]) {
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(vendor, name))).digest('hex'), hash,
    `review any change to the pinned local PDF.js asset ${name}`);
}
const inspect = require('../app/src/main/assets/knaash/reader.js').inspect;
const bytes = new TextEncoder().encode('%PDF-test-document');
const money = cents => `${Math.floor(cents / 100)},${String(cents % 100).padStart(2, '0')}`;
const item = (s, x, y) => ({str: s, transform: [1, 0, 0, 1, x, y]});

function fixture(change = () => {}) {
  // التقرير الاصطناعي: 80 ديناً، 120 لصالح عميل، صفر. أعطيت 100، أخذت 140، الصافي -40.
  const list = [
    item('14/10/2026', 275, 920),
    item('140,00', 430, 900), item('3', 530, 900),
    item('100,00', 430, 880), item('40,00', 430, 860),
    item('1', 572, 800), item('ﻋﻤﻴﻞ', 510, 801.5), item(' ', 505, 801.5), item('ﺃﻭﻝ', 485, 801.5),
    item('+967000000000', 325, 800), item('100,00', 220, 800), item('20,00', 130, 800), item('80,00', 40, 800),
    item('2', 572, 760), item('ﻋﻤﻴﻞ', 510, 760), item('ﺛﺎﻥ', 485, 760),
    item('-', 250, 760), item('120,00', 130, 760), item('120,00', 40, 760),
    item('3', 572, 720), item('ﻋﻤﻴﻞ', 510, 720), item('ﺻﻔﺮ', 485, 720),
    item('-', 250, 720), item('-', 165, 720), item('0,00', 40, 720),
    item('100,00', 260, 600), item('140,00', 140, 600), item('40,00', 30, 600),
  ];
  change(list);
  const document = {numPages: 1, getPage: async () => ({
    getViewport: () => ({width: 595}),
    getTextContent: async () => ({items: list}), cleanup: () => {},
  }), destroy: async () => {}};
  const pdfjs = {getDocument: options => {
    assert.equal(options.isEvalSupported, false);
    assert.equal(options.enableScripting, false);
    return {promise: Promise.resolve(document)};
  }};
  return pdfjs;
}

(async () => {
  const report = await inspect(bytes, fixture());
  assert.deepEqual(report.counts, {debt: 1, credit: 1, zero: 1});
  assert.equal(report.sourceCount, 3);
  assert.equal(report.reportDateIso, '2026-10-14');
  assert.deepEqual(report.totals, {
    givenCents: 10000, takenCents: 14000, netCents: -4000,
    grossDebtCents: 8000, grossCreditCents: 12000,
  });
  assert.deepEqual(report.rows.map(x => x.balanceCents), [8000, -12000, 0]);
  assert.equal(report.rows[0].phone, '+967000000000');
  assert.ok(report.rows[0].sourceName.includes('عميل'), 'Presentation Forms must normalize to Arabic letters');
  const tamper = async (from, to) => {
    await assert.rejects(inspect(bytes, fixture(items => {
      const target = items.find(x => x.str === from && x.transform[4] === to.x && x.transform[5] === to.y);
      assert.ok(target, 'synthetic fixture target must exist');
      target.str = to.value;
    })), /./);
  };
  await tamper('120,00', {x: 40, y: 760, value: '119,00'}); // صف دائن غير متطابق
  await tamper('3', {x: 572, y: 720, value: '4'});          // ترقيم مفقود
  await tamper('40,00', {x: 30, y: 600, value: '41,00'});   // إجمالي نهاية الصفحة
  await tamper('3', {x: 530, y: 900, value: '2'});          // عدد العملاء المطبوع
  await assert.rejects(inspect(new Uint8Array([1, 2, 3]), fixture()), /PDF/);
  await assert.rejects(inspect(bytes, fixture(items => { items.splice(0, items.length); })), /PDF|تقرير/);
  assert.equal(money(report.totals.grossCreditCents), '120,00');
  console.log('Knaash PDF: signed/zero/credit, positions, totals, duplicate/missing, integrity (synthetic only) PASS');
})().catch(e => { console.error(e); process.exitCode = 1; });
