// Local contract + jsdom test. It does NOT build Android or contact Supabase.
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {join,relative} from 'node:path';
import {JSDOM} from 'jsdom';
import * as lib from '../../web-client/lib.mjs';

const root=new URL('../../',import.meta.url);
const read=p=>readFileSync(new URL(p,root));
function files(prefix){
  const walk=p=>readdirSync(new URL(p,root),{withFileTypes:true}).flatMap(entry=>{
    const name=join(p,entry.name);
    return entry.isDirectory()?walk(name):[name];
  });
  return walk(prefix).map(p=>relative(prefix,p)).sort();
}
const sourceFiles=['index.html','lib.mjs','web.css','web.js','model.css','ocrParse.mjs',...files('web-client/assets').map(f=>`assets/${f}`)];
assert.deepEqual(files('app/src/main/assets/pilot'),sourceFiles.slice().sort(),
  'embedded UI must contain only synchronized web assets, without the Room engine or README');
for(const file of sourceFiles)assert.deepEqual(read(`web-client/${file}`),read(`app/src/main/assets/pilot/${file}`),`stale Android asset: ${file}`);
const manifest=read('app/src/main/AndroidManifest.xml').toString();
assert.match(manifest,/android:name="android.permission.INTERNET"/);
assert.match(manifest,/android:name="\.CloudPilotActivity" android:exported="false"/);
const activity=read('app/src/main/java/net/arena/rafiq/CloudPilotActivity.kt').toString();
const activityCode=activity.split('\n').filter(line=>!line.trimStart().startsWith('//')&&
  !line.trimStart().startsWith('*')).join('\n');
// 6أ: الواجهة الموحدة تحمل جسر مزامنة (طابور/مرآة/مراس) — لكن بلا وصول للدفتر المحلي القديم.
assert.doesNotMatch(activityCode,/RafiqNative|RafiqDevice/,
  'pilot must not expose the old local ledger or Android device bridge');
const bridgeSrc=read('app/src/main/java/net/arena/rafiq/cloud/CloudNativeBridge.kt').toString();
for(const banned of ['db.invoices()','db.products()','db.customers()','db.shifts()','db.users()','fun page(']){
  assert.ok(!bridgeSrc.includes(banned),`cloud sync bridge must not touch local ledger: ${banned}`);
}
// Settings table may hold ONLY the two cloud-binding keys — never ledger data.
for(const m of bridgeSrc.matchAll(/db\.settings\(\)\.(?:get|upsert)\(([^)]*)\)/g))
  assert.ok(/CLOUD_(BINDING|SETUP_SEEN)_KEY/.test(m[1]),`settings access limited to cloud binding keys, got: ${m[1]}`);
for(const required of ['db.ofx()','db.mirror()','db.syncMeta()']){
  assert.ok(bridgeSrc.includes(required),`cloud sync bridge missing ${required}`);
}
assert.match(activityCode,/@JavascriptInterface fun print\(\) = activity\.requestPrint\(\)/);
assert.match(activityCode,/addJavascriptInterface\(PilotPrintBridge\(this@CloudPilotActivity\), "RafiqPilotPrint"\)/);
assert.match(activityCode,/web\.createPrintDocumentAdapter/);
assert.match(activityCode,/CloudNativeBridge\(this@CloudPilotActivity, net\.arena\.rafiq\.data\.RafiqDatabase\.build\(applicationContext\)\), "NativeApi"\)/);
assert.match(activityCode,/addJavascriptInterface\(PilotScannerBridge\(this@CloudPilotActivity\), "RafiqPilotScanner"\)/);
assert.match(activityCode,/Intents\.Scan\.RESULT/);
assert.match(activityCode,/JSONObject\.quote\(code\)/,'barcode callback must quote untrusted scanner text');
const bridgeNames=activityCode.split('\n').filter(l=>l.includes('addJavascriptInterface('))
  .map(l=>(l.match(/"([A-Za-z]+)"\)?\s*$/)||[])[1]).sort();
assert.deepEqual(bridgeNames,['NativeApi','RafiqAppLock','RafiqPilotContacts','RafiqPilotPrint','RafiqPilotScanner','RafiqPilotVoice'],
  'only the reviewed narrow bridges are allowed in the unified UI');
