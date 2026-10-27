// jsdom checks the standalone browser UI with a fake in-memory Supabase transport.
// There is deliberately no network access and no login to an actual project.
import {JSDOM} from 'jsdom';
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import * as lib from '../../web-client/lib.mjs';

const html=readFileSync(new URL('../../web-client/index.html',import.meta.url),'utf8');
const source=readFileSync(new URL('../../web-client/web.js',import.meta.url),'utf8')
  .replace(/^import \{([^\n]+)\} from '\.\/lib\.mjs';/, 'const {$1}=window.RafiqLib;');
const STORE='11111111-1111-4111-8111-111111111111';
const USER='22222222-2222-4222-8222-222222222222';
const KEY=`sb_publishable_${'A'.repeat(30)}`;

async function run(role,leaseAllowed=true,embedded=false){
  const dom=new JSDOM(html,{url:embedded?'https://appassets.androidplatform.net/assets/pilot/index.html':
    'https://rafiq.test/index.html',runScripts:'outside-only',pretendToBeVisual:true});
  const w=dom.window;w.RafiqLib=lib;w.crypto.randomUUID=()=> '33333333-3333-4333-8333-333333333333';
  w.localStorage.setItem('rafiq-test-device:v2:android:launch-act',JSON.stringify({until:'2099-01-01T00:00:00Z',mode:'both',months:63,type:2}));
  w.localStorage.setItem('rafiq-test-device:v2:android:launch-mode','online');
  if(embedded){ // Android normally injects CloudNativeBridge; fake only its in-memory read-only UI surface.
    const meta=new Map();
    w.NativeApi={beginPilotDemoReset:()=>'{"ok":true,"clear_web":false}',
      finishPilotDemoReset:()=>'{"ok":true}',
      metaGet:k=>meta.get(k)||'',metaSet:(k,v)=>{meta.set(k,v);return '{"ok":true}';},
      ofxList:()=> '[]',ofxQueued:()=> '[]',ofxReview:()=> '[]',mirrorGet:()=> '[]',
      mirrorPut:()=> '{"ok":true}'};
  }
  let browserPrint=0,nativePrint=0;
  w.print=()=>{browserPrint++;};w.RafiqPilotPrint={print:()=>{nativePrint++;}};w.prompt=()=>null;
  const calls=[];
  w.fetch=async url=>{
    assert.equal(url,'/rafiq-config');
    return {ok:true,json:async()=>({url:'https://syntheticprojectref.supabase.co',key:KEY})};
  };
  const oldFetch=globalThis.fetch;
  globalThis.fetch=async (url,options)=>{
    const path=new URL(url).pathname;
    calls.push({path,options});
    let data=null,status=200;
    if(path==='/auth/v1/token')data={access_token:'synthetic-access-token',refresh_token:'synthetic-refresh-token',
      expires_in:3600,user:{id:USER,email:'pilot@invalid.test'}};
    else if(path==='/rest/v1/rpc/rfq_pilot_request_device')data=role==='owner'?'pending':'approved';
    else if(path==='/rest/v1/rpc/rfq_pilot_claim_worker'&&!leaseAllowed){data={message:'worker_session_already_active'};status=400;}
    else if(path==='/rest/v1/rpc/rfq_pilot_claim_worker')data='2026-10-15T01:00:00Z';
    else if(path==='/rest/v1/rpc/rfq_pilot_heartbeat')data='2026-10-15T01:00:00Z';
    else if(path==='/rest/v1/rpc/rfq_pilot_my_open_shift')data=null;
    else if(path==='/rest/v1/rpc/rfq_pilot_owner_product_costs'){
      assert.equal(role,'owner','worker must never request purchase costs');
      data=[{id:'44444444-4444-4444-8444-444444444444',cost_cents:7000}];
    }
    else if(path==='/rest/v1/rpc/rfq_pilot_owner_summary')data={sales_cents:10000,outstanding_debt_cents:3000,
      cash_received_on_sales_cents:7000,gross_margin_estimate_cents:2000,new_credit_cents:3000};
    else if(path==='/rest/v1/rfq_pilot_members')data=options.method==='GET' && url.includes('limit=2')?
      [{store_id:STORE,role,active:true}]:[{user_id:USER,role,active:true}];
    else if(path==='/rest/v1/rfq_pilot_stores')data=[{id:STORE,name:'Test shop',enabled:true,seat_limit:2,
      license_until:'2026-11-15T01:00:00Z'}];
    else if(path==='/rest/v1/rfq_pilot_devices')data=url.includes('status=eq.pending')?[]:
      [{id:'33333333-3333-4333-8333-333333333333',status:'approved'}];
    else if(path==='/rest/v1/rfq_pilot_products')data=[{id:'44444444-4444-4444-8444-444444444444',
      name:'صنف تجريبي',price_cents:10000,stock_milli:10000,active:true}];
    else if(path==='/rest/v1/rfq_pilot_customers')data=[];
    else if(path.startsWith('/rest/v1/rfq_pilot_'))data=[];
    else data={};
    return {ok:status<300,status,text:async()=>JSON.stringify(data)};
  };
  try{
    w.eval(source);
    assert.equal(w.document.getElementById('appScreen').classList.contains('hide'),true);
    if(!embedded){
      const form=w.document.getElementById('setupForm');
      w.document.getElementById('projectUrl').value='https://syntheticprojectref.supabase.co';
      w.document.getElementById('publicKey').value=KEY;
      form.dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));
    }
    for(let tries=0;tries<30 && w.document.getElementById('loginScreen').classList.contains('hide');tries++)
      await new Promise(resolve=>setTimeout(resolve,10));
    assert.equal(w.document.getElementById('loginScreen').classList.contains('hide'),false);
    assert.equal(w.document.getElementById('publicKey').value,'');
    const saved=w.localStorage.getItem('rafiq-test-web-config');
    if(embedded)assert.equal(saved,null,'phone must not persist project key to browser storage');
    else{assert.ok(saved.includes('syntheticprojectref.supabase.co'));
      assert.ok(!saved.includes('synthetic-access-token'));}
    w.document.getElementById('email').value='pilot@invalid.test';
    w.document.getElementById('password').value='secret-test-password';
    w.document.getElementById('loginForm').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));
    for(let tries=0;tries<50 && w.document.getElementById('appScreen').classList.contains('hide');tries++)
      await new Promise(resolve=>setTimeout(resolve,10));
    await new Promise(resolve=>setTimeout(resolve,80));
    if(w.document.getElementById('appScreen').classList.contains('hide'))
      console.error('UI debug:',w.document.getElementById('message').textContent,calls.map(c=>c.path));
    assert.equal(w.document.getElementById('appScreen').classList.contains('hide'),false);
    assert.equal(w.document.getElementById('password').value,'');
    assert.ok(!String(w.localStorage.getItem('rafiq-test-web-config')).includes('secret-test-password'));
    assert.ok(calls.some(c=>c.path==='/auth/v1/token'));
    assert.ok(calls.every(c=>c.options.redirect==='error'&&c.options.credentials==='omit'));
    const request=calls.find(c=>c.path==='/rest/v1/rpc/rfq_pilot_request_device');
    assert.ok(request,'device registration missing');
    assert.equal(JSON.parse(request.options.body).p_kind,
      embedded?(role==='owner'?'owner_phone':'cashier_phone'):'web');
    assert.equal(w.document.getElementById('printInvoice').textContent.trim(),'طباعة الفاتورة');
    const deviceKey=`rafiq-test-device:v2:${embedded?'android':'browser'}:${USER}`;
    const deviceId=w.localStorage.getItem(deviceKey);
    assert.equal(deviceId,'33333333-3333-4333-8333-333333333333');
    w.crypto.randomUUID=()=> '44444444-4444-4444-8444-444444444444';
    assert.notEqual(w.loadDeviceId('55555555-5555-4555-8555-555555555555'),deviceId,
      'shared UI cannot reuse owner device approval for the worker account');
    assert.equal(w.localStorage.getItem(deviceKey),deviceId,'existing user keeps own device ID');
    w.printPage();
    assert.equal(nativePrint,embedded?1:0,'Android uses native print adapter only');
    assert.equal(browserPrint,embedded?0:1,'browser retains its normal print dialog');
    if(role==='worker'){
      assert.ok(w.document.getElementById('reportsView').classList.contains('hide'));
      assert.ok(w.document.getElementById('tabs').querySelector('[data-view="reports"]').classList.contains('hide'));
      assert.ok(w.document.getElementById('postSale').disabled,'worker cannot sell without owner-approved shift');
      if(!leaseAllowed)assert.ok(w.document.getElementById('devicePanel').textContent.includes('جلسة عامل أخرى'));
    }else{
      w.document.getElementById('tabs').querySelector('[data-view="reports"]').click();
      assert.equal(w.document.getElementById('reportsView').classList.contains('hide'),false);
      assert.ok(w.document.getElementById('reportCards').textContent.includes('مبيعات'));
      assert.ok(w.document.getElementById('posView').classList.contains('hide'));
    }
    console.log(`PASS ${embedded?'Android pilot':'web'} UI fake-${role}${leaseAllowed?'':'-busy'}: auth, device kind, role/shift gate.`);
  }finally{globalThis.fetch=oldFetch;w.close();}
}
await run('owner');
await run('worker');
await run('worker',false);
await run('owner',true,true);
await run('worker',true,true);
