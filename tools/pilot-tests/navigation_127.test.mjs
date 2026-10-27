// Regression tests using the shipped DOM and JS, with synthetic RPCs only.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import * as lib from '../../web-client/lib.mjs';
const read=p=>readFileSync(new URL(p,import.meta.url),'utf8');
const html=read('../../web-client/index.html');
const js=read('../../web-client/web.js').replace(/^import \{([^\n]+)\} from '\.\/lib\.mjs';/,'var {$1}=window.RafiqLib;').replace('const state={','var state={');
const old='66666666-6666-4666-8666-666666666666',current='66666666-6666-4666-8666-666666666667';
const wait=()=>new Promise(r=>setImmediate(r));
function boot(){
 const dom=new JSDOM(html,{url:'https://rafiq.test/index.html',runScripts:'outside-only',pretendToBeVisual:true});
 const w=dom.window;w.RafiqLib=lib;w.fetch=()=>new Promise(()=>{});w.eval(js);
 w.eval(`state.role='owner';state.user={id:'owner'};state.store='store';state.device='${current}';state.products=[];state.customers=[];state.approved=false;state.lease=false;state.api={signedIn:true};`);
 w.__calls=[];
 w.eval(`state.api.rpc=async(name,args)=>{window.__calls.push({name,args});
   if(name==='rfq_pilot_claim_owner_seller')throw Error('owner_seller_device_or_session_denied');
   if(name==='rfq_pilot_suppliers_overview')return [];
   if(name==='rfq_pilot_request_device')return 'pending';
   if(name==='rfq_pilot_approve_device')throw Error('device_limit_reached');
   return null;};
 state.api.table=async(name,args)=>name==='rfq_pilot_stores'?[{id:'store',seat_limit:4}]:name==='rfq_pilot_devices'?[
 {id:'${current}',user_id:'owner',kind:'web',status:'pending',created_at:'2026-01-02T00:00:00Z'},
 {id:'${old}',user_id:'owner',kind:'web',status:'approved',created_at:'2026-01-01T00:00:00Z'},
 {id:'worker-device',user_id:'worker',kind:'cashier_phone',status:'approved',created_at:'2026-01-01T00:00:00Z'}]:[];`);
 return {w,close:()=>w.close()};
}
test('suppliers opens, closes drawer, and never remains over the next view',async()=>{
 const c=boot();try{const w=c.w,d=w.document;
  w.eval("openDrawer()");d.querySelector('#tabs [data-view=suppliers]').click();await wait();
  assert.equal(d.getElementById('tabs').classList.contains('open'),false);
  assert.equal(d.getElementById('suppliersView').classList.contains('hide'),false);
  assert.equal(d.getElementById('productsView').classList.contains('hide'),true);
  assert.equal(d.getElementById('pageTitle').textContent,'الموردون والمشتريات');
  assert.ok(w.__calls.some(c=>c.name==='rfq_pilot_suppliers_overview'));
  w.eval("setView('home')");assert.equal(d.getElementById('suppliersView').classList.contains('hide'),true);
 }finally{c.close();}
});
test('owner-sale closes drawer before an RPC finishes and preserves permissions on failure',async()=>{
 const c=boot();try{const w=c.w,d=w.document;
  w.eval("setView('home');openDrawer()");d.getElementById('ownerSellerNav').click();
  assert.equal(d.getElementById('tabs').classList.contains('open'),false);await wait();
  assert.equal(w.eval('state.sellerMode'),false);assert.equal(w.eval('state.role'),'owner');
  assert.equal(d.getElementById('message').hidden,false);
  assert.match(d.getElementById('message').textContent,/غير معتمد للبيع/);
  assert.equal(w.__calls.filter(c=>/post_invoice|open_owner_shift/.test(c.name)).length,0);
  assert.equal(d.getElementById('message').getAttribute('role'),'alert');
 }finally{c.close();}
});
test('successful owner-sale enters POS as owner without opening a shift or posting a sale',async()=>{
 const c=boot();try{const w=c.w,d=w.document;
  w.eval(`state.api.rpc=async(name,args)=>{window.__calls.push({name,args});return name==='rfq_pilot_claim_owner_seller'?'2027-01-01':null;};openDrawer();`);
  d.getElementById('ownerSellerNav').click();await wait();
  assert.equal(w.eval('state.sellerMode'),true);assert.equal(w.eval('state.role'),'owner');
  assert.equal(d.getElementById('posView').classList.contains('hide'),false);
  assert.equal(d.getElementById('tabs').classList.contains('open'),false);
  assert.equal(w.__calls.filter(c=>/post_invoice|open_owner_shift/.test(c.name)).length,0);
 }finally{c.close();}
});
test('all declared nav targets exist and worker cannot enter monitoring/reports',async()=>{
 const c=boot();try{const w=c.w,d=w.document;
  for(const b of d.querySelectorAll('[data-view]')){
   assert.ok(d.getElementById(b.dataset.view+'View'),b.dataset.view);
   if(b.dataset.view==='pos')continue;
   w.eval(`setView('${b.dataset.view}')`);await wait();assert.equal(w.eval('state.view'),b.dataset.view);
  }
  w.eval("state.role='worker';setView('customers');setView('reports')");assert.equal(w.eval('state.view'),'customers');
  w.eval("setView('monitor')");assert.equal(w.eval('state.view'),'customers');
 }finally{c.close();}
});
test('mobile list-first layout preserves forms and opens folded add forms from shortcuts',()=>{
 const c=boot();try{const w=c.w,d=w.document;
  const productForm=d.getElementById('productForm'),detail=productForm.closest('details');assert.ok(detail);assert.equal(detail.open,false);
  const view=d.getElementById('productsView'),cards=[...view.querySelectorAll(':scope > .card')];assert.ok(cards[0].contains(d.getElementById('catalogList')));
  w.eval("goTo('products','productName')");assert.equal(detail.open,true);
  for(const form of ['productForm','supplierForm','purchaseForm','supplierPayForm','supplierReturnForm','customerForm'])assert.ok(d.getElementById(form));
 }finally{c.close();}
});
test('full device limit no longer aborts owner registration; transfer requires explicit choice and consent',async()=>{
 const c=boot();try{const w=c.w,d=w.document;
  await w.eval('requestDevice()');await wait();
  assert.equal(w.eval('state.approved'),false);assert.equal(w.eval('state.deviceLimit'),true);
  assert.equal(d.getElementById('deviceNotice').hidden,false);
  const select=d.getElementById('replaceDeviceSelect'),agree=d.getElementById('replaceDeviceConsent'),b=d.getElementById('replaceDeviceSubmit');
  assert.ok(select);assert.ok(agree);assert.ok(b.disabled);
  assert.equal(select.options.length,2,'only the old same-account same-kind owner device is eligible');
  select.value=old;select.dispatchEvent(new w.Event('change'));assert.ok(b.disabled);
  agree.checked=true;agree.dispatchEvent(new w.Event('change'));assert.equal(b.disabled,false);
  assert.equal(w.__calls.filter(c=>c.name==='rfq_pilot_replace_own_device').length,0,'never replaces automatically');
 }finally{c.close();}
});
test('supplier errors have retry instead of a silently empty page',async()=>{
 const c=boot();try{const w=c.w,d=w.document;
  w.eval("state.api.rpc=async()=>{throw Error('synthetic supplier error')};state.view='suppliers'");await w.eval('loadSuppliers()');
  assert.match(d.getElementById('supplierList').textContent,/تعذّر تحميل الموردين/);
  assert.ok(d.getElementById('supplierList').querySelector('button'));
 }finally{c.close();}
});
