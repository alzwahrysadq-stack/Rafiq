// Reproduce the phone's owner-lease expiry, then exercise recovery on shipped DOM/JS.
// All sessions, stock, invoices and bridge writes here are synthetic and isolated.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import * as lib from '../../web-client/lib.mjs';
const read=p=>readFileSync(new URL(p,import.meta.url),'utf8');
const html=read('../../web-client/index.html');
const source=read(process.env.RAFIQ_WEBJS||'../../web-client/web.js').replace(/^import \{([^\n]+)\} from '\.\/lib\.mjs';/,'var {$1}=window.RafiqLib;').replace('const state={','var state={');
const tick=()=>new Promise(r=>setImmediate(r));
const SHIFT='77777777-7777-4777-8777-777777777777',PRODUCT='88888888-8888-4888-8888-888888888888';
async function boot({embedded=false}={}){
 const dom=new JSDOM(html,{url:embedded?'https://appassets.androidplatform.net/assets/pilot/index.html':'https://rafiq.test/index.html',runScripts:'outside-only',pretendToBeVisual:true});
 const w=dom.window,d=w.document,calls=[],ops=new Map(),invoices=new Map(),meta=new Map();
 const server={live:false,approved:true,blocked:false,shift:SHIFT,transient:false,delay:null,stock:80000,reads:0};
 let online=true;
 Object.defineProperty(w.navigator,'onLine',{get:()=>online,configurable:true});
 w.RafiqLib=lib;w.fetch=()=>new Promise(()=>{});
 w.crypto.randomUUID=()=> '99999999-9999-4999-8999-999999999999';
 const bridge={
  beginPilotDemoReset:()=>'{"ok":true,"clear_web":false}',finishPilotDemoReset:()=>'{"ok":true}',
  ofxAdd:json=>{const o=JSON.parse(json);if(!ops.has(o.id))ops.set(o.id,{...o,status:'queued'});return '{"ok":true}';},
  ofxQueued:()=>JSON.stringify([...ops.values()].filter(o=>o.status==='queued')),ofxList:()=>JSON.stringify([...ops.values()]),ofxReview:()=>JSON.stringify([...ops.values()].filter(o=>o.status==='conflict')),
  ofxGet:id=>JSON.stringify(ops.get(id)||null),ofxSettle:(id,status,ref,note)=>{Object.assign(ops.get(id),{status,serverRef:ref,note});return '{"ok":true}';},
  metaGet:k=>meta.get(k)||'',metaSet:(k,v)=>{meta.set(k,v);return '{"ok":true}';},mirrorGet:()=> '[]',mirrorPut:()=>'{"ok":true}',
 };
 if(embedded)w.NativeApi=bridge;
 w.eval(source);await tick();
 w.eval(`state.user={id:'owner'};state.store='store';state.role='owner';state.device='phone';state.sellerMode=true;state.approved=true;state.lease=true;state.shift='${SHIFT}';state.view='pos';state.products=[{id:'${PRODUCT}',name:'Tea',price_cents:88000,stock_milli:80000,active:true}];state.customers=[];state.api={signedIn:true};`);
 const err=(msg,status=400)=>Object.assign(new Error(msg),{status});
 w.state.api.rpc=async(name,args)=>{
  calls.push({name,args});
  if(/heartbeat|claim_owner_seller/.test(name)&&server.transient)throw err('synthetic outage',503);
  if(name==='rfq_pilot_heartbeat'){if(!server.live)throw err('worker_session_expired');return '2027-01-01';}
  if(name==='rfq_pilot_claim_worker')throw err('worker_device_or_session_denied');
  if(name==='rfq_pilot_claim_owner_seller'){
   if(server.delay)await server.delay;
   if(server.blocked||!server.approved)throw err('owner_seller_device_or_session_denied');
   server.live=true;return '2027-01-01';
  }
  if(name==='rfq_pilot_my_open_shift'){server.reads++;return server.live?server.shift:null;}
  if(name==='rfq_pilot_license_current')return true;
  if(name==='rfq_pilot_owner_product_costs')return [{id:PRODUCT,cost_cents:60000}];
  if(name==='rfq_pilot_owner_summary')return {};
  if(name==='rfq_pilot_owner_monitor')return null;
  if(/suppliers_overview|demand_list/.test(name))return [];
  if(/post_invoice_guarded|post_invoice_v3/.test(name)){
   if(!server.live)throw err('worker_session_expired');assert.equal(args.p_shift,SHIFT);
   const prev=invoices.get(args.p_invoice);if(prev)return {...prev,already_committed:true};
   const invoice={invoice_id:args.p_invoice,number:41,total_cents:88000,cash_paid_cents:88000,due_cents:0};invoices.set(args.p_invoice,invoice);server.stock-=1000;return invoice;
  }
  if(name==='rfq_pilot_open_owner_shift')throw Error('MUST NOT OPEN ANOTHER SHIFT');
  return null;
 };
 w.state.api.table=async(name,q)=>{
  if(name==='rfq_pilot_devices')return [{id:'phone',user_id:'owner',status:server.approved?'approved':'revoked',kind:embedded?'owner_phone':'web'}];
  if(name==='rfq_pilot_stores')return [{id:'store',name:'Synthetic',seat_limit:4}];
  if(name==='rfq_pilot_products')return [{id:PRODUCT,name:'Tea',price_cents:88000,stock_milli:server.stock,active:true}];
  if(name==='rfq_pilot_invoice_lines')return [{invoice_id:'99999999-9999-4999-8999-999999999999',product_id:PRODUCT,name_snapshot:'Tea',price_cents:88000,qty_milli:1000}];
  return [];
 };
 w.eval("screen('app');updateSellerBar();updateSaleButtons()");
 const cart=()=>{w.eval(`state.cart=[{product_id:'${PRODUCT}',name:'Tea',price_cents:88000,qty_milli:1000}];renderCart()`);d.getElementById('cashPaid').value='880';w.renderCart();};
 return {w,d,server,calls,ops,invoices,cart,offline:v=>{online=!v;},close:async()=>{await tick();await tick();w.close();}};
}
function noWorkerOrNewShift(c){assert.equal(c.calls.filter(x=>/claim_worker|open_owner_shift/.test(x.name)).length,0);}
test('128: expiry during periodic refresh reclaims owner, restores SAME shift, preserves cart and paid cash',async()=>{
 const c=await boot();try{
  c.cart();await c.w.refresh();
  assert.equal(c.w.state.lease,true);assert.equal(c.w.state.shift,SHIFT);assert.equal(c.w.state.sellerMode,true);
  assert.match(c.d.getElementById('ownerSellerState').textContent,/مفتوحة الآن/);
  assert.equal(c.w.state.cart.length,1);assert.equal(c.d.getElementById('cashPaid').value,'880');
  assert.equal(c.d.getElementById('postSale').disabled,false);noWorkerOrNewShift(c);assert.equal(c.invoices.size,0);
 }finally{await c.close();}
});
test('128: lost local lease and shift recover from server without opening another shift',async()=>{
 const c=await boot();try{c.w.state.lease=false;c.w.state.shift=null;await c.w.refresh();assert.equal(c.w.state.shift,SHIFT);assert.equal(c.w.state.lease,true);noWorkerOrNewShift(c);}finally{await c.close();}
});
test('128: visibility/focus/pageshow resumes owner session even after background expiry',async()=>{
 const c=await boot();try{
  c.w.state.lease=false;c.w.document.dispatchEvent(new c.w.Event('visibilitychange'));c.w.dispatchEvent(new c.w.Event('focus'));c.w.dispatchEvent(new c.w.Event('pageshow'));
  for(let i=0;i<8;i++)await tick();
  assert.equal(c.w.state.lease,true);assert.equal(c.w.state.shift,SHIFT);noWorkerOrNewShift(c);
 }finally{await c.close();}
});
test('128: save preflight recovers expired owner lease and commits synthetic cash invoice once',async()=>{
 const c=await boot();try{c.cart();await c.w.submitSaleOnce();assert.equal(c.invoices.size,1);assert.equal(c.server.stock,79000);assert.equal(c.w.state.cart.length,0);assert.match(c.d.getElementById('latestInvoice').textContent,/41/);noWorkerOrNewShift(c);}finally{await c.close();}
});
test('128: APK queue replay restores session before sending and remains idempotent',async()=>{
 const c=await boot({embedded:true});try{
  c.cart();await c.w.submitSaleOnce();await c.w.syncAll();await c.w.syncAll();
  assert.equal(c.invoices.size,1);assert.equal(c.server.stock,79000);assert.equal(c.ops.size,1);
  assert.equal([...c.ops.values()][0].status,'confirmed');assert.equal(c.w.state.invoice.provisional,undefined);
  const send=c.calls.findIndex(x=>x.name==='rfq_pilot_post_invoice_v3'),claim=c.calls.findIndex(x=>x.name==='rfq_pilot_claim_owner_seller');assert.ok(claim>=0&&claim<send);
  noWorkerOrNewShift(c);
 }finally{await c.close();}
});
test('128: transient outage keeps existing shift/cart, blocks online save, never invents closed shift',async()=>{
 const c=await boot();try{
  c.cart();c.server.transient=true;await c.w.refresh();
  assert.equal(c.w.state.shift,SHIFT);assert.equal(c.w.state.cart.length,1);
  assert.doesNotMatch(c.d.getElementById('ownerSellerState').textContent,/لا توجد وردية/);
  assert.equal(c.d.getElementById('ownerSellerOpen').querySelector('input'),null);
  await assert.rejects(()=>c.w.submitSaleOnce());assert.equal(c.invoices.size,0);assert.equal(c.ops.size,0);noWorkerOrNewShift(c);
  c.server.transient=false;await c.w.refresh();assert.equal(c.d.getElementById('postSale').disabled,false);assert.equal(c.d.getElementById('message').hidden,true);
 }finally{await c.close();}
});
test('128: denied/revoked owner session cannot post; known shift is not claimed closed',async()=>{
 const c=await boot();try{
  c.cart();c.server.blocked=true;await c.w.refresh();assert.equal(c.w.state.lease,false);assert.equal(c.w.state.shift,SHIFT);
  assert.equal(c.d.getElementById('postSale').disabled,true);assert.equal(c.d.getElementById('ownerSellerOpen').querySelector('input'),null);
  await assert.rejects(()=>c.w.submitSaleOnce());assert.equal(c.invoices.size,0);assert.equal(c.ops.size,0);noWorkerOrNewShift(c);
 }finally{await c.close();}
});
test('128: simultaneous recoveries have one owner claim; logout cannot be undone by stale RPC response',async()=>{
 const c=await boot();try{
  let done;c.server.delay=new Promise(r=>{done=r;});
  const a=c.w.ensureOwnerSellerSession(),b=c.w.ensureOwnerSellerSession();await tick();
  assert.equal(c.calls.filter(x=>x.name==='rfq_pilot_claim_owner_seller').length,1);
  c.w.state.user=null;c.w.state.store=null;c.w.state.role=null;c.w.state.sellerMode=false;c.w.state.lease=false;c.w.state.shift=null;
  done();await Promise.allSettled([a,b]);assert.equal(c.w.state.lease,false);assert.equal(c.w.state.shift,null);assert.equal(c.w.state.sellerMode,false);
 }finally{await c.close();}
});
test('128: successful authoritative no-open-shift clears stale ID and alone offers opening form',async()=>{
 const c=await boot();try{c.server.shift=null;await c.w.refresh();assert.equal(c.w.state.shift,null);assert.ok(c.d.getElementById('ownerSellerOpen').querySelector('input'));assert.equal(c.invoices.size,0);noWorkerOrNewShift(c);}finally{await c.close();}
});
test('128: owner lease is never claimed merely for dashboard access or in read-only licence mode',async()=>{
 const c=await boot();try{c.w.state.sellerMode=false;await c.w.refresh();assert.equal(c.calls.filter(x=>x.name==='rfq_pilot_claim_owner_seller').length,0);c.w.state.sellerMode=true;c.w.state.readOnly=true;await assert.rejects(()=>c.w.ensureOwnerSellerSession());assert.equal(c.calls.filter(x=>x.name==='rfq_pilot_claim_owner_seller').length,0);}finally{await c.close();}
});
test('128: UI does not label an empty last-invoice section or save button as a successful invoice',async()=>{
 const c=await boot();try{assert.doesNotMatch(c.d.getElementById('postSaleSticky').textContent,/✓/);assert.match(c.d.getElementById('latestInvoice').textContent,/لا يوجد|لم تُحفظ|لم تحفظ/);}finally{await c.close();}
});
test('128: a revoked physical device cannot reclaim or stage a sale',async()=>{
 const c=await boot();try{c.cart();c.server.approved=false;await c.w.refresh();assert.equal(c.w.state.approved,false);assert.equal(c.w.state.lease,false);await assert.rejects(()=>c.w.submitSaleOnce());assert.equal(c.invoices.size,0);assert.equal(c.ops.size,0);noWorkerOrNewShift(c);}finally{await c.close();}
});
test('128: established owner offline sale stays provisional, resumes with same id, and restores receipt for owner',async()=>{
 const c=await boot({embedded:true});try{
  c.cart();c.offline(true);await c.w.submitSaleOnce();assert.equal(c.invoices.size,0);assert.equal(c.ops.size,1);assert.equal(c.w.state.invoice.provisional,true);
  const id=[...c.ops.keys()][0];c.w.state.invoice=null;c.w.restoreQueuedSale();assert.equal(c.w.state.invoice.localId,id);assert.equal(c.w.state.invoice.provisional,true);
  c.offline(false);await c.w.syncAll();await c.w.syncAll();assert.equal(c.invoices.size,1);assert.equal([...c.ops.keys()][0],id);assert.equal(c.ops.get(id).status,'confirmed');assert.equal(c.server.stock,79000);noWorkerOrNewShift(c);
 }finally{await c.close();}
});
test('128: a server-confirmed closed shift prevents staging a new invoice even with a stale local ID',async()=>{
 const c=await boot({embedded:true});try{c.cart();c.server.shift=null;await assert.rejects(()=>c.w.submitSaleOnce(),/ورد/);assert.equal(c.ops.size,0);assert.equal(c.invoices.size,0);assert.equal(c.w.state.cart.length,1);noWorkerOrNewShift(c);}finally{await c.close();}
});
test('128: form double-click during recovery cannot allocate or commit a duplicate invoice',async()=>{
 const c=await boot({embedded:true});try{
  c.cart();c.w.renderProducts();c.d.getElementById('saleProduct').value=PRODUCT;const button=c.d.getElementById('postSale');button.click();button.click();
  for(let i=0;i<12;i++)await tick();
  assert.equal(c.ops.size,1);assert.equal(c.invoices.size,1);assert.equal(c.server.stock,79000);noWorkerOrNewShift(c);
 }finally{await c.close();}
});
