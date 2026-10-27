import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {readFileSync} from 'node:fs';
import * as lib from '../../web-client/lib.mjs';

const html=readFileSync(new URL('../../web-client/index.html',import.meta.url),'utf8');
const js=readFileSync(new URL('../../web-client/web.js',import.meta.url),'utf8')
  .replace(/^import \{([^\n]+)\} from '\.\/lib\.mjs';/,
    'var {$1}=window.RafiqLib;')
  .replace('const state={','var state={');
const css=readFileSync(new URL('../../web-client/web.css',import.meta.url),'utf8');

function boot({online=false}={}){
  const dom=new JSDOM(html,{url:'https://appassets.androidplatform.net/assets/pilot/index.html',
    runScripts:'outside-only',pretendToBeVisual:true});
  const w=dom.window,ops=new Map(),rpcs=[];
  w.RafiqLib=lib;w.crypto.randomUUID=()=> '44444444-4444-4444-8444-444444444444';
  Object.defineProperty(w.navigator,'onLine',{configurable:true,get:()=>online});
  // Keep the startup config request pending: these isolated DOM checks do not
  // boot authentication, and a response after closing JSDOM would be spurious.
  w.fetch=()=>new Promise(()=>{});
  w.NativeApi={
    beginPilotDemoReset:()=>'{"ok":true,"clear_web":true}',
    finishPilotDemoReset:()=>'{"ok":true}',
    ofxAdd:(raw)=>{const p=JSON.parse(raw);ops.set(p.id,{...p,status:'queued'});return '{"ok":true}';},
    ofxList:()=>JSON.stringify([...ops.values()]),
    ofxQueued:()=>JSON.stringify([...ops.values()].filter(x=>x.status==='queued')),
    ofxGet:id=>JSON.stringify(ops.get(id)||null),
    ofxQueuedCount:()=>String([...ops.values()].filter(x=>x.status==='queued').length),
    mirrorGet:()=> '[]',metaGet:()=>'',metaSet:()=>'{"ok":true}',
  };
  w.eval(js);
  w.eval(`state.store='11111111-1111-4111-8111-111111111111';
    state.user={id:'owner-1',email:'owner@test.invalid'};
    state.role='owner';state.approved=true;state.lease=false;
    state.api={signedIn:true,rpc:async(name)=>{throw Error('unexpected network '+name)}};`);
  return {w,ops,rpcs,close:()=>w.close()};
}

const product={id:'product-one',name:'شاي رفيق',barcode:'1234567890123',
  price_cents:1500,stock_milli:12000,unit:'حبة',active:true};

test('مداخل رفيق الأساسية مكان واجهة Pilot، دون أرشيف ظاهر أو عناصر مكررة',()=>{
  const ctx=boot();try{
    const d=ctx.w.document,ids=[...d.querySelectorAll('[id]')].map(x=>x.id);
    assert.equal(new Set(ids).size,ids.length);
    assert.deepEqual([...d.querySelectorAll('#tabs button')].map(x=>x.dataset.view).filter(Boolean),
      ['home','monitor','pos','customers','suppliers','products','shifts','reports','settings']);
    assert.equal(d.getElementById('openArchive').classList.contains('hide'),true);
    assert.equal(d.getElementById('devicePanel').closest('#settingsView')!==null,true);
    assert.match(css,/#tabs\.rafiq-drawer\{position:sticky;top:72px/);
    assert.match(css,/\.topbar-meta\{display:flex/);
    assert.equal(d.getElementById('stockAdjustmentForm').closest('#productsView')!==null,true);
    assert.equal(d.getElementById('ownerDebtForm').closest('#customersView')!==null,true);
    assert.equal(d.getElementById('ownerCashForm').closest('#shiftsView')!==null,true);
  }finally{ctx.close();}
});

test('شاشة المالك تخفي البيع والعامل يفتح البيع ولا يرى التقارير؛ لا تجاوز من JS',()=>{
  const ctx=boot();try{
    const w=ctx.w,d=w.document;
    w.eval(`setView('products')`);
    assert.equal(d.getElementById('productsView').classList.contains('hide'),false);
    w.eval(`setView('pos')`);
    assert.equal(d.getElementById('posView').classList.contains('hide'),true);
    w.eval(`state.role='worker';setView('pos');updateSaleButtons()`);
    assert.equal(d.getElementById('posView').classList.contains('hide'),false);
    assert.match(d.getElementById('posGate').textContent,/اعتماد|جلسة|صندوق/);
    w.eval(`setView('reports')`);
    assert.equal(d.getElementById('reportsView').classList.contains('hide'),true);
  }finally{ctx.close();}
});

test('الباركود يختار الصنف فقط ولا ينشئ فاتورة أو سطر بيع',()=>{
  const ctx=boot();try{
    const w=ctx.w,d=w.document;
    w.eval(`state.products=[${JSON.stringify(product)}];state.role='worker';renderProducts()`);
    w.__rafiqPilotBarcode('1234567890123');
    assert.equal(d.getElementById('saleProduct').value,'product-one');
    assert.equal(w.eval('state.cart.length'),0);
    assert.equal(ctx.ops.size,0);
    w.__rafiqPilotBarcode('1234567890123\";<script>alert(1)</script>');
    assert.equal(w.eval('state.cart.length'),0);
  }finally{ctx.close();}
});

test('تزويد مخزون دون نت يُكتب مرة في طابور المتجر، بلا طلب شبكة ولا رصيد مؤكد',async()=>{
  const ctx=boot();try{
    const w=ctx.w,d=w.document;
    w.eval(`state.products=[${JSON.stringify(product)}];renderProducts()`);
    d.getElementById('adjustProduct').value='product-one';
    d.getElementById('stockQty').value='2.5';
    d.getElementById('stockReason').value='تزويد مخزن';
    d.getElementById('stockAdjustmentForm').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));
    for(let i=0;i<20&&!ctx.ops.size;i++)await new Promise(r=>setTimeout(r,5));
    assert.equal(ctx.ops.size,1);
    const [record]=[...ctx.ops.values()];const payload=JSON.parse(record.payload);
    assert.equal(record.kind,'stock_adjust');
    assert.equal(payload.p_delta_milli,2500);
    assert.equal(payload._store,'11111111-1111-4111-8111-111111111111');
    assert.match(d.getElementById('message').textContent,/بانتظار المزامنة/);
    assert.ok(!d.getElementById('message').textContent.includes('أقر الخادم'));
  }finally{ctx.close();}
});

test('الدين دون اتصال لا يعرض صفراً كأنه رصيد مؤكد',async()=>{
  const ctx=boot();try{
    await ctx.w.eval(`showCustomerBalance({id:'customer-1',name:'زبون رفيق'})`);
    const text=ctx.w.document.getElementById('customerBalancePanel').textContent;
    assert.match(text,/لا يمكن تأكيد رصيد الدين دون اتصال/);
    assert.doesNotMatch(text,/الرصيد المؤكد/);
  }finally{ctx.close();}
});