assert.match(activity,/uri\.host == projectHost &&[\s\S]*?uri\.port == -1 && uri\.userInfo == null\) null else forbidden\(\)/,
  'outgoing project traffic must reject explicit ports and URL credentials');
assert.match(activity,/uri\.host == ASSET_HOST &&[\s\S]*?uri\.port == -1 && uri\.userInfo == null\)/,
  'local asset host must reject explicit ports and URL credentials');
assert.match(activity,/uri\.path == "\/rafiq-config"/);
assert.match(activity,/uri\.path == "\/assets\/pilot\/lib\.mjs"[\s\S]*WebResourceResponse\("text\/javascript", "UTF-8", module\)/,
  'module import must have an explicit JavaScript MIME type on older Android WebViews');
assert.match(activity,/Cache-Control" to "no-store"/);
assert.match(activity,/CloudConfigRules\.publishableKey/);
const native=read('app/src/main/java/net/arena/rafiq/web/NativeApi.kt').toString();
assert.match(native,/fun pilotConfiguration\(\): CloudConfiguration\?/);
assert.match(native,/if \(currentUser\(\) == null \|\| !licenseCheck/);
assert.match(native,/cloudStorage\?\.read\(binding\)/);
assert.match(native,/if \(path == "\/cloud\/pilot"\)/);

const html=read('web-client/index.html').toString();
assert.match(html,/connect-src 'self' https:\/\/\*\.supabase\.co wss:\/\/\*\.supabase\.co;/,
  'CSP must permit local /rafiq-config while restricting external connections');
const script=read('web-client/web.js').toString().replace(/^import \{([^\n]+)\} from '\.\/lib\.mjs';/,
  'const {$1}=window.RafiqLib;');
const dom=new JSDOM(html,{url:'https://appassets.androidplatform.net/assets/pilot/index.html',runScripts:'outside-only'});
const w=dom.window;w.RafiqLib=lib;
w.NativeApi={beginPilotDemoReset:()=>'{"ok":true,"clear_web":true}',
  finishPilotDemoReset:()=>'{"ok":true}'};
const key=`sb_publishable_${'A'.repeat(30)}`;
const stale=JSON.stringify({url:'https://staleprojectref.supabase.co',key});
w.localStorage.setItem('rafiq-test-web-config',stale);
// حزمة الإطلاق: جهاز مفعّل مسبقًا (بوابة التفعيل تُختبر في launch_package.test.mjs)
w.localStorage.setItem('rafiq-test-device:v2:android:launch-act',JSON.stringify({until:'2099-01-01T00:00:00Z',mode:'both',months:63,type:2}));
w.localStorage.setItem('rafiq-test-device:v2:android:launch-mode','online');
const calls=[];
w.fetch=async (url,options)=>{
  calls.push({url,options});
  return {ok:true,json:async()=>({url:'https://syntheticprojectref.supabase.co',key})};
};
w.eval(script);
for(let n=0;n<20 && w.document.getElementById('loginScreen').classList.contains('hide');n++)
  await new Promise(r=>setTimeout(r,5));
assert.equal(calls.length,1);
assert.equal(calls[0].url,'/rafiq-config');
assert.equal(calls[0].options.cache,'no-store');
assert.equal(w.document.getElementById('loginScreen').classList.contains('hide'),false);
assert.equal(w.document.getElementById('changeProject').hidden,true);
assert.equal(w.document.getElementById('projectUrl').value,'https://syntheticprojectref.supabase.co');
assert.equal(w.document.getElementById('publicKey').value,'');
assert.equal(w.localStorage.getItem('rafiq-test-web-config'),null,'remove stale browser config on the in-place update');
w.document.getElementById('setupForm').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));
await new Promise(r=>setTimeout(r,5));
assert.equal(w.localStorage.getItem('rafiq-test-web-config'),null,'embedded UI never writes project config');
w.close();

