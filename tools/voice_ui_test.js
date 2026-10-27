// فحص الأوامر الصوتية بواجهة وهمية، بلا ميكروفون ولا بيانات زبائن حقيقية.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {JSDOM, ResourceLoader} = require('jsdom');
const WEB = path.resolve(__dirname, '../app/src/main/assets/web');
class Assets extends ResourceLoader {
  fetch(url) {
    const prefix = '/assets/web/';
    if (!url.includes(prefix)) return null;
    const relative = url.split(prefix)[1];
    if (!relative || relative.includes('..')) return null;
    const file = path.join(WEB, relative);
    return fs.existsSync(file) ? Promise.resolve(fs.readFileSync(file)) : null;
  }
}
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) {
  for (let i = 0; i < 50; i++) { if (fn()) return; await wait(20); }
  assert.fail('voice UI did not render');
}
async function open(route = '/pos', role = 'owner') {
  const wdom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'https://appassets.androidplatform.net/assets/web/index.html?p=' + encodeURIComponent(route),
    runScripts: 'dangerously', resources: new Assets(), pretendToBeVisual: true,
  });
  const w = wdom.window;
  const calls = [], listens = [];
  w.scrollTo = () => {};
  w.Response = Response;
  w.RafiqDevice = {version: () => 'test', listen: () => { listens.push('listen'); }};
  const ctx = {u: {id: 1, name: 'مالك وهمي', role}, S: {currency: 'عملة تجريبية'},
    shift: {id: 1}, users: [{id: 1, name: 'مالك وهمي', role}], logs: []};
  w.RafiqNative = {
    page(method, pathname) {
      calls.push([method, pathname]);
      const p = pathname.split('?')[0];
      return JSON.stringify({status: 200, path: p, endpoint: p === '/pos' ? 'pos' : 'login',
        template: p === '/login' ? 'login.html' : 'pos.html', ctx, flashes: []});
    },
    api() { throw new Error('speech must never call a financial API'); },
  };
  for (const file of ['vendor/nunjucks.min.js', 'routes.js', 'templates.js', 'engine.js']) {
    w.eval(fs.readFileSync(path.join(WEB, file), 'utf8'));
  }
  await until(() => !!w.document.querySelector(route === '/login' ? '.login-card' : '.pos-wrap'));
  // حمّل سكربتات الصفحة/الهوية قبل إغلاق نافذة الاختبار.
  await wait(60);
  return {wdom, w, calls, listens};
}
(async function () {
  const login = await open('/login');
  assert.equal(login.w.document.getElementById('rafiqMic'), null, 'no microphone before login');
  login.wdom.window.close();

  const owner = await open('/pos');
  const w = owner.w, d = w.document, by = id => d.getElementById(id);
  const command = w.rafiqVoiceCommand;
  assert.equal(command('افتح البيع').path, '/pos');
  assert.equal(command('نقطة البيع').path, '/pos');
  assert.equal(command('روح للبيع').path, '/pos');
  assert.equal(command('وريني تقرير الصندوق').path, '/cash/report');
  assert.equal(command('تقرير الصندوق').path, '/cash/report');
  assert.equal(command('أبحث عن حليب').path, '/find?q=' + encodeURIComponent('حليب'));
  assert.equal(command('ابحث عن عميل #00042').path, '/customers?q=%2300042');
  assert.equal(command('سدد دين أحمد').type, 'manual');
  assert.equal(command('بع حليب').type, 'manual');
  assert.equal(w.rafiqVoiceRoute('بيع حليب'), null);
  assert.equal(w.rafiqVoiceRoute('افتح البيع وسجل دين'), null);
  assert.equal(w.rafiqVoiceRoute('إلغاء البيع'), null);
  assert.equal(w.rafiqVoiceRoute('افتتح البيع'), null, 'do not route by substring similarity');

  await until(() => !!by('rafiqMic'));
  assert.equal(owner.listens.length, 0, 'listening must be user initiated');
  by('rafiqMic').click();
  assert.ok(by('rafiqVoiceCard').textContent.includes('قد تحتاج خدمة الهاتف إلى الإنترنت'));
  assert.ok(by('rafiqVoiceCard').textContent.includes('لمزوّد التعرّف'));
  assert.equal(owner.listens.length, 0, 'opening guidance alone must not record');
  by('rafiqVoiceStart').click();
  assert.equal(owner.listens.length, 1);
  assert.equal(by('rafiqVoiceStart').disabled, true);
  w.__rafiqVoiceCandidates(['افتح البيع']);
  assert.ok(by('rafiqVoicePreview').textContent.includes('افتح البيع'));
  assert.equal(by('rafiqVoiceGo').style.display, '');
  assert.equal(owner.calls.filter(x => x[1] === '/pos').length, 1, 'no navigation before confirmation');
  by('rafiqVoiceGo').click();
  assert.equal(owner.calls.filter(x => x[1] === '/pos').length, 2);
  assert.equal(by('rafiqVoiceShade'), null);

  by('rafiqMic').click();
  w.__rafiqVoiceCandidates(['سدد دين سالم']);
  assert.equal(by('rafiqVoiceGo').style.display, 'none');
  assert.ok(by('rafiqVoiceStatus').textContent.includes('يدوياً'));
  assert.equal(owner.calls.filter(x => x[1] === '/pos').length, 2);
  w.__rafiqVoiceCandidates(['سجل دين سالم', 'افتح البيع']);
  assert.equal(by('rafiqVoiceGo').style.display, 'none',
    'a safe alternative must not override a financial recognition hypothesis');
  w.__rafiqVoiceCandidates(['<img src=x onerror=alert(1)>']);
  assert.equal(d.querySelector('#rafiqVoiceCard img'), null, 'speech is displayed as text, never HTML');
  assert.equal(by('rafiqVoiceGo').style.display, 'none');
  w.__rafiqVoiceCandidates(['افتح البيع', 'افتح الزبائن']);
  assert.equal(by('rafiqVoiceChoices').querySelectorAll('button').length, 2,
    'contradictory recognition hypotheses need manual selection');
  assert.equal(by('rafiqVoiceGo').style.display, 'none');
  by('rafiqVoiceChoices').querySelector('button').click();
  assert.equal(by('rafiqVoiceGo').style.display, '');
  by('rafiqVoiceClose').click();
  w.__rafiqVoiceCandidates(['افتح البيع']);
  assert.equal(by('rafiqVoiceShade'), null, 'late speech result cannot execute after closing');
  by('rafiqMic').click();
  by('rafiqVoiceStart').click();
  w.__rafiqVoiceError('خدمة الصوت غير متاحة');
  assert.ok(by('rafiqVoiceStatus').textContent.includes('غير متاحة'));
  assert.equal(by('rafiqVoiceStart').disabled, false, 'allow retry after unavailable service');
  assert.equal(by('rafiqVoiceGo').style.display, 'none');
  assert.equal(w.__rafiqBack(), true, 'device back closes voice review instead of leaving page');
  assert.equal(by('rafiqVoiceShade'), null);
  owner.wdom.window.close();

  const worker = await open('/pos', 'worker');
  await until(() => !!worker.w.document.getElementById('rafiqMic'));
  assert.equal(worker.listens.length, 0);
  worker.wdom.window.close();
  console.log('Voice UI: Arabic command preview, manual financial operations, login privacy, worker access PASS (fake data)');
})().catch(e => { console.error(e); process.exitCode = 1; });
