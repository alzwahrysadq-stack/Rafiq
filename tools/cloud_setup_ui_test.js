// Fake owner session; verify the first-run screen never embeds a key or performs network I/O.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, ResourceLoader } = require('jsdom');
const WEB = path.resolve(__dirname, '../app/src/main/assets/web');
const TEMPLATE = fs.readFileSync(path.resolve(__dirname, '../templates_extra/cloud_setup.html'), 'utf8');
class Assets extends ResourceLoader {
  fetch(url) {
    const prefix = '/assets/web/';
    if (!url.includes(prefix)) return null;
    const relative = url.split(prefix)[1];
    if (!relative || relative.includes('..')) return null;
    const f = path.join(WEB, relative);
    return fs.existsSync(f) ? Promise.resolve(fs.readFileSync(f)) : null;
  }
}
async function render(configured) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'https://appassets.androidplatform.net/assets/web/index.html?p=/cloud/setup',
    runScripts: 'dangerously', resources: new Assets(), pretendToBeVisual: true,
  });
  const w = dom.window;
  w.scrollTo = () => {};
  w.Response = Response;
  w.RafiqDevice = {version: () => 'test'};
  let calls = 0;
  w.RafiqNative = {
    page(method, route) {
      calls++;
      assert.equal(method, 'GET');
      assert.equal(route, '/cloud/setup');
      return JSON.stringify({status:200, template:'cloud_setup.html', endpoint:'cloud_setup', path:route,
        ctx: {configured, project_url: configured ? 'https://syntheticprojectref.supabase.co' : '',
          first_run: !configured, cloud_verified:false,
          u:{id:1, role:'owner', name:'مالك تجريبي'}, S:{currency:'ريال يمني'}}, flashes:[]});
    },
    api() { assert.fail('bootstrap UI must not call a financial/cloud API'); },
  };
  for (const file of ['vendor/nunjucks.min.js', 'routes.js', 'templates.js']) {
    w.eval(fs.readFileSync(path.join(WEB,file),'utf8'));
  }
  w.RAFIQ_TEMPLATES['cloud_setup.html'] = TEMPLATE;
  w.eval(fs.readFileSync(path.join(WEB,'engine.js'),'utf8'));
  for (let i=0; i<30 && !w.document.getElementById('cloudSetupForm'); i++) {
    await new Promise(resolve=>setTimeout(resolve,20));
  }
  assert.ok(w.document.getElementById('cloudSetupForm'), 'first-run config form should render');
  const d=w.document;
  assert.equal(d.getElementById('cloudBootstrapStatus').dataset.verified,'false');
  assert.equal(d.getElementById('cloudPublishableKey').type,'password');
  assert.equal(d.getElementById('cloudPublishableKey').value,'');
  assert.equal(d.getElementById('cloudProjectUrl').value,
    configured ? 'https://syntheticprojectref.supabase.co' : '');
  assert.equal(!!d.querySelector('form[action="/cloud/setup/skip"]'), !configured);
  assert.equal(!!d.getElementById('cloudReplace'), configured);
  assert.ok(d.body.textContent.includes('لن تُرفع بيانات زبائنك'));
  assert.ok(d.body.textContent.includes('لا تُدخل'));
  assert.equal(calls,1);
  await new Promise(resolve=>setTimeout(resolve,80));
  dom.window.close();
}
(async()=>{
  await render(false); await render(true);
  console.log('Cloud setup UI: owner first-run, optional offline skip, no key leak, unverified status PASS');
})().catch(error=>{console.error(error);process.exitCode=1;});
