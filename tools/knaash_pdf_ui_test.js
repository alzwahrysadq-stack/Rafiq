// jsdom يفحص شاشة المعاينة المحلية وعرض الرصيد الدائن ببيانات وهمية فقط.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {JSDOM, ResourceLoader} = require('jsdom');
const web = path.resolve(__dirname, '../app/src/main/assets/web');
const assetsRoot = path.resolve(__dirname, '../app/src/main/assets');
class Assets extends ResourceLoader {
  fetch(url) {
    const key = '/assets/';
    if (!url.includes(key)) return null;
    const relative = url.split(key)[1];
    if (!relative || relative.includes('..')) return null;
    const file = path.join(assetsRoot, relative);
    return fs.existsSync(file) ? Promise.resolve(fs.readFileSync(file)) : null;
  }
}
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
function open(route, role = 'owner') {
  const url = 'https://appassets.androidplatform.net/assets/web/index.html?p=' + encodeURIComponent(route);
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url, runScripts: 'dangerously', resources: new Assets(), pretendToBeVisual: true,
  });
  const w = dom.window;
  w.scrollTo = () => {};
  w.Response = Response;
  w.RafiqDevice = {version: () => 'test', scan: () => {}};
  const c = {id: 1, name: 'عميل اصطناعي', code: '#00001', phone: '', balance_cents: -5000};
  const detail = {ts: '0001-01-01 00:00:00', kind: 'credit_opening', amount: 5000,
    note: 'رصيد افتتاحي لصالح الزبون (ليس دفعة نقدية)', balance_after: -5000, user: null};
  const ctx = {S: {currency: 'وحدة تجريبية', store_name: 'متجر اختبار'},
    u: {id: 1, name: 'مالك تجريبي', role}};
  const pages = {
    '/imports': {template: 'imports.html', endpoint: 'imports',
      ctx: {...ctx, logs: []}},
    '/customers/1': {template: 'customer_detail.html', endpoint: 'customer_detail',
      ctx: {...ctx, c, ev: [detail], invoices: [], audit_ok: true}},
    '/customers/1/print': {template: 'statement_print.html', endpoint: 'statement_print',
      ctx: {...ctx, c: {...c, balance_fmt: '-50'},
        ev: [{ts: detail.ts, kind: detail.kind, note: detail.note, amount_fmt: '50', balance_fmt: '-50'}],
        audit_ok: true, today: '2026-10-14'}},
  };
  w.RafiqNative = {page(method, p) {
    const record = pages[p];
    assert.ok(record, `unexpected route ${p}`);
    return JSON.stringify({...record, status: 200, path: p, flashes: []});
  }, api: () => JSON.stringify({status: 200, body: '{"ok":true}'})};
  for (const file of ['vendor/nunjucks.min.js', 'routes.js', 'templates.js', 'engine.js']) {
    w.eval(fs.readFileSync(path.join(web, file), 'utf8'));
  }
  return dom;
}
(async () => {
  let owner = open('/imports');
  for (let i = 0; i < 20 && !owner.window.KnaashPdf; i++) await wait(30);
  assert.equal(typeof owner.window.KnaashPdf?.inspect, 'function');
  assert.ok(owner.window.document.querySelector('#knaashPdf'));
  assert.equal(owner.window.document.querySelector('#knaashPreview').style.display, 'none');
  assert.equal(owner.window.document.querySelector('form[action*="debts"]'), null,
    'the old debt CSV route must not be exposed');
  owner.window.close();
  const worker = open('/imports', 'worker');
  await wait(60);
  assert.equal(worker.window.document.querySelector('#knaashPdf'), null,
    'worker cannot access the private PDF preview');
  worker.window.close();
  const statement = open('/customers/1');
  await wait(60);
  const content = statement.window.document.body.textContent;
  assert.ok(content.includes('افتتاحي لصالحه'));
  assert.ok(content.includes('قبل بدء النظام'),
    'the converted template must not call Python str.startswith');
  assert.ok(content.includes('رصيد لصالح الزبون'));
  statement.window.close();
  const printable = open('/customers/1/print');
  await wait(60);
  const printText = printable.window.document.body.textContent;
  assert.ok(printText.includes('رصيد لصالح الزبون: -50'));
  assert.ok(printText.includes('قبل بدء النظام'));
  assert.ok(!printText.includes('إجمالي الدين حتى الآن'));
  printable.window.close();
  console.log('Knaash UI: owner preview only, no posting; credited statement + print PASS (fake data)');
})().catch(error => {console.error(error);process.exitCode = 1;});
