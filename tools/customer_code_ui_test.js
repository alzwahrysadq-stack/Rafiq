// فحص شاشة الآجل من القوالب المدمجة مع نفس محرّك WebView (يتطلب jsdom@24).
// تشغيل دون Android build: npm install --no-save --no-package-lock jsdom@24 && node tools/customer_code_ui_test.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, ResourceLoader } = require('jsdom');
const web = path.resolve(__dirname, '../app/src/main/assets/web');

class LocalAssets extends ResourceLoader {
  fetch(url) {
    const key = '/assets/web/';
    if (!url.includes(key)) return null;
    const rel = url.split(key)[1];
    if (!rel || rel.includes('..')) return null;
    const file = path.join(web, rel);
    if (!fs.existsSync(file)) return null;
    return Promise.resolve(fs.readFileSync(file));
  }
}

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://appassets.androidplatform.net/assets/web/index.html?p=/pos',
  runScripts: 'dangerously', resources: new LocalAssets(), pretendToBeVisual: true,
});
const w = dom.window;
w.scrollTo = () => {};
w.Response = Response;
w.RafiqDevice = { version: () => 'test', scan: () => {}, scanDiagnostics: () => '{}' };
const customers = [
  { id: 1, code: '#00001', name: 'سالم', phone: '', balance_cents: 3000 },
  { id: 2, code: '#00002', name: 'سالم', phone: '0771', balance_cents: 0 },
];
let created = false;
w.RafiqNative = {
  page(method, p) {
    if (p !== '/pos') throw Error('unexpected page: ' + p);
    return JSON.stringify({ status: 200, template: 'pos.html', endpoint: 'pos', path: '/pos', flashes: [],
      ctx: { u: { id: 1, name: 'المالك', role: 'owner' },
        S: { store_name: 'متجر تجريبي', currency: 'ريال', country_code: '967' },
        shift: { id: 1 }, } });
  },
  api(method, url, body) {
    if (method === 'POST' && url === '/api/customers') {
      const req = JSON.parse(body);
      assert.equal(req.name, 'سالم');
      if (created) throw Error('duplicate request');
      created = true;
      return JSON.stringify({ status: 200, body: JSON.stringify({ ok: true, customer: customers[1] }) });
    }
    if (method === 'GET' && url.startsWith('/api/customers?q=')) {
      const q = decodeURIComponent(url.split('q=')[1]);
      const found = q.startsWith('#') ? customers.filter(c => c.code === q) : customers.filter(c => c.name.includes(q));
      return JSON.stringify({ status: 200, body: JSON.stringify({ ok: true, customers: found }) });
    }
    throw Error('unexpected API: ' + method + ' ' + url);
  },
};
for (const file of ['vendor/nunjucks.min.js', 'routes.js', 'templates.js', 'engine.js']) {
  w.eval(fs.readFileSync(path.join(web, file), 'utf8'));
}
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
  for (let i = 0; !w.createCust && i < 20; i++) await wait(50);
  assert.equal(typeof w.createCust, 'function', 'POS script did not load');
  w.openCredit();
  w.document.getElementById('newCustName').value = 'سالم';
  w.document.getElementById('newCustPhone').value = '0771';
  await w.createCust();
  assert.equal(w.chosenCustomer.id, 2, 'quick-add selected duplicate old name');
  assert.equal(w.document.getElementById('custName').textContent, 'سالم');
  assert.equal(w.document.getElementById('custCode').textContent, '#00002');
  assert.equal(created, true);
  const search = w.document.getElementById('custSearch');
  search.value = '#00001';
  search.dispatchEvent(new w.Event('input', { bubbles: true }));
  search.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await wait(30);
  assert.equal(w.chosenCustomer.id, 1, 'exact code did not choose target');
  search.value = 'سالم آخر';
  search.dispatchEvent(new w.Event('input', { bubbles: true }));
  assert.equal(w.chosenCustomer, null, 'edited search kept the old debtor selected');
  assert.ok(w.document.getElementById('custChosen').classList.contains('hide'));
  console.log('PASS: quick-add exact id, exact code via Enter, stale debtor cleared');
  w.close();
})().catch(e => { console.error(e); w.close(); process.exitCode = 1; });