// Render the old local navigation page that launches the separate pilot, for both roles.
for(const role of ['owner','worker']){
  const local=new JSDOM('<!doctype html><html><body></body></html>',{
    url:'https://appassets.androidplatform.net/assets/web/index.html?p=/cloud/pilot',
    runScripts:'dangerously',pretendToBeVisual:true,
  });
  const screen=local.window;screen.scrollTo=()=>{};screen.Response=Response;
  let launches=0,calls=0;screen.RafiqDevice={version:()=> 'test',openPilot:()=>{launches++;}};
  screen.RafiqNative={page(method,path){calls++;assert.equal(method,'GET');assert.equal(path,'/cloud/pilot');
    return JSON.stringify({status:200,template:'cloud_pilot.html',endpoint:'cloud_pilot',path,
      ctx:{u:{id:role==='owner'?1:2,role,name:'اختبار'},S:{currency:'ريال يمني'}},flashes:[]});
  },api(){assert.fail('opening the pilot landing page must not write to the local ledger');}};
  for(const file of ['vendor/nunjucks.min.js','routes.js','templates.js','engine.js'])
    screen.eval(read(`app/src/main/assets/web/${file}`).toString());
  let button=null;
  for(let n=0;n<30;n++){
    button=screen.document.querySelector('button[onclick*="openPilot"]');
    if(button)break;
    await new Promise(r=>setTimeout(r,10));
  }
  assert.ok(button,`pilot launcher missing for ${role}`);
  assert.ok(screen.document.body.textContent.includes('لا تنقل فواتير'));
  button.click();assert.equal(launches,1);
  assert.equal(calls,1);local.window.close();
}
console.log('PASS Android pilot assets, isolated bridge, local launcher for owner/worker, embedded UI (fake).');

// Regression: Nunjucks does not filter `{% for user in users if role == ... %}`
// as Jinja does. Render the ACTUAL compiled Android settings template using its
// bundled Nunjucks engine: both workers must have controls; only an empty list
// of workers may say "لا يوجد عمال بعد". No phone database is changed here.
{
  const settingsSource=read('templates_extra/settings.html').toString();
  const dom=new JSDOM('<!doctype html><html><body></body></html>',{
    url:'https://appassets.androidplatform.net/assets/web/index.html',runScripts:'outside-only'});
  const w=dom.window;
  w.eval(read('app/src/main/assets/web/vendor/nunjucks.min.js').toString());
  w.eval(read('app/src/main/assets/web/templates.js').toString());
  const bundled=w.RAFIQ_TEMPLATES['settings.html'];
  assert.ok(bundled.includes('صلاحيات العمال'));
  assert.ok(settingsSource.includes('صلاحيات العمال'));
  const loader=w.nunjucks.Loader.extend({getSource(name){
    const src=w.RAFIQ_TEMPLATES[name];return src?{src,path:name,noCache:true}:null;
  }});
  const env=new w.nunjucks.Environment(new loader(),{autoescape:true});
  env.addGlobal('url_for',()=>'/fake');
  const owner={id:1,name:'صاحب المتجر',role:'owner'};
  const workers=[{id:2,name:'أحمد (عامل)',role:'worker',p_pos:true,p_products:true},
    {id:3,name:'سالم (عامل)',role:'worker',p_pos:true,p_products:false}];
  const screens=[{k:'pos',l:'البيع'},{k:'products',l:'الأصناف'}];
  function render(users_list){
    const text=env.render('settings.html',{u:owner,users_list,screens,
      S:{currency:'ريال'},request:{endpoint:'settings'},get_flashed_messages:()=>[]});
    return new JSDOM(text).window.document;
  }
  const full=render([owner,...workers]);
  for(const id of [2,3]){
    assert.ok(full.querySelector(`#p${id}_pos`),`missing local worker ${id} POS checkbox`);
    assert.ok(full.querySelector(`#p${id}_products`),`missing local worker ${id} product checkbox`);
  }
  assert.equal(full.querySelector('#p2_products').checked,true);
  assert.equal(full.querySelector('#p3_products').checked,false);
  assert.equal(full.querySelectorAll('input[type="checkbox"][name^="perm_"]').length,4);
  assert.equal(full.querySelectorAll('input[type="hidden"][name^="perm_present_"]').length,2);
  assert.ok(!full.body.textContent.includes('لا يوجد عمال بعد'));
  assert.ok(full.querySelector('input[name="name"][value="صاحب المتجر"]'),
    'owner name editing also disappeared with the unsupported filtered loop');
  const none=render([owner]);
  assert.equal(none.querySelectorAll('input[type="checkbox"][name^="perm_"]').length,0);
  assert.equal(none.querySelectorAll('input[type="hidden"][name^="perm_present_"]').length,0);
  assert.ok(none.body.textContent.includes('لا يوجد عمال بعد'));
  dom.window.close();
  console.log('PASS local settings: two workers, checked controls, owner name, and true empty state.');
}
