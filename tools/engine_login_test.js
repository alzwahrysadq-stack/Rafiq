// اختبار دخول واجهة WebView بأصول jsdom المحلية نفسها، لا الاتصال بالشبكة.
// يتطلب: npm install --no-save --no-package-lock jsdom@24
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, ResourceLoader } = require('jsdom');
const WEB = path.resolve(__dirname, '../app/src/main/assets/web');
class Assets extends ResourceLoader {
  fetch(url) {
    const prefix = '/assets/web/';
    if (!url.includes(prefix)) return null;
    const rel = url.split(prefix)[1];
    if (!rel || rel.includes('..')) return null;
    const local = path.join(WEB, rel);
    return fs.existsSync(local) ? Promise.resolve(fs.readFileSync(local)) : null;
  }
}
const calls = [];
const pages = {
  '/login': { status: 200, template: 'login.html', endpoint: 'login', path: '/login',
    ctx: { S: {demo_hint:'0', currency:'ريال'}, users: [{id:1,name:'صاحب المتجر',role:'owner'}] }, flashes: [] },
  '/pos': { status: 200, template: 'pos.html', endpoint: 'pos', path: '/pos',
    ctx: { S: {currency:'ريال'}, shift: {id:1}, u: {id:1,name:'صاحب المتجر',role:'owner'} }, flashes: [] },
};
const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://appassets.androidplatform.net/assets/web/index.html?p=/login',
  runScripts: 'dangerously', resources: new Assets(), pretendToBeVisual: true,
});
const w = dom.window;
w.scrollTo = () => {};
w.Response = Response;
w.RafiqDevice = { version: () => 'test', scan: () => {} };
w.RafiqNative = {
  page(method, path, body) {
    calls.push([method, path, body]);
    if (method === 'POST' && path.startsWith('/login')) return JSON.stringify({ status: 302, redirect: '/' });
    if (path === '/') return JSON.stringify({ status: 302, redirect: '/pos' });
    return JSON.stringify(pages[path] || { status: 302, redirect: '/login' });
  },
  api: () => JSON.stringify({ status: 200, body: '{"ok":true,"products":[]}' }),
};
for (const file of ['vendor/nunjucks.min.js', 'routes.js', 'templates.js', 'engine.js']) {
  w.eval(fs.readFileSync(path.join(WEB, file), 'utf8'));
}
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
  for (let i = 0; typeof w.document.querySelector('.user-btn')?.onclick !== 'function' && i < 20; i++) await wait(50);
  const d = w.document;
  assert.equal(d.querySelectorAll('.user-btn').length, 1, 'user choice missing');
  d.querySelector('.user-btn').click();
  for (const digit of ['1','1','1','1']) {
    const button = d.querySelector(`.num-pad .btn[data-k="${digit}"]`);
    assert.ok(button, 'PIN digit missing');
    button.click();
  }
  for (let i = 0; !calls.some(c => c[0] === 'POST' && c[1].startsWith('/login')); i++) {
    if (i >= 20) throw Error('PIN form was never submitted');
    await wait(50);
  }
  assert.ok(calls.some(c => c[0] === 'POST' && c[1].startsWith('/login') &&
    JSON.parse(c[2]).uid === '1' && JSON.parse(c[2]).pin === '1111'));
  console.log('PASS: login page loaded, PIN keypad submitted locally');
  w.close();
})().catch(err => { console.error(err); w.close(); process.exitCode = 1; });
