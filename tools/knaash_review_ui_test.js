// مراجعة الشاشة نفسها ببيانات وهمية فقط؛ لا يُستعمل PDF الحقيقي ولا أسماء الزبائن الحقيقية.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {JSDOM, ResourceLoader} = require('jsdom');
const assetsRoot = path.resolve(__dirname, '../app/src/main/assets');
const web = path.join(assetsRoot, 'web');
const SHA = 'a'.repeat(64);
const SHA_OTHER = 'b'.repeat(64);
const DATE = '2026-10-14';
const rows = [
  {index: 1, page: 1, sourceName: '<img src=x onerror=alert(1)>', phone: '', balanceCents: 8000},
  {index: 2, page: 1, sourceName: 'زبون اختباري', phone: '', balanceCents: -12000},
  {index: 3, page: 2, sourceName: 'زبون صفري', phone: '', balanceCents: 0},
];
class Assets extends ResourceLoader {
  fetch(url) {
    const prefix = '/assets/';
    if (!url.includes(prefix)) return null;
    const relative = url.split(prefix)[1];
    if (!relative || relative.includes('..')) return null;
    const file = path.join(assetsRoot, relative);
    if (!fs.existsSync(file)) return null;
    const response = Promise.resolve(fs.readFileSync(file));
    response.abort = () => {};
    return response;
  }
}
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) {
  for (let i = 0; i < 60; i++) {
    if (predicate()) return;
    await wait(15);
  }
  assert.fail('UI did not settle in time');
}
const store = {draft: null, calls: []};
const candidates = [
  {id: 7, code: '#00007', name: 'زبون من رفيق', phone: '123', has_history: false, balance_cents: 0},
  {id: 8, code: '#00008', name: 'ذو حركات', phone: '', has_history: true, balance_cents: 0},
  {id: 9, code: '#00009', name: 'رصيد قائم', phone: '', has_history: false, balance_cents: -100},
];
function reply(method, url, body) {
  store.calls.push([method, url, body]);
  const u = new URL(url, 'https://appassets.androidplatform.net');
  const fail = (error, status = 409) => ({status, body: JSON.stringify({ok: false, error})});
  const ok = fields => ({status: 200, body: JSON.stringify({ok: true, ...fields})});
  if (u.pathname.endsWith('/customers') && method === 'GET') {
    return ok({customers: candidates});
  }
  if (u.pathname.endsWith('/review') && method === 'GET') {
    if (!store.draft) return ok({choices: [], other_file: false});
    if (store.draft.sha !== u.searchParams.get('sha') || store.draft.date !== u.searchParams.get('date') ||
        store.draft.count !== Number(u.searchParams.get('count'))) {
      return ok({choices: [], other_file: true, previous_sha256: store.draft.sha,
        previous_date: store.draft.date, previous_count: store.draft.count});
    }
    return ok({choices: store.draft.choices, other_file: false});
  }
  if (u.pathname.endsWith('/review') && method === 'POST') {
    const input = JSON.parse(body);
    if (store.draft && store.draft.sha !== input.sha) return fail('كشف مختلف');
    const c = input.choice;
    if (c.mode === 'zero' && c.index !== 3) return fail('ليس صفراً');
    if (c.mode === 'existing' && (!c.customer_id || c.customer_id !== 7)) return fail('زبون غير صالح');
    if (c.mode === 'new' && c.name === 'زبون من رفيق') return fail('اسم مكرر');
    if (store.draft && store.draft.choices.some(old =>
        old.index !== c.index && c.customer_id && old.customer_id === c.customer_id)) return fail('زبون مكرر');
    const choices = (store.draft?.choices || []).filter(old => old.index !== c.index).concat(c);
    store.draft = {sha: input.sha, date: input.date, count: input.count, choices};
    return ok({choices, reviewed: choices.length});
  }
  if (u.pathname.endsWith('/review') && method === 'DELETE') {
    if (!store.draft || store.draft.sha !== u.searchParams.get('sha')) return fail('كشف مختلف');
    store.draft = null;
    return ok({});
  }
  return fail('مسار غير متوقع', 404);
}
async function open(role = 'owner') {
  const url = 'https://appassets.androidplatform.net/assets/web/index.html?p=%2Fimports';
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url, runScripts: 'dangerously', resources: new Assets(), pretendToBeVisual: true,
  });
  const w = dom.window;
  w.scrollTo = () => {};
  w.Response = Response;
  w.RafiqDevice = {version: () => 'test'};
  w.RafiqNative = {
    page(method, pathname) {
      assert.equal(pathname, '/imports');
      return JSON.stringify({template: 'imports.html', endpoint: 'imports', path: '/imports', status: 200,
        flashes: [], ctx: {u: {id: 1, role, name: 'تجريبي'}, logs: [], S: {currency: 'عملة غير مؤكدة'}}});
    },
    api(method, route, body) {
      if (role !== 'owner') return JSON.stringify({status: 403, body: '{"ok":false,"error":"ممنوع"}'});
      return JSON.stringify(reply(method, route, body));
    },
  };
  for (const name of ['vendor/nunjucks.min.js', 'routes.js', 'templates.js', 'engine.js']) {
    w.eval(fs.readFileSync(path.join(web, name), 'utf8'));
  }
  await until(() => w.document.body.textContent.includes('استيراد البيانات') &&
    (role !== 'owner' || (!!w.document.querySelector('#knaashStatus') && !!w.RafiqKnaashReview)));
  // انتظر اكتمال سكربتات القالب قبل إغلاق نافذة jsdom في اختبار العامل.
  await until(() => typeof w.openCameraScanner === 'function');
  await wait(80);
  return dom;
}
(async function main() {
  const owner = await open();
  const w = owner.window;
  const el = id => w.document.getElementById(id);
  assert.ok(w.RafiqKnaashReview, 'the review JS asset must be loaded from the APK');
  assert.equal(typeof el('knaashReviewPanel')?.style.display, 'string', 'rendered template must include panel');
  const instance = w.RafiqKnaashReview.create({root: el('knaashPreview'), rows,
    sourceSha256: SHA, reportDateIso: DATE});
  await instance.load();
  assert.ok(el('knaashProgress').textContent.includes('0 من 3'));
  instance.open(rows[0]);
  assert.equal(w.document.querySelector('#knaashReviewPanel img'), null, 'PDF text must never become HTML');
  const before = store.calls.filter(([method]) => method === 'POST').length;
  el('knaashSave').click();
  await wait(0);
  assert.equal(store.calls.filter(([method]) => method === 'POST').length, before);
  el('knaashNew').click();
  el('knaashNewName').value = 'عميل أول اختباري';
  el('knaashNewPhone').value = '12345';
  el('knaashChecked').checked = true;
  el('knaashSave').click();
  await until(() => store.draft?.choices.length === 1);
  await until(() => el('knaashRowTitle').textContent.includes('صف 2'));
  assert.ok(instance.label(1).includes('جديد'));
  assert.deepEqual(Object.keys(store.draft.choices[0]).sort(), ['index', 'mode', 'name', 'phone']);

  el('knaashExisting').click();
  el('knaashSearch').value = 'زبون';
  el('knaashFind').click();
  await until(() => el('knaashMatches').querySelectorAll('button').length === 3);
  const options = [...el('knaashMatches').querySelectorAll('button')];
  assert.deepEqual(options.map(x => x.disabled), [false, true, true]);
  assert.equal(el('knaashPicked').textContent, '', 'never auto-select an existing customer');
  el('knaashChecked').checked = true;
  el('knaashSave').click();
  assert.equal(store.draft.choices.length, 1, 'must explicitly choose a matching customer');
  options[0].click();
  assert.equal(el('knaashChecked').checked, false, 'require re-confirmation after choosing identity');
  el('knaashChecked').checked = true;
  el('knaashSave').click();
  await until(() => store.draft?.choices.length === 2);
  await until(() => el('knaashRowTitle').textContent.includes('صف 3'));
  assert.equal(el('knaashZero').style.display, '');
  el('knaashZero').click();
  el('knaashChecked').checked = true;
  el('knaashSave').click();
  await until(() => store.draft?.choices.length === 3);
  await until(() => el('knaashProgress').textContent.includes('3 من 3'));
  assert.equal(store.draft.choices[2].reported_balance_cents, 0);
  assert.equal(el('knaashReviewPanel').style.display, 'none');
  instance.dispose();
  owner.window.close();

  const again = await open();
  const d = again.window.document;
  const repeat = again.window.RafiqKnaashReview.create({root: d.getElementById('knaashPreview'),
    rows, sourceSha256: SHA, reportDateIso: DATE});
  await repeat.load();
  assert.ok(d.getElementById('knaashProgress').textContent.includes('3 من 3'));
  assert.ok(repeat.label(2).includes('موجود'));
  repeat.dispose();
  again.window.close();

  const other = await open();
  const o = other.window.document;
  const otherReview = other.window.RafiqKnaashReview.create({root: o.getElementById('knaashPreview'),
    rows, sourceSha256: SHA_OTHER, reportDateIso: DATE});
  await otherReview.load();
  assert.equal(otherReview.canReview(), false);
  assert.equal(o.getElementById('knaashOtherFile').style.display, '');
  assert.equal(o.getElementById('knaashOtherFileMessage').textContent.includes(DATE), true);
  otherReview.open(rows[0]);
  assert.equal(o.getElementById('knaashReviewPanel').style.display, 'none');
  other.window.confirm = () => false;
  o.getElementById('knaashClearOld').click();
  await wait(0);
  assert.equal(store.draft.sha, SHA, 'cancelled deletion keeps previous draft');
  other.window.confirm = () => true;
  o.getElementById('knaashClearOld').click();
  await until(() => otherReview.canReview());
  assert.equal(store.draft, null, 'explicitly delete only the old draft');
  otherReview.open(rows[0]);
  o.getElementById('knaashNew').click();
  o.getElementById('knaashNewName').value = 'عميل بعد مسح المسودة';
  o.getElementById('knaashChecked').checked = true;
  o.getElementById('knaashSave').click();
  await until(() => store.draft?.sha === SHA_OTHER);
  otherReview.dispose();
  other.window.close();

  const stale = await open();
  const s = stale.window.document;
  let answer, saveAnswer;
  const pending = new Promise(resolve => { answer = resolve; });
  const pendingSave = new Promise(resolve => { saveAnswer = resolve; });
  const guarded = stale.window.RafiqKnaashReview.create({root: s.getElementById('knaashPreview'),
    rows, sourceSha256: SHA_OTHER, reportDateIso: DATE,
    request: (method, url) => url.includes('/customers') ? pending :
      method === 'POST' ? pendingSave : Promise.resolve({ok: true, choices: []})});
  guarded.open(rows[0]);
  s.getElementById('knaashExisting').click();
  s.getElementById('knaashFind').click();
  guarded.open(rows[1]);
  answer({ok: true, customers: candidates});
  await wait(0);
  assert.equal(s.getElementById('knaashMatches').querySelectorAll('button').length, 0,
    'search for previous row must not offer wrong identity to the new row');
  s.getElementById('knaashNew').click();
  s.getElementById('knaashNewName').value = 'زبون واجهة وهمي';
  s.getElementById('knaashChecked').checked = true;
  s.getElementById('knaashSave').click();
  guarded.open(rows[0]);
  assert.ok(s.getElementById('knaashRowTitle').textContent.includes('صف 2'),
    'changing rows while a review is saving must not reassign its identity');
  saveAnswer({ok: true, choices: [{index: 2, mode: 'new', name: 'زبون واجهة وهمي', phone: ''}]});
  await until(() => s.getElementById('knaashRowTitle').textContent.includes('صف 3'));
  guarded.dispose();
  stale.window.close();

  const worker = await open('worker');
  assert.equal(worker.window.document.getElementById('knaashPdf'), null);
  assert.equal(worker.window.document.getElementById('knaashReviewPanel'), null);
  assert.equal(worker.window.RafiqKnaashReview, undefined);
  assert.equal(JSON.parse(worker.window.RafiqNative.api('GET', '/api/imports/knaash/review', '')).status, 403);
  worker.window.close();
  console.log('Knaash review UI: explicit identities, credit/zero, restart, other file, stale search, worker denied PASS (fake data)');
})().catch(error => { console.error(error); process.exitCode = 1; });
