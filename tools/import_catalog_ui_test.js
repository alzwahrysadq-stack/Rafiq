// معاينة استيراد أصناف ببيانات وهمية؛ لا تُستورد قائمة المالك ولا تُكتب قاعدة حقيقية.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {JSDOM, ResourceLoader} = require('jsdom');
const WEB = path.resolve(__dirname, '../app/src/main/assets/web');
class Assets extends ResourceLoader {
  fetch(url) {
    const key = '/assets/web/';
    if (!url.includes(key)) return null;
    const relative = url.split(key)[1];
    if (!relative || relative.includes('..')) return null;
    const file = path.join(WEB, relative);
    return fs.existsSync(file) ? Promise.resolve(fs.readFileSync(file)) : null;
  }
}
const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://appassets.androidplatform.net/assets/web/index.html?p=/imports',
  runScripts: 'dangerously', resources: new Assets(), pretendToBeVisual: true,
});
const w = dom.window;
w.scrollTo = () => {};
w.Response = Response;
w.RafiqDevice = {version: () => 'test'};
const ctx = {
  S: {currency: 'ريال', store_name: 'محل وهمي'}, u: {id: 1, role: 'owner', name: 'صاحب وهمي'},
  kind: 'products', filename: 'catalog-synthetic.csv', token: 'abc123', ok: 1, warn: 1, err: 0, total: 2,
  records: [
    {row: 2, status: 'ok', error: '', name: 'دقيق اختبار', barcode: 'CODE-1',
      cost_cents: 120000, price_cents: 150000, stock: 0, stock_provided: false, expiry: null},
    {row: 3, status: 'warn', error: 'رقم تحقق EAN-13 غير مطابق', name: 'رمز داخلي محتمل',
      barcode: '1234567890123', cost_cents: 1000, price_cents: 1200,
      stock: 5, stock_provided: true, expiry: null},
  ],
};
w.RafiqNative = {
  page(method, route) {
    assert.equal(method, 'GET');
    return JSON.stringify({status: 200, path: route, template: 'import_preview.html', endpoint: 'imports',
      ctx, flashes: []});
  },
  api() { assert.fail('Preview must not write a sale/import'); },
};
for (const file of ['vendor/nunjucks.min.js', 'routes.js', 'templates.js', 'engine.js']) {
  w.eval(fs.readFileSync(path.join(WEB, file), 'utf8'));
}
(async () => {
  const table = w.document.querySelector('.tbl');
  assert.ok(table, 'import preview must render');
  const text = table.textContent;
  assert.ok(text.includes('سعر الشراء') && text.includes('1,200'));
  assert.ok(text.includes('سعر البيع') && text.includes('1,500'));
  assert.ok(text.includes('غير محددة (الموجود محفوظ، الجديد 0)'), 'missing stock explained, not silently zero');
  assert.ok(text.includes('رقم تحقق EAN-13 غير مطابق'), 'EAN warning must be visible before confirmation');
  assert.ok(w.document.body.textContent.includes('لا يوجد زر تراجع أو حذف جماعي'));
  const confirm = w.document.querySelector('form[action="/imports/commit"]');
  assert.ok(confirm && confirm.getAttribute('onsubmit').includes('لا يوجد تراجع جماعي'));
  await new Promise(resolve => setTimeout(resolve, 90));
  dom.window.close();
  console.log('Import catalog UI: cost/sale separate, stock preservation explained, no undo warning PASS (fake data)');
})().catch(error => {console.error(error);process.exitCode = 1;});
