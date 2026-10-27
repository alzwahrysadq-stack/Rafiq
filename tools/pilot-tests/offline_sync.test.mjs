// 6أ/6ج + مراجعتا المالك: طابور بتحقق حفظ، مستند مؤقت بمبالغ صحيحة، دفع بلا تكرار وبلا حد 100،
// تعارض صريح بلا حذف، وردية محلية مؤقتة بحفظ ذري وربط موثّق بطلبها ومعالجة رفض المالك،
// فتح التطبيق دون نت، عزل متجرين صارم، سحب متعدد الصفحات بمراس مركب وعمود بديل، وحارس مزامنة واحد.
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
// الجولة 7: تحميل lib.mjs ديناميكيًا — متغير RAFIQ_LIB يتيح اختبار «قبل الإصلاح» على نسخة lib المحفوظة.
const lib = await import(process.env.RAFIQ_LIB || '../../web-client/lib.mjs');

const html = readFileSync(new URL('../../web-client/index.html', import.meta.url), 'utf8');
const source = readFileSync(new URL(process.env.RAFIQ_WEBJS || '../../web-client/web.js', import.meta.url), 'utf8')
  .replace(/^import \{([^\n]+)\} from '\.\/lib\.mjs';/, 'const {$1}=window.RafiqLib;');
// jsdom/vm: روابط const العلوية لا تعبر بين استدعاءَي eval — نحوّلها للاختبار فقط.
const testSource = source
  .replace(/const \{([^}]+)\}=window\.RafiqLib;/,
           'var {$1}=window.RafiqLib;')
  .replace('const state={', 'var state={');

const STORE = '11111111-1111-4111-8111-111111111111';
const STORE_B = '22222222-2222-4222-8222-222222222222';
const KEY = `sb_publishable_${'A'.repeat(30)}`;
const URL0 = 'https://syntheticprojectref.supabase.co';
const LOCAL_SHIFT = `55555555-5555-4555-8555-555555555555`;

function makeBridge(listLimit = 0) {
  const ops = new Map(); const mirror = new Map(); const meta = new Map();
  let resetPrepared=false,resetFinished=false;
  return {
    ops, mirror, meta,
    beginPilotDemoReset: () => {
      if(resetFinished)return JSON.stringify({ok:true,clear_web:false});
      ops.clear();mirror.clear();meta.clear();resetPrepared=true;
      return JSON.stringify({ok:true,clear_web:true});
    },
    finishPilotDemoReset: () => {
      if(!resetPrepared&&!resetFinished)return JSON.stringify({ok:false});
      resetFinished=true;resetPrepared=false;return JSON.stringify({ok:true});
    },
    ofxAdd: (json) => { const o = JSON.parse(json); if (!ops.has(o.id)) ops.set(o.id, { ...o, status: 'queued', attempts: 0, serverRef: '', note: '' }); return '{"ok":true}'; },
    // قائمة العرض محدودة (كما في الهاتف: آخر 100) — لاختبار أن المحرك لا يعتمد عليها.
    ofxList: () => JSON.stringify(listLimit ? [...ops.values()].slice(-listLimit) : [...ops.values()]),
    ofxGet: (id) => JSON.stringify(ops.get(id)||null), // by id, never subject to the display cap
    ofxQueued: () => JSON.stringify([...ops.values()].filter(o => o.status === 'queued').sort((a, b) => String(a.queuedAt || '').localeCompare(String(b.queuedAt || '')))), // كالجسر الحقيقي: ترتيب زمني
    ofxReview: () => JSON.stringify([...ops.values()].filter(o => ['conflict', 'sent_awaiting_owner', 'cancelled_by_owner'].includes(o.status))),
    ofxQueuedCount: () => String([...ops.values()].filter(o => o.status === 'queued').length),
    ofxSettle: (id, status, ref, note) => { const o = ops.get(id); if (o) Object.assign(o, { status, serverRef: ref, note, attempts: o.attempts + 1 }); return '{"ok":true}'; },
    mirrorPut: (json) => { for (const r of JSON.parse(json)) mirror.set(`${r.tbl}:${r.id}`, r); return '{"ok":true}'; },
    mirrorGet: (tbl) => JSON.stringify([...mirror.values()].filter(r => r.tbl === tbl)),
    metaGet: (k) => meta.get(k) || '',
    metaSet: (k, v) => { meta.set(k, v); return '{"ok":true}'; },
  };
}

// محاكاة or=(col.gt.TS,and(col.eq.TS,id.gt.ID)) — المراس المركب
function applyOr(rows, params) {
  const or = params.or; if (!or) return rows;
  const m = String(or).match(/^\((\w+)\.gt\.([^,]+)(?:,and\(\w+\.eq\.[^,]+,id\.gt\.([^)]+)\))?\)$/);
  if (!m) return rows;
  const [, col, ts, idp] = m;
  return rows.filter(r => String(r[col]) > ts || (String(r[col]) === ts && idp && String(r.id) > idp));
}

async function boot({ online, rpc, tables, listLimit = 0, noState = false, embedded = false, configStatus = 200, sharedBridge = null }) {
  // الجولة 9: embedded = وضع الهاتف (عنوان الصفحة الموحدة داخل WebView)، وconfigStatus = 404
  // يحاكي إقلاعًا بلا إعداد سحابي محفوظ (وضع التهيئة من الشاشة الموحدة نفسها).
  const dom = new JSDOM(html, { url: embedded ? 'https://appassets.androidplatform.net/assets/pilot/index.html' : 'https://rafiq.test/index.html', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  w.RafiqLib = lib;
  w.crypto.randomUUID = () => '44444444-4444-4444-8444-444444444444';
  // حزمة الإطلاق: الأجهزة المفعّلة مسبقًا (بوابة التفعيل تُختبر في launch_package.test.mjs)
  w.localStorage.setItem('rafiq-test-device:v2:android:launch-act',JSON.stringify({until:'2099-01-01T00:00:00Z',mode:'both',months:63,type:2}));
  w.localStorage.setItem('rafiq-test-device:v2:android:launch-mode','online');
  const bridge = sharedBridge || makeBridge(listLimit);
  w.NativeApi = bridge;
  const calls = [];
  const bodies = [];
  const stub = async (url, options) => {
    const path = String(url);
    if (options && options.body) bodies.push({ path, body: options.body });
    if (path === '/rafiq-config') return configStatus === 200
      ? { ok: true, status: 200, json: async () => ({ url: URL0, key: KEY }), text: async () => '{}', headers: { get: () => null } }
      : { ok: false, status: configStatus, json: async () => ({}), text: async () => '{}', headers: { get: () => null } };
    if (!online()) throw Object.assign(new TypeError('Failed to fetch'), { message: 'Failed to fetch' });
    const m = path.match(/\/rpc\/(rfq_pilot_[a-z0-9_]+)/);
    if (m) { calls.push(m[1]); const r = rpc(m[1], calls.filter(c => c === m[1]).length, options.body ? JSON.parse(options.body) : null); return { ok: r.status < 400, status: r.status, text: async () => JSON.stringify(r.data), json: async () => r.data, headers: { get: (h) => h === 'Date' ? 'Wed, 01 Jan 2026 00:00:00 GMT' : null } }; }
    const t = path.match(/\/rest\/v1\/rfq_pilot_(\w+)/);
    if (t && tables) {
      const params = Object.fromEntries(new URL(path).searchParams);
      calls.push('table:' + t[1]);
      const r = tables(t[1], params);
      return { ok: r.status ? r.status < 400 : true, status: r.status || 200, text: async () => JSON.stringify(r.data !== undefined ? r.data : r.rows !== undefined ? r.rows : r), json: async () => (r.data !== undefined ? r.data : r.rows !== undefined ? r.rows : r), headers: { get: (h) => h === 'Date' ? 'Wed, 01 Jan 2026 00:00:00 GMT' : null } };
    }
    return { ok: true, status: 200, text: async () => '[]', json: async () => [], headers: { get: () => null } };
  };
  w.fetch = stub;
  const oldGlobalFetch = globalThis.fetch;
  globalThis.fetch = stub;
  const close = () => { globalThis.fetch = oldGlobalFetch; w.close(); };
  Object.defineProperty(w.navigator, 'onLine', { get: () => online(), configurable: true });
  try { w.eval(testSource); } catch (e) { close(); throw e; }
  // The Android boot asynchronously reads its saved PUBLIC project config.
  // Wait for that local read before injecting a fake signed-in test session,
  // or the config callback overwrites the fake PilotApi with an unsigned one.
  if (embedded) await new Promise(done => setImmediate(done));
  if (!noState) try {
    w.eval(`state.api=new PilotApi('${URL0}','${KEY}');state.api.access='t';state.api.expiresAt=Date.now()+3600000;`);
    w.eval(`state.store='${STORE}';state.role='worker';state.lease=true;state.approved=true;state.device='d1';state.user={id:'u1'};`);
  } catch (e) { close(); throw e; }
  return { w, bridge, calls, bodies, close };
}

const SALE = `setPending({id:'inv-1',payload:{p_shift:'s',p_device:'d1',p_invoice:'inv-1',p_customer:null,p_lines:[{product_id:'p',qty_milli:1000}],p_cash_cents:100,p_sms_consent:false},snapshot:[{product_id:'p',name:'Tea',price_cents:100,qty_milli:1000}]});`;
const matchingSaleLines = (tbl,params) => tbl==='invoice_lines'
  ? [{invoice_id:String(params.invoice_id||'').slice(3),product_id:'p',name_snapshot:'Tea',price_cents:100,qty_milli:1000}]
  : [];
const TEST_SNAPSHOT=[{product_id:'p',name:'Tea',price_cents:100,qty_milli:1000}];
function testInvoicePayload(id,shift='s',paid=100,price=100){
  return {p_shift:shift,p_device:'d1',p_invoice:id,p_customer:null,
    p_lines:[{product_id:'p',qty_milli:1000}],p_cash_cents:paid,p_sms_consent:false,
    _snapshot:[{...TEST_SNAPSHOT[0],price_cents:price}]};
}
function mockInvoiceAck(payload,number,extra={}){
  const lines=payload.p_lines.map(l=>({invoice_id:payload.p_invoice,
    product_id:l.product_id,name_snapshot:l.expected_name,
    price_cents:l.expected_price_cents,qty_milli:l.qty_milli}));
  const total=lines.reduce((sum,l)=>sum+Math.round(l.price_cents*l.qty_milli/1000),0);
  return {invoice_id:payload.p_invoice,number,total_cents:total,
    due_cents:total-payload.p_cash_cents,lines,...extra};
}
const SETUP_LOCAL_SHIFT = `(function(){
  const b=bridge();
  const ls={id:'${LOCAL_SHIFT}',opening_cents:50000,opened_at:'2026-01-01T00:00:00Z',anchor:'',closing:false};
  ofxQueue('shift_open',{p_store:state.store,p_device:state.device,_local:ls},'shift_open:${LOCAL_SHIFT}');
  try{b.metaSet('local_shift:'+state.store,JSON.stringify(ls));}catch(e){}
  state.localShift=ls;
})();`;

test('دون اتصال: البيع يُحفظ على الهاتف كمستند مؤقت ولا يُعرض مؤكدًا من الخادم', async () => {
  const ctx = await boot({ online: () => false, rpc: () => ({ status: 200, data: { number: 7 } }) });
  try {
    ctx.w.eval(SALE);
    await ctx.w.eval('submitPending()');
    assert.equal(ctx.bridge.ops.get('inv-1').status, 'queued');
    assert.equal(ctx.calls.length, 0, 'لا استدعاء خادم دون اتصال');
    const badge = ctx.w.eval(`provisionalBadge('queued')`);
    assert.match(badge, /بانتظار المزامنة/);
    assert.match(badge, /مستند مؤقت/);
  } finally { ctx.close(); }
});

test('لا يُعرض نجاح البيع إلا بعد التأكد من حفظه على الهاتف', async () => {
  const ctx = await boot({ online: () => false, rpc: () => ({ status: 200, data: {} }) });
  try {
    ctx.w.eval(SALE);
    ctx.bridge.ofxAdd = () => '{"ok":false}'; // محاكاة فشل الكتابة في قاعدة الهاتف
    ctx.bridge.ofxQueued = () => '[]';
    await assert.rejects(() => ctx.w.eval('submitPending()'), /تعذر حفظ العملية على الهاتف/);
    assert.ok(ctx.w.eval('!!getPending()'), 'العملية المعلّقة باقية — لم تُعرض كمنجزة');
  } finally { ctx.close(); }
});

test('مبلغ الفاتورة المؤقتة ودينها صحيحان', async () => {
  const ctx = await boot({ online: () => false, rpc: () => ({ status: 200, data: {} }) });
  try {
    ctx.w.eval(`setPending({id:'inv-7',payload:{p_shift:'s',p_device:'d1',p_invoice:'inv-7',p_customer:'c1',p_lines:[{product_id:'p',qty_milli:2000}],p_cash_cents:0,p_sms_consent:false},snapshot:[{product_id:'p',name:'شاي',price_cents:1000,qty_milli:2000}]});`);
    await ctx.w.eval('submitPending()');
    assert.equal(ctx.w.eval('state.invoice.total_cents'), 2000, 'فاتورة آجل بنقد صفر: الإجمالي صحيح');
    assert.equal(ctx.w.eval('state.invoice.due_cents'), 2000, 'والدين = كامل الإجمالي');
    assert.equal(ctx.w.eval('state.invoiceLines.length'), 1, 'أسطر المستند المؤقت من لقطة السلة');
  } finally { ctx.close(); }
});

test('عودة الاتصال: دفع مرة واحدة بلا تكرار فاتورة', async () => {
  let online = false;
  const ctx = await boot({ online: () => online, rpc: (name,n,payload) => ({status:200,data:mockInvoiceAck(payload,7,{already_committed:n>1})}), tables:matchingSaleLines });
  try {
    ctx.w.eval(SALE);
    await ctx.w.eval('submitPending()');
    online = true;
    await ctx.w.eval('syncAll()');
    await ctx.w.eval('syncAll()');
    assert.equal(ctx.bridge.ops.get('inv-1').status, 'confirmed');
    assert.equal(ctx.bridge.ops.get('inv-1').serverRef, '7');
    assert.equal(ctx.calls.filter(c => c === 'rfq_pilot_post_invoice_guarded').length, 1, 'فاتورة واحدة رغم دورتي مزامنة');
  } finally { ctx.close(); }
});

test('تعارض المخزون: حالة conflict صريحة والعملية لا تُحذف ولا تُعدَّل صامتة', async () => {
  const ctx = await boot({ online: () => true, rpc: () => ({ status: 400, data: { message: 'insufficient_stock' } }) });
  try {
    ctx.w.eval(`ofxQueue('invoice',${JSON.stringify(testInvoicePayload('inv-2','s'))},'inv-2');`);
    await ctx.w.eval('syncPush()');
    const op = ctx.bridge.ops.get('inv-2');
    assert.equal(op.status, 'conflict');
    assert.match(op.note, /insufficient_stock/);
    assert.ok(ctx.bridge.ops.has('inv-2'), 'العملية باقية للمراجعة');
    assert.match(ctx.w.eval(`provisionalBadge('conflict')`), /لم يُعدَّل ولم يُحذف/);
    const cBadge = ctx.w.eval(`provisionalBadge('cancelled_by_owner')`);
    assert.match(cBadge, /بانتظار التوثيق على الخادم/, 'قرار المالك المحلي لا يُعرض موثقًا قبل الخادم');
    assert.match(cBadge, /لم يُوثَّق بعد/);
    assert.ok(!/موثق بمستند/.test(source), 'لا عبارة «موثق بمستند» لقرار لم يصل الخادم');
  } finally { ctx.close(); }
});

test('صنف أُنشئ دون اتصال: يُدفع بمعرّفه المحلي؛ رفض الخادم القديم تعارض صريح لا فقدان', async () => {
  const ctx = await boot({ online: () => true, rpc: (name) => name === 'rfq_pilot_save_product'
    ? { status: 400, data: { message: 'product_not_found' } } : { status: 200, data: [] } });
  try {
    ctx.w.eval(`ofxQueue('product',{p_store:'${STORE}',p_id:'44444444-4444-4444-8444-444444444444',p_name:'صنف أوفلاين',p_barcode:null,p_unit:'حبة',p_price_cents:500,p_cost_cents:400,p_initial_stock_milli:3000},'prod-1');`);
    await ctx.w.eval('syncPush()');
    const op = ctx.bridge.ops.get('prod-1');
    assert.equal(op.status, 'conflict');
    assert.match(op.note, /product_not_found/);
    assert.ok(ctx.bridge.ops.has('prod-1'));
  } finally { ctx.close(); }
});

test('لا سقف عمليات قبل موافقة المالك + انعدام الحذف الصامت + محرك بقائمة معلّقة كاملة', () => {
  assert.ok(!/سقف العمليات المعلقة/.test(source), 'سقف 100 غير معتمد من المالك — يجب ألا يكون في الكود');
  assert.ok(!/ofxDelete|ofxRemove|delete from ofx/i.test(source), 'لا حذف من الطابور في الواجهة');
  assert.match(source, /ofxQueued/, 'المحرك يستعمل قائمة المعلّقة الكاملة لا حد العرض');
  const kt = readFileSync(new URL('../../app/src/main/java/net/arena/rafiq/data/SyncEntities.kt', import.meta.url), 'utf8');
  assert.ok(!/@Query\("DELETE/i.test(kt), 'لا حذف من الطابور في القاعدة');
  assert.match(kt, /ORDER BY queuedAt ASC, rowid ASC/, 'ترتيب زمني مع كسر تعادل — المبيعات قبل إغلاق ورديتها');
  const br = readFileSync(new URL('../../app/src/main/java/net/arena/rafiq/cloud/CloudNativeBridge.kt', import.meta.url), 'utf8');
  assert.match(br, /fun ofxQueued\(\)/, 'الجسر يعرض كل المعلّقة بلا حد');
});

test('المراس من ترويسة Date للخادم لا من ساعة الهاتف', () => {
  const libsrc = readFileSync(new URL('../../web-client/lib.mjs', import.meta.url), 'utf8');
  assert.match(libsrc, /response\.headers\.get\('Date'\)/);
  assert.match(source, /anchor:state\.api\?\.lastServerDate/);
});

test('الترقية 000502: عزل المتاجر، إقرار إعادة الإرسال المطابقة، وحارس تعارض بمتجر الصف', () => {
  const sql = readFileSync(new URL('../../supabase/migrations/20261019000502_offline_product_idempotency.sql', import.meta.url), 'utf8');
  assert.match(sql, /create or replace function public\.rfq_pilot_save_product/);
  assert.match(sql, /product_id_belongs_to_another_store/, 'معرف صنف متجر آخر يُرفض صراحة');
  assert.match(sql, /elsif v_same and p_initial_stock_milli <> 0 then\s+-- إعادة إرسال مطابقة[\s\S]*?return p_id;/, 'إعادة الإرسال المطابقة بعد رد ضائع لا تتحول تعارضًا');
  assert.match(sql, /where public\.rfq_pilot_products\.store_id=p_store;/, 'حارس التعارض لا يلمس صف متجر آخر');
  assert.ok(!/stock_milli=excluded\.stock_milli/.test(sql), 'إعادة الدفع لا تغيّر الرصيد');
});

test('وردية دون نت: فتح مؤقت ذري، بيع مرتبط بها، إغلاق مؤقت — بلا نداء خادم', async () => {
  const ctx = await boot({ online: () => false, rpc: () => ({ status: 200, data: {} }) });
  try {
    ctx.w.eval(SETUP_LOCAL_SHIFT);
    ctx.w.eval(`setPending({id:'inv-9',payload:${JSON.stringify(testInvoicePayload('inv-9',LOCAL_SHIFT))},snapshot:${JSON.stringify(TEST_SNAPSHOT)}});`);
    await ctx.w.eval('submitPending()');
    ctx.w.eval(`ofxQueue('shift_close',{p_shift:'${LOCAL_SHIFT}',p_counted_cents:60000,p_event:'ev-1'},'shift_close:${LOCAL_SHIFT}');`);
    assert.equal(ctx.bridge.ops.get('shift_open:' + LOCAL_SHIFT).status, 'queued');
    assert.equal(ctx.bridge.ops.get('inv-9').status, 'queued');
    assert.equal(ctx.bridge.ops.get('shift_close:' + LOCAL_SHIFT).status, 'queued');
    assert.equal(ctx.calls.length, 0, 'لا نداء خادم دون اتصال');
    ctx.w.eval('updateSaleButtons()');
    assert.equal(ctx.w.eval("document.getElementById('postSale').disabled"), false, 'البيع يعمل ضمن الوردية المحلية المؤقتة');
    ctx.w.eval(`bridge().metaSet('local_shift:'+state.store,JSON.stringify({...JSON.parse(bridge().metaGet('local_shift:'+state.store)),closing:true}));state.localShift={...state.localShift,closing:true};updateSaleButtons();`);
    assert.equal(ctx.w.eval("document.getElementById('postSale').disabled"), true, 'لا بيع بعد الإغلاق المؤقت');
    assert.match(source, /لا تحصيل بعد الإغلاق المؤقت/, 'التحصيل ممنوع بعد الإغلاق المؤقت');
    assert.match(source, /const shiftRef=state\.shift\|\|\(state\.localShift&&state\.localShift\.id\);/, 'التحصيل يرتبط بالوردية المحلية لا بمعرف خالٍ');
    assert.match(source, /p_shift:shiftRef,p_device:state\.device,p_event/);
  } finally { ctx.close(); }
});

test('«وصل طلب الوردية» ≠ «وافق المالك»: ربط موثق بنفس الطلب ثم دفع مرتب', async () => {
  let approved = false;
  const ctx = await boot({
    online: () => true,
    rpc: (name,_count,payload) => {
      if (name === 'rfq_pilot_my_open_shift') return approved ? { status: 200, data: { id: 'srv-shift-1' } } : { status: 200, data: null };
      if (name === 'rfq_pilot_request_shift') return { status: 200, data: 'req-1' };
      if (name === 'rfq_pilot_post_invoice_guarded') return { status: 200, data: mockInvoiceAck(payload,9) };
      if (name === 'rfq_pilot_close_shift') return { status: 200, data: { variance_cents: 0 } };
      return { status: 200, data: [] };
    },
    tables: (tbl) => tbl === 'shift_requests' ? [{ id: 'req-1', status: approved ? 'approved' : 'pending', shift_id: approved ? 'srv-shift-1' : null }] : [],
  });
  try {
    ctx.w.eval(SETUP_LOCAL_SHIFT);
    ctx.w.eval(`ofxQueue('invoice',${JSON.stringify(testInvoicePayload('inv-8',LOCAL_SHIFT))},'inv-8');`);
    ctx.w.eval(`ofxQueue('shift_close',{p_shift:'${LOCAL_SHIFT}',p_counted_cents:60000,p_event:'ev-2'},'shift_close:${LOCAL_SHIFT}');`);
    await ctx.w.eval('syncPush()');
    const so = ctx.bridge.ops.get('shift_open:' + LOCAL_SHIFT);
    assert.equal(so.status, 'sent_awaiting_owner', 'وصول الطلب ليس موافقة');
    assert.match(ctx.w.eval(`provisionalBadge('sent_awaiting_owner')`), /بانتظار موافقة المالك/);
    assert.equal(ctx.bridge.ops.get('inv-8').status, 'queued', 'لا تأكيد قبل موافقة المالك');
    assert.equal(ctx.bridge.ops.get('shift_close:' + LOCAL_SHIFT).status, 'queued');
    assert.equal(ctx.calls.filter(c => c === 'rfq_pilot_post_invoice_guarded').length, 0);
    const reqBody = ctx.bodies.filter(b => b.path.includes('request_shift')).map(b => JSON.parse(b.body));
    assert.ok(reqBody.length === 1 && !('_local' in reqBody[0]) && !('_store' in reqBody[0]), 'الوسوم الداخلية لا تُرسل للخادم');
    approved = true;
    await ctx.w.eval('syncPush()');
    assert.equal(ctx.bridge.meta.get('shift_map:' + STORE + ':' + LOCAL_SHIFT), 'srv-shift-1');
    assert.equal(ctx.bridge.meta.get('shift_req:' + STORE + ':' + LOCAL_SHIFT), 'req-1', 'الربط موثق بمعرّف الطلب نفسه');
    const so2 = ctx.bridge.ops.get('shift_open:' + LOCAL_SHIFT);
    assert.equal(so2.status, 'confirmed');
    assert.match(so2.note, /وافق المالك — مطابقة للطلب req-1/);
    assert.equal(ctx.bridge.ops.get('inv-8').status, 'confirmed');
    assert.equal(ctx.bridge.ops.get('inv-8').serverRef, '9');
    assert.equal(ctx.bridge.ops.get('shift_close:' + LOCAL_SHIFT).status, 'confirmed');
    const invBody = ctx.bodies.filter(b => b.path.includes('post_invoice')).map(b => JSON.parse(b.body));
    assert.equal(invBody[0].p_shift, 'srv-shift-1', 'أُعيد كتابة معرّف الوردية إلى معرّف الخادم');
    assert.ok(!('_store' in invBody[0]));
    assert.equal(ctx.bridge.meta.get('local_shift:' + STORE), '', 'تُنظَّف الوردية المحلية بعد إقرار الإغلاق');
  } finally { ctx.close(); }
});

test('رفض المالك طلب الوردية: تعارض صريح للطلب ولكل عملياته — لا انتظار للأبد', async () => {
  let rejected = false;
  const ctx = await boot({
    online: () => true,
    rpc: (name) => {
      if (name === 'rfq_pilot_my_open_shift') return { status: 200, data: null };
      if (name === 'rfq_pilot_request_shift') return { status: 200, data: 'req-2' };
      if (name === 'rfq_pilot_post_invoice_guarded') return { status: 200, data: { number: 11 } };
      return { status: 200, data: [] };
    },
    tables: (tbl) => tbl === 'shift_requests' ? [{ id: 'req-2', status: rejected ? 'rejected' : 'pending' }] : [],
  });
  try {
    ctx.w.eval(SETUP_LOCAL_SHIFT);
    ctx.w.eval(`ofxQueue('invoice',${JSON.stringify(testInvoicePayload('inv-R',LOCAL_SHIFT))},'inv-R');`);
    await ctx.w.eval('syncPush()');
    assert.equal(ctx.bridge.ops.get('shift_open:' + LOCAL_SHIFT).status, 'sent_awaiting_owner');
    rejected = true;
    await ctx.w.eval('syncPush()');
    assert.equal(ctx.bridge.ops.get('shift_open:' + LOCAL_SHIFT).status, 'conflict');
    assert.match(ctx.bridge.ops.get('shift_open:' + LOCAL_SHIFT).note, /رفض المالك طلب الوردية/);
    assert.equal(ctx.bridge.ops.get('inv-R').status, 'conflict');
    assert.match(ctx.bridge.ops.get('inv-R').note, /رفض المالك طلبها — لم تُدفع/);
    assert.equal(ctx.calls.filter(c => c === 'rfq_pilot_post_invoice_guarded').length, 0, 'لم تُدفع أي فاتورة على وردية مرفوضة');
    assert.ok(ctx.bridge.ops.has('inv-R'), 'العملية محفوظة لقرار المالك — لا حذف');
  } finally { ctx.close(); }
});

test('إغلاق التطبيق وفتحه دون نت: دخول من الجلسة المحفوظة بوضع مؤقت والبيع ضمن الوردية المقرّة سابقًا', async () => {
  const ctx = await boot({ online: () => false, rpc: () => ({ status: 200, data: {} }), noState: true });
  try {
    const { w, bridge } = ctx;
    w.eval(`localStorage.setItem('rafiq-test-web-config',JSON.stringify({url:'${URL0}',key:'${KEY}'}));`);
    w.eval(`localStorage.setItem('rafiq-cloud-session-v1',JSON.stringify({url:'${URL0}',key:'${KEY}',access:'t',refreshToken:'r',expiresAt:Date.now()+3600000,user:{id:'u1',email:'w@t.test'}}));`);
    w.eval(`localStorage.setItem('rafiq-cloud-membership-v1',JSON.stringify({userId:'u1',store:'${STORE}',role:'worker'}));`);
    w.eval(`localStorage.setItem('rafiq-worker-state-v1',JSON.stringify({userId:'u1',store:'${STORE}',approved:true,lease:true,shift:'srv-cached',at:''}));`);
    bridge.meta.set('local_shift:' + STORE, JSON.stringify({ id: LOCAL_SHIFT, opening_cents: 50000, closing: false }));
    await w.eval('tryRestoreSession()');
    assert.equal(w.eval('state.store'), STORE, 'دخل للمتجر نفسه من العضوية المحفوظة');
    assert.equal(w.eval(`document.getElementById('appScreen').classList.contains('hide')`), false, 'شاشة التطبيق مفتوحة دون نت');
    assert.equal(w.eval('state.approved'), true);
    assert.equal(w.eval('state.lease'), true);
    assert.equal(w.eval('state.shift'), 'srv-cached', 'الوردية المقرّة من الخادم سابقًا محفوظة');
    assert.equal(w.eval('state.localShift&&state.localShift.id'), LOCAL_SHIFT, 'الوردية المحلية المؤقتة نجت من الإغلاق');
    assert.equal(w.eval("document.getElementById('postSale').disabled"), false, 'البيع متاح ضمن السياق المقرّ سابقًا');
    assert.equal(ctx.calls.length, 0, 'لا نداء خادم ناجح دون اتصال');
  } finally { ctx.close(); }
});

test('انقطاع بين خطوتي الفتح: الطابور وحده يكفل استعادة الوردية المحلية', async () => {
  const ctx = await boot({ online: () => false, rpc: () => ({ status: 200, data: {} }) });
  try {
    ctx.w.eval(SETUP_LOCAL_SHIFT);
    // محاكاة انقطاع بعد ofxQueue وقبل metaSet: التخزين المساعد فارغ
    ctx.bridge.meta.delete('local_shift:' + STORE);
    ctx.w.eval('state.localShift=null;');
    await ctx.w.eval(`enterSession({id:'u1'},{store_id:'${STORE}',role:'worker'})`);
    assert.equal(ctx.w.eval('state.localShift&&state.localShift.id'), LOCAL_SHIFT, 'استُعيدت الوردية من الطابور نفسه');
    assert.equal(ctx.w.eval('state.localShift.opening_cents'), 50000, 'ببياناتها الكاملة المحفوظة في حمولة العملية');
  } finally { ctx.close(); }
});

test('المزامنة لا تخلط متجرين: صارم — بلا وسم متجر لا تُدفع ولا تُعرض', async () => {
  const ctx = await boot({
    online: () => true,
    rpc: (name,_n,payload) => name === 'rfq_pilot_post_invoice_guarded' ? { status: 200, data: mockInvoiceAck(payload,3) } : { status: 200, data: [] },
    tables: (tbl, params) => (tbl === 'products' && params.store_id === `eq.${STORE_B}`)
      ? [{ id: 'pb1', store_id: STORE_B, name: 'صنف ب', updated_at: '2026-01-01T00:00:00Z' }] : [],
  });
  try {
    ctx.w.eval(`ofxQueue('invoice',${JSON.stringify(testInvoicePayload('inv-A','s'))},'inv-A');`);
    // عملية قديمة بلا وسم متجر — لا تُنسب تلقائيًا للمتجر الحالي
    ctx.bridge.ops.set('legacy-1', { id: 'legacy-1', kind: 'invoice', payload: JSON.stringify({ p_shift: 's', p_device: 'd1', p_invoice: 'legacy' }), status: 'queued', attempts: 0, serverRef: '', note: '', queuedAt: '2026-01-01T00:00:00Z' });
    ctx.w.eval(`state.store='${STORE_B}';`);
    await ctx.w.eval('syncPush()');
    assert.equal(ctx.bridge.ops.get('inv-A').status, 'queued', 'عملية المتجر الأول لا تُدفع من جلسة المتجر الثاني');
    assert.equal(ctx.bridge.ops.get('legacy-1').status, 'conflict', 'بلا وسم متجر = تُعزل صراحة لا تُخفى');
    assert.match(ctx.bridge.ops.get('legacy-1').note, /معزولة: عملية قديمة بلا وسم متجر/, 'عزل موثق بملاحظة صريحة');
    assert.equal(ctx.calls.filter(c => c === 'rfq_pilot_post_invoice_guarded').length, 0);
    assert.equal(ctx.w.eval(`sameStoreOp({payload:JSON.stringify({p_invoice:'x'})})`), false, 'لا تُعرض في مركز متجر آخر');
    await ctx.w.eval('syncPull()');
    assert.ok(ctx.bridge.mirror.has(STORE_B + ':products:pb1'), 'مرآة المتجر الثاني بمفتاح نطاقه');
    assert.equal(ctx.bridge.mirrorGet(STORE + ':products'), '[]', 'مرآة المتجر الأول لا تختلط');
    ctx.w.eval(`state.store='${STORE}';`);
    await ctx.w.eval('syncPush()');
    assert.equal(ctx.bridge.ops.get('inv-A').status, 'confirmed', 'عادت جلسة المتجر الأول → دُفعت عمليته');
    assert.equal(ctx.bridge.ops.get('legacy-1').status, 'conflict', 'وبقيت المعزولة محفوظة كما هي — لم تُدفع ولم تُحذف');
  } finally { ctx.close(); }
});

test('المزامنة لا تفوّت تحديثات: مراس مركب مستقل لكل جدول', async () => {
  const invoices = [{ id: 'i1', created_at: '2026-01-01T00:00:00Z' }];
  const ctx = await boot({
    online: () => true,
    rpc: () => ({ status: 200, data: [] }),
    tables: (tbl, params) => {
      let rows = tbl === 'products' ? [{ id: 'p1', updated_at: '2026-01-02T00:00:00Z' }]
        : tbl === 'invoices' ? invoices : [];
      rows = applyOr(rows, params);
      return rows;
    },
  });
  try {
    await ctx.w.eval('syncPull()');
    assert.equal(ctx.bridge.meta.get('pull_wm:' + STORE + ':products'), '2026-01-02T00:00:00Z|p1');
    assert.equal(ctx.bridge.meta.get('pull_wm:' + STORE + ':invoices'), '2026-01-01T00:00:00Z|i1', 'مراس الفواتير مستقل عن الأصناف');
    invoices.push({ id: 'i2', created_at: '2026-01-01T12:00:00Z' });
    await ctx.w.eval('syncPull()');
    assert.ok(ctx.bridge.mirror.has(STORE + ':invoices:i2'), 'الفاتورة الأحدث لم تُفوّت رغم تقدم مراس جدول آخر');
    assert.equal(ctx.bridge.meta.get('pull_wm:' + STORE + ':invoices'), '2026-01-01T12:00:00Z|i2');
  } finally { ctx.close(); }
});

test('صفحات متعددة بنفس التوقيت: المراس المركب يجلبها كلها بلا تكرار بلا نهاية', async () => {
  const TS = '2026-01-01T00:00:00Z';
  const all = []; for (let i = 0; i < 150; i++) all.push({ id: 'i' + String(i).padStart(3, '0'), created_at: TS });
  const ctx = await boot({
    online: () => true,
    rpc: () => ({ status: 200, data: [] }),
    tables: (tbl, params) => {
      if (tbl !== 'invoices') return [];
      let rows = applyOr(all, params);
      return rows.slice(0, Number(params.limit || 100)); // محاكاة حد الصفحة (100)
    },
  });
  try {
    await ctx.w.eval('syncPull()');
    assert.equal(ctx.bridge.mirror.size >= 150, true, 'كل الصفوف الـ150 وصلت رغم تطابق التوقيت');
    assert.equal(ctx.bridge.meta.get('pull_wm:' + STORE + ':invoices'), TS + '|i149');
    const pages = ctx.calls.filter(c => c === 'table:rfq_pilot_invoices' || c === 'table:invoices').length;
    assert.ok(pages >= 2, 'صفحتان على الأقل');
    await ctx.w.eval('syncPull()'); // دورة ثالثة: لا جديد ولا حلقة لا نهائية
    assert.equal(ctx.bridge.meta.get('pull_wm:' + STORE + ':invoices'), TS + '|i149');
  } finally { ctx.close(); }
});

test('جدول بلا updated_at: يسقط على عمود بديل ويعيد المراس بأمان', async () => {
  const ctx = await boot({
    online: () => true,
    rpc: () => ({ status: 200, data: [] }),
    tables: (tbl, params) => {
      if (tbl === 'customers' && String(params.order || '').startsWith('updated_at'))
        return { status: 400, data: { message: 'column rfq_pilot_customers.updated_at does not exist' } };
      if (tbl === 'customers') return [{ id: 'c1', created_at: '2026-01-01T00:00:00Z', name: 'زبون' }];
      return [];
    },
  });
  try {
    await ctx.w.eval('syncPull()');
    assert.equal(ctx.bridge.meta.get('pull_col:' + STORE + ':customers'), 'created_at', 'سقط للعمود البديل');
    assert.ok(ctx.bridge.mirror.has(STORE + ':customers:c1'), 'وجلب الصفوف فعلًا بعد السقوط');
  } finally { ctx.close(); }
});

test('طابور يتجاوز حد العرض 100: كل المعلّقة تُدفع — لا تتأخر عملية قديمة أبدًا', async () => {
  const ctx = await boot({
    online: () => true, listLimit: 2,
    rpc: (name,n,payload) => ({status:200,data:mockInvoiceAck(payload,n)}),
  });
  try {
    for (let i = 0; i < 104; i++)
      ctx.w.eval(`ofxQueue('invoice',${JSON.stringify(testInvoicePayload('inv-'+i,'s'))},'inv-${i}');`);
    await ctx.w.eval('syncPush()');
    const confirmed = [...ctx.bridge.ops.values()].filter(o => o.status === 'confirmed').length;
    assert.equal(confirmed, 104, '104 عمليات كلها تأكدت رغم حد العرض 2 في المحاكاة (100 في الهاتف)');
    assert.equal(ctx.calls.filter(c => c === 'rfq_pilot_post_invoice_guarded').length, 104);
  } finally { ctx.close(); }
});

test('حارس تنفيذ واحد: مزامنتان متزامنتان لا تضاعفان الدفع', async () => {
  const ctx = await boot({ online: () => true, rpc: (_name,_n,payload) => ({status:200,data:mockInvoiceAck(payload,5)}) });
  try {
    ctx.w.eval(`ofxQueue('invoice',${JSON.stringify(testInvoicePayload('inv-C','s'))},'inv-C');`);
    await ctx.w.eval('Promise.all([syncAll(),syncAll(),syncAll()])');
    assert.equal(ctx.calls.filter(c => c === 'rfq_pilot_post_invoice_guarded').length, 1, 'دفعة واحدة رغم ثلاث دعوات متزامنة');
    assert.equal(ctx.bridge.ops.get('inv-C').status, 'confirmed');
  } finally { ctx.close(); }
});

test('المعزولة بلا وسم متجر: تظهر للمالك في مركز المزامنة ولا تُدفع تلقائيًا', async () => {
  const ctx = await boot({ online: () => true, rpc: (name) => ({ status: 200, data: name === 'rfq_pilot_post_invoice_guarded' ? { number: 21 } : [] }) });
  try {
    ctx.bridge.ops.set('legacy-9', { id: 'legacy-9', kind: 'invoice', payload: JSON.stringify({ p_shift: 's', p_device: 'd1', p_invoice: 'old-1' }), status: 'queued', attempts: 0, serverRef: '', note: '', queuedAt: '2025-12-01T00:00:00Z' });
    ctx.w.eval(`state.role='owner';renderOfflineCenter();`);
    let home = ctx.w.eval(`document.getElementById('homeView').textContent`);
    assert.match(home, /عمليات معزولة — لا تُدفع تلقائيًا/, 'المالك يرى قسم المعزولة');
    assert.match(home, /legacy-9/, 'ويرى معرف العملية المعزولة نفسه');
    await ctx.w.eval('syncPush()');
    assert.equal(ctx.bridge.ops.get('legacy-9').status, 'conflict');
    assert.equal(ctx.calls.filter(c => c === 'rfq_pilot_post_invoice_guarded').length, 0, 'لم تُدفع');
    ctx.w.eval(`state.role='worker';renderOfflineCenter();`);
    home = ctx.w.eval(`document.getElementById('homeView').textContent`);
    assert.match(home, /عمليات معزولة/, 'العامل يعلم بوجود قسم معزول (شفافية)');
    assert.ok(!home.includes('legacy-9'), 'لكن تفاصيلها وقرارها للمالك وحده');
  } finally { ctx.close(); }
});

test('التصدير كامل بصفحات: 1200 فاتورة كلها — لا حد 1000', async () => {
  const all = [];
  for (let i = 0; i < 1200; i++) {
    const d = new Date(Date.UTC(2026, 0, 1) + i * 60000).toISOString().replace('.000Z', 'Z');
    all.push({ id: 'i' + String(i).padStart(4, '0'), number: 1000 + i, total_cents: 100, due_cents: 0, created_at: d });
  }
  const ctx = await boot({
    online: () => true,
    rpc: () => ({ status: 200, data: [] }),
    tables: (tbl, params) => tbl === 'invoices' ? applyOr(all, params).slice(0, Number(params.limit || 500)) : [],
  });
  try {
    ctx.w.eval('URL.createObjectURL=()=>"blob:demo";');
    const msg = await ctx.w.eval(`exportCsv('invoices')`);
    assert.match(msg, /1200 صف/, 'كل الصفوف صُدِّرت');
    assert.match(msg, /من الخادم/);
    assert.ok(!msg.includes('ناقص'), 'بلا إنذار نقصان');
    assert.ok(ctx.calls.filter(c => c === 'table:invoices').length >= 3, 'صفحات متعددة فعلًا');
    assert.ok(!/أول 1000 صف/.test(source), 'حد الألف لم يعد تصديرًا — أُزيل');
  } finally { ctx.close(); }
});

test('التصدير دون نت: نسخة محلية مؤقتة موسومة بصدق', async () => {
  const ctx = await boot({ online: () => false, rpc: () => ({ status: 200, data: [] }) });
  try {
    ctx.bridge.mirrorPut(JSON.stringify([{ tbl: `${STORE}:invoices`, id: 'm1', json: JSON.stringify({ number: 5, total_cents: 900, due_cents: 400, created_at: '2026-01-01T00:00:00Z' }) }]));
    ctx.w.eval('URL.createObjectURL=()=>"blob:demo";');
    const msg = await ctx.w.eval(`exportCsv('invoices')`);
    assert.match(msg, /تصدير محلي مؤقت/, 'موسوم أنه محلي مؤقت');
    assert.match(msg, /ليس تصدير خادم كامل/);
    assert.match(msg, /1 صف — نسخة محلية/);
  } finally { ctx.close(); }
});

test('لا مسار تجاوز: تعذر قراءة الطلب = لا ربط ولا ادعاء موافقة', async () => {
  const ctx = await boot({
    online: () => true,
    rpc: (name) => {
      if (name === 'rfq_pilot_my_open_shift') return { status: 200, data: { id: 'srv-shift-X' } };
      if (name === 'rfq_pilot_request_shift') return { status: 200, data: 'req-9' };
      return { status: 200, data: [] };
    },
    tables: (tbl) => tbl === 'shift_requests' ? { status: 403, data: { message: 'permission denied for table shift_requests' } } : [],
  });
  try {
    ctx.w.eval(SETUP_LOCAL_SHIFT);
    ctx.w.eval(`ofxQueue('invoice',${JSON.stringify(testInvoicePayload('inv-NB',LOCAL_SHIFT))},'inv-NB');`);
    await ctx.w.eval('syncPush()');
    await ctx.w.eval('syncPush()');
    const so = ctx.bridge.ops.get('shift_open:' + LOCAL_SHIFT);
    assert.equal(so.status, 'sent_awaiting_owner', 'بلا دليل الطلب لا تأكيد — لا مسار تجاوز');
    assert.ok(!ctx.bridge.meta.has('shift_map:' + STORE + ':' + LOCAL_SHIFT), 'ولا ربط بلا دليل');
    assert.ok(!/وافق المالك/.test(so.note || ''), 'ولا ادعاء موافقة');
    assert.equal(ctx.bridge.ops.get('inv-NB').status, 'queued', 'والبيع ينتظر بأمان');
    assert.ok(!/وردية الخادم المفتوحة لجهاز العامل نفسه/.test(source), 'مسار التجاوز أُزيل من الكود');
    assert.ok(!/\(!reqShift\|\|/.test(source), 'مسار الربط بالموافقة وحدها عند غياب shift_id أُزيل من الكود (شرط المالك — الجولة 6)');
  } finally { ctx.close(); }
});

test('مراس السحب لا يتقدم قبل ثبوت حفظ الصفحة في المرآة', async () => {
  const ctx = await boot({
    online: () => true,
    rpc: () => ({ status: 200, data: [] }),
    tables: (tbl) => tbl === 'products' ? [{ id: 'p9', updated_at: '2026-02-02T00:00:00Z' }] : [],
  });
  try {
    ctx.bridge.mirrorPut = () => '{"ok":true}'; // حفظ لا يُثبت شيء فعلًا
    await ctx.w.eval('syncPull()');
    assert.ok(!ctx.bridge.meta.has('pull_wm:' + STORE + ':products'), 'فشل ثبوت الحفظ = المراس لم يتقدم');
    ctx.bridge.mirrorPut = (json) => { for (const r of JSON.parse(json)) ctx.bridge.mirror.set(`${r.tbl}:${r.id}`, r); return '{"ok":true}'; };
    await ctx.w.eval('syncPull()');
    assert.equal(ctx.bridge.meta.get('pull_wm:' + STORE + ':products'), '2026-02-02T00:00:00Z|p9', 'بعد ثبوت الحفظ تقدم المراس');
    assert.ok(ctx.bridge.mirror.has(STORE + ':products:p9'));
  } finally { ctx.close(); }
});

test('استعادة الجلسة: خطأ خادم مؤقت لا يُخرج المستخدم ولا يمسح جلسته', async () => {
  let healed = false;
  const ctx = await boot({
    online: () => true, noState: true,
    rpc: () => ({ status: 200, data: [] }),
    tables: (tbl) => tbl === 'members' ? (healed ? [{ store_id: STORE, role: 'worker' }] : { status: 500, data: { message: 'HTTP 500' } }) : [],
  });
  try {
    const { w } = ctx;
    w.eval(`localStorage.setItem('rafiq-cloud-session-v1',JSON.stringify({url:'${URL0}',key:'${KEY}',access:'t',refreshToken:'r',expiresAt:Date.now()+3600000,user:{id:'u1',email:'w@t.test'}}));`);
    await w.eval('tryRestoreSession()');
    assert.ok(w.eval('!!state.api'), 'الجلسة باقية رغم خطأ الخادم المؤقت');
    assert.ok(w.eval(`!!localStorage.getItem('rafiq-cloud-session-v1')`), 'ولم تُمسح الجلسة المحفوظة');
    healed = true;
    await w.eval('tryRestoreSession()');
    assert.equal(w.eval('state.store'), STORE, 'وبعد زوال الخطأ دخل فعليًا');
  } finally { ctx.close(); }
});

test('المستندات المطبوعة صادقة: مؤقت موسوم، ومؤكَّد موسوم', async () => {
  const ctx = await boot({ online: () => false, rpc: () => ({ status: 200, data: {} }) });
  try {
    ctx.w.eval(`renderInvoice({number:'—',total_cents:1000,due_cents:1000,provisional:true},[{product_id:'p',name:'شاي',price_cents:500,qty_milli:2000}]);`);
    let doc = ctx.w.eval(`document.getElementById('printArea').textContent`);
    assert.match(doc, /مستند مؤقت — بانتظار المزامنة — ليس إقرارًا من الخادم/, 'الفاتورة المؤقتة المطبوعة موسومة');
    assert.match(doc, /فاتورة مؤقتة \(رقمها من الخادم بعد الإقرار\)/);
    ctx.w.eval(`renderInvoice({number:55,total_cents:1000,due_cents:0},[]);`);
    doc = ctx.w.eval(`document.getElementById('printArea').textContent`);
    assert.match(doc, /فاتورة رقم 55/);
    assert.ok(!/مستند مؤقت/.test(doc), 'والمؤكدة لا تحمل وسم مؤقت');
    ctx.w.eval(`collectionReceiptDom({provisional:true,amount_cents:500,customer:'أحمد',local:true});`);
    doc = ctx.w.eval(`document.getElementById('printArea').textContent`);
    assert.match(doc, /وصل مؤقت — بانتظار المزامنة — ليس إقرارًا من الخادم/, 'وصل التحصيل المؤقت موسوم');
    assert.match(doc, /وردية محلية مؤقتة/);
    ctx.w.eval(`collectionReceiptDom({provisional:false,amount_cents:500,customer:'أحمد',local:false});`);
    doc = ctx.w.eval(`document.getElementById('printArea').textContent`);
    assert.match(doc, /تحصيل مؤكد من الخادم/);
    assert.match(source, /حُفظ التحصيل على الهاتف — وصل مؤقت/, 'ورسالة التحصيل نفسها صادقة');
  } finally { ctx.close(); }
});

test('قرارات المالك المحلية: سجل يبقى بعد إعادة الفتح ويعرض «بانتظار التوثيق»', async () => {
  const ctx = await boot({ online: () => true, rpc: () => ({ status: 200, data: [] }) });
  try {
    ctx.w.eval(`state.role='owner';`);
    ctx.w.eval(`recordLocalDecision('op-abcdef12','invoice','cancelled','إلغاء محلي بقرار المالك');`);
    const j = JSON.parse(ctx.bridge.meta.get('owner_local_decisions:' + STORE));
    assert.equal(j.length, 1);
    assert.equal(j[0].decision, 'cancelled');
    ctx.w.eval('renderOfflineCenter();');
    const home = ctx.w.eval(`document.getElementById('homeView').textContent`);
    assert.match(home, /قرارات مالك محلية — بانتظار التوثيق على الخادم/);
    assert.match(home, /لم يُوثَّق بعد/);
    assert.match(home, /op-abcde/);
    ctx.w.eval(`state.role='worker';renderOfflineCenter();`);
    const home2 = ctx.w.eval(`document.getElementById('homeView').textContent`);
    assert.ok(!home2.includes('قرارات مالك محلية'), 'سجل القرارات للمالك وحده');
  } finally { ctx.close(); }
});

test('ربط الوردية: وردية الخادم يجب أن تكون وردية صف الطلب نفسه', async () => {
  let reqShift = 'srv-OTHER';
  const ctx = await boot({
    online: () => true,
    rpc: (name) => name === 'rfq_pilot_my_open_shift' ? { status: 200, data: { id: 'srv-shift-1' } }
      : name === 'rfq_pilot_request_shift' ? { status: 200, data: 'req-1' } : { status: 200, data: [] },
    tables: (tbl, params) => tbl === 'shift_requests'
      ? (String(params.select || '').includes('shift_id')
        ? [{ id: 'req-1', status: 'approved', shift_id: reqShift }]
        : [{ id: 'req-1', status: 'approved' }])
      : [],
  });
  try {
    ctx.w.eval(SETUP_LOCAL_SHIFT);
    await ctx.w.eval('syncPush()');
    await ctx.w.eval('syncPush()');
    assert.equal(ctx.bridge.ops.get('shift_open:' + LOCAL_SHIFT).status, 'sent_awaiting_owner');
    assert.ok(!ctx.bridge.meta.has('shift_map:' + STORE + ':' + LOCAL_SHIFT), 'وردية مفتوحة ≠ وردية الطلب: لا ربط عند عدم التطابق');
    reqShift = 'srv-shift-1';
    await ctx.w.eval('syncPush()');
    assert.equal(ctx.bridge.meta.get('shift_map:' + STORE + ':' + LOCAL_SHIFT), 'srv-shift-1', 'عند تطابق وردية الطلب يتم الربط');
    assert.match(ctx.bridge.ops.get('shift_open:' + LOCAL_SHIFT).note, /وافق المالك — مطابقة للطلب req-1/);
  } finally { ctx.close(); }
});

test('ربط الوردية: خادم بلا عمود shift_id — لا ربط بالموافقة وحدها؛ معلّقة حتى يثبت الارتباط', async () => {
  let hasCol = false;
  const ctx = await boot({
    online: () => true,
    rpc: (name) => name === 'rfq_pilot_my_open_shift' ? { status: 200, data: { id: 'srv-shift-2' } }
      : name === 'rfq_pilot_request_shift' ? { status: 200, data: 'req-2' } : { status: 200, data: [] },
    tables: (tbl, params) => tbl === 'shift_requests'
      ? (String(params.select || '').includes('shift_id')
        ? (hasCol ? [{ id: 'req-2', status: 'approved', shift_id: 'srv-shift-2' }] : { status: 400, data: { message: 'column shift_id does not exist' } })
        : [{ id: 'req-2', status: 'approved' }])
      : [],
  });
  try {
    ctx.w.eval(SETUP_LOCAL_SHIFT);
    await ctx.w.eval('syncPush()');
    await ctx.w.eval('syncPush()');
    const so = ctx.bridge.ops.get('shift_open:' + LOCAL_SHIFT);
    assert.equal(so.status, 'sent_awaiting_owner', 'الموافقة وحدها لا تكفي — لا تأكيد ولا ربط');
    assert.ok(!ctx.bridge.meta.has('shift_map:' + STORE + ':' + LOCAL_SHIFT), 'لا ربط بلا دليل ارتباط الوردية بالطلب نفسه');
    assert.match(so.note, /معلّق حتى يثبت الخادم ارتباط الوردية بالطلب نفسه/, 'سبب التعليق صريح وصادق');
    assert.ok(so.note.includes('req-2'), 'المعرّف الكامل للطلب متاح للمراجعة داخل السبب');
    hasCol = true; // ترقية الخادم: صف الطلب صار يحمل ورديته — يثبت الارتباط
    await ctx.w.eval('syncPush()');
    assert.equal(ctx.bridge.meta.get('shift_map:' + STORE + ':' + LOCAL_SHIFT), 'srv-shift-2', 'عند ثبوت الارتباط يتم الربط');
    assert.equal(ctx.bridge.ops.get('shift_open:' + LOCAL_SHIFT).status, 'confirmed');
  } finally { ctx.close(); }
});

test('ما بعد آخر 100: التعارضات والطلبات والمعزولات تسترجع وتُعرض', async () => {
  const ctx = await boot({ online: () => true, listLimit: 100, rpc: () => ({ status: 200, data: [] }) });
  try {
    ctx.bridge.ops.set('old-conflict', { id: 'old-conflict', kind: 'invoice', payload: JSON.stringify({ _store: STORE, p_invoice: 'x' }), status: 'conflict', attempts: 1, serverRef: '', note: 'insufficient_stock', queuedAt: '2026-01-01T00:00:00Z' });
    ctx.bridge.ops.set('old-sent', { id: 'old-sent', kind: 'shift_open', payload: JSON.stringify({ _store: STORE }), status: 'sent_awaiting_owner', attempts: 1, serverRef: 'req-old', note: '', queuedAt: '2026-01-01T00:00:00Z' });
    ctx.bridge.ops.set('old-isolated', { id: 'old-isolated', kind: 'invoice', payload: JSON.stringify({ p_invoice: 'old' }), status: 'conflict', attempts: 1, serverRef: '', note: 'معزولة: عملية قديمة بلا وسم متجر', queuedAt: '2026-01-01T00:00:00Z' });
    for (let i = 0; i < 120; i++) ctx.bridge.ops.set('fill-' + i, { id: 'fill-' + i, kind: 'invoice', payload: JSON.stringify({ _store: STORE }), status: 'confirmed', attempts: 1, serverRef: String(i), note: '', queuedAt: '2026-01-02T00:00:00Z' });
    assert.ok(!JSON.parse(ctx.w.eval('NativeApi.ofxList()')).some(o => o.id === 'old-conflict'), 'حد العرض 100 يخفيها فعلًا في القائمة القديمة');
    ctx.w.eval(`state.role='owner';renderOfflineCenter();`);
    const home = ctx.w.eval(`document.getElementById('homeView').textContent`);
    assert.match(home, /old-conf/, 'التعارض القديم ظاهر رغم تجاوزه حد العرض');
    assert.match(home, /old-sent/, 'والطلب القديم الظاهر');
    assert.match(home, /old-iso/, 'والمعزولة القديمة');
    ctx.w.eval(`state.role='worker';renderOfflineCenter();`);
    const home2 = ctx.w.eval(`document.getElementById('homeView').textContent`);
    assert.ok(!home2.includes('old-iso'), 'تفاصيل المعزولة للمالك وحده');
  } finally { ctx.close(); }
});

test('مراس السحب: تحديث صف موجود لا يُقر إلا بثبوت حفظ محتواه الجديد', async () => {
  const ctx = await boot({
    online: () => true,
    rpc: () => ({ status: 200, data: [] }),
    tables: (tbl) => tbl === 'products' ? [{ id: 'p1', name: 'نسخة محدثة', updated_at: '2026-03-03T00:00:00Z' }] : [],
  });
  try {
    ctx.bridge.mirrorPut = (json) => { for (const r of JSON.parse(json)) ctx.bridge.mirror.set(`${r.tbl}:${r.id}`, { ...r, json: '{"id":"p1","name":"نسخة قديمة"}' }); return '{"ok":true}'; };
    await ctx.w.eval('syncPull()');
    assert.ok(!ctx.bridge.meta.has('pull_wm:' + STORE + ':products'), 'حفظ محتوى قديم لصف موجود = المراس لا يتقدم');
    ctx.bridge.mirrorPut = (json) => { for (const r of JSON.parse(json)) ctx.bridge.mirror.set(`${r.tbl}:${r.id}`, r); return '{"ok":true}'; };
    await ctx.w.eval('syncPull()');
    assert.equal(ctx.bridge.meta.get('pull_wm:' + STORE + ':products'), '2026-03-03T00:00:00Z|p1', 'وبثبوت المحتوى الجديد تقدم');
  } finally { ctx.close(); }
});

test('انتهاء رمز الجلسة + فتحان متتاليان دون نت: دخول مؤقت صادق مرتين', async () => {
  const seed = {
    cfg: JSON.stringify({ url: URL0, key: KEY }),
    sess: JSON.stringify({ url: URL0, key: KEY, access: 't', refreshToken: 'r', expiresAt: Date.now() - 60000, user: { id: 'u1', email: 'w@t.test' } }),
    mem: JSON.stringify({ userId: 'u1', store: STORE, role: 'worker' }),
    ws: JSON.stringify({ userId: 'u1', store: STORE, approved: true, lease: true, shift: 'srv-cached', at: '' }),
  };
  const openOnce = async () => {
    const ctx = await boot({ online: () => false, rpc: () => ({ status: 200, data: {} }), noState: true });
    const { w } = ctx;
    w.eval(`localStorage.setItem('rafiq-test-web-config',${JSON.stringify(seed.cfg)});`);
    w.eval(`localStorage.setItem('rafiq-cloud-session-v1',${JSON.stringify(seed.sess)});`);
    w.eval(`localStorage.setItem('rafiq-cloud-membership-v1',${JSON.stringify(seed.mem)});`);
    w.eval(`localStorage.setItem('rafiq-worker-state-v1',${JSON.stringify(seed.ws)});`);
    await w.eval('tryRestoreSession()');
    const out = { store: w.eval('state.store'), approved: w.eval('state.approved'), lease: w.eval('state.lease'), shift: w.eval('state.shift') };
    ctx.close();
    return out;
  };
  const a = await openOnce();
  const b2 = await openOnce();
  assert.equal(a.store, STORE, 'الفتح الأول دون نت وبرمز منتهٍ: دخول مؤقت');
  assert.equal(a.approved, true);
  assert.equal(b2.store, STORE, 'والفتح الثاني كذلك — الجلسة صمدت');
  assert.equal(b2.shift, 'srv-cached');
});

test('الجهاز متصل والخادم غير متاح: حالة صادقة بلا سقوط وبلا ادعاء', async () => {
  let healthy = false;
  const ctx = await boot({
    online: () => true,
    rpc: () => healthy ? { status: 200, data: [] } : { status: 503, data: { message: 'Service Unavailable' } },
    tables: () => healthy ? [] : { status: 503, data: { message: 'Service Unavailable' } },
  });
  try {
    ctx.w.eval(`ofxQueue('invoice',${JSON.stringify(testInvoicePayload('inv-D','s'))},'inv-D');`);
    await ctx.w.eval('safeRefresh()');
    assert.equal(ctx.w.eval('state.serverDown'), true, 'حالة «الخادم غير متاح» مسجلة');
    const home = ctx.w.eval(`document.getElementById('homeView').textContent`);
    assert.match(home, /الجهاز متصل بالشبكة لكن الخادم غير متاح/, 'ومعروضة بصدق للعامل');
    assert.equal(ctx.bridge.ops.get('inv-D').status, 'queued', 'والعملية باقية بانتظار المزامنة');
    healthy = true;
    await ctx.w.eval('safeRefresh()');
    assert.equal(ctx.w.eval('state.serverDown'), false, 'وبعودة الخادم تزول الحالة');
  } finally { ctx.close(); }
});

test('فشل حفظ قرار المالك: لا إلغاء ولا تغيير — والحسم يُعطَّل بصدق', async () => {
  const ctx = await boot({ online: () => true, rpc: () => ({ status: 200, data: [] }) });
  try {
    ctx.bridge.ops.set('conf-x', { id: 'conf-x', kind: 'invoice', payload: JSON.stringify({ _store: STORE, p_invoice: 'x' }), status: 'conflict', attempts: 1, serverRef: '', note: 'insufficient_stock', queuedAt: '2026-01-01T00:00:00Z' });
    const realSet = ctx.bridge.metaSet;
    ctx.bridge.metaSet = (k, v) => { if (k.startsWith('owner_local_decisions') || k.startsWith('owner_decisions_probe')) throw new Error('storage full'); return realSet(k, v); };
    ctx.w.eval(`state.role='owner';`);
    assert.equal(ctx.w.eval('decisionsStorageOk()'), false);
    assert.equal(ctx.w.eval(`recordLocalDecision('conf-x','invoice','cancelled','محاولة')`), false, 'القرار لم يُحفظ = لم يُسجل');
    assert.equal(ctx.bridge.ops.get('conf-x').status, 'conflict', 'وحالة العملية لم تتغير إلى ملغاة');
    ctx.w.eval('renderOfflineCenter();');
    assert.match(ctx.w.eval(`document.getElementById('homeView').textContent`), /الحسم معطل حتى اعتماد مسار التوثيق الخادمي/, 'والحسم معطل بصدق لا بصمت');
    ctx.bridge.metaSet = realSet;
    assert.equal(ctx.w.eval(`recordLocalDecision('conf-x','invoice','cancelled','محاولة')`), true, 'وبعودة التخزين يُحفظ القرار');
    assert.equal(ctx.w.eval('decisionsStorageOk()'), true);
  } finally { ctx.close(); }
});

test('العهدة الافتتاحية: تُرسل في الطلب، وعند رفض خادم قديم تُعلن يدويًا بصدق', async () => {
  const rejectsOpening = { v: true };
  const ctx = await boot({
    online: () => true,
    rpc: (name, n) => {
      if (name === 'rfq_pilot_request_shift') return { status: 200, data: 'req-1' };
      return { status: 200, data: [] };
    },
    tables: () => [],
  });
  try {
    // حالة أ: خادم يقبل العهدة
    ctx.w.eval(SETUP_LOCAL_SHIFT);
    await ctx.w.eval('syncPush()');
    let bodies = ctx.bodies.filter(b => b.path.includes('request_shift')).map(b => JSON.parse(b.body));
    assert.equal(bodies.length, 1);
    assert.equal(bodies[0].p_opening_cents, 50000, 'العهدة وصلت المالك داخل الطلب');
    assert.ok(!/العهدة لم تُضمَّن/.test(ctx.bridge.ops.get('shift_open:' + LOCAL_SHIFT).note));
  } finally { ctx.close(); }
  const ctx2 = await boot({
    online: () => true,
    rpc: (name) => {
      if (name === 'rfq_pilot_request_shift') return { status: 200, data: 'req-1' };
      return { status: 200, data: [] };
    },
    tables: () => [],
  });
  try {
    const realFetch = globalThis.fetch; // PilotApi يستدعي fetch العام (بيئة الوحدة) لا fetch النافذة
    globalThis.fetch = async (url, opt) => {
      if (String(url).includes('request_shift') && opt && opt.body && JSON.parse(opt.body).p_opening_cents != null) {
        ctx2.bodies.push({ path: String(url), body: opt.body }); // المحاولة المرفوضة تُحسب في السجل
        return { ok: false, status: 400, text: async () => JSON.stringify({ message: 'function rfq_pilot_request_shift(p_opening_cents) does not exist' }), json: async () => ({}), headers: { get: () => null } };
      }
      return realFetch(url, opt);
    };
    try {
    ctx2.w.eval(SETUP_LOCAL_SHIFT);
    await ctx2.w.eval('syncPush()');
    const bodies = ctx2.bodies.filter(b => b.path.includes('request_shift')).map(b => JSON.parse(b.body));
    assert.equal(bodies.length, 2, 'حاول بالعهدة ثم بدونها');
    assert.equal(bodies[0].p_opening_cents, 50000);
    assert.ok(!('p_opening_cents' in bodies[1]));
    assert.match(ctx2.bridge.ops.get('shift_open:' + LOCAL_SHIFT).note, /العهدة لم تُضمَّن في الطلب/, 'والصدق في الملاحظة: تُعلن يدويًا عند الاعتماد');
    assert.equal(ctx2.bridge.ops.get('shift_open:' + LOCAL_SHIFT).status, 'sent_awaiting_owner');
    } finally { globalThis.fetch = realFetch; }
  } finally { ctx2.close(); }
});

test('ساعة الهاتف تنقلب: سلسلة الوردية تحفظ ترتيبها (فتح ← بيع ← إغلاق)', async () => {
  const ctx = await boot({
    online: () => true,
    rpc: (name,_count,payload) => name === 'rfq_pilot_request_shift' ? { status: 200, data: 'req-1' }
      : name === 'rfq_pilot_post_invoice_guarded' ? { status: 200, data: { invoice_id:payload.p_invoice,number: 7 } }
      : name === 'rfq_pilot_close_shift' ? { status: 200, data: { variance_cents: 0 } }
      : { status: 200, data: [] },
    tables: () => [],
  });
  try {
    ctx.bridge.meta.set('shift_map:' + STORE + ':' + LOCAL_SHIFT, 'srv-1');
    ctx.bridge.ops.set('so-1', { id: 'so-1', kind: 'shift_open', payload: JSON.stringify({ _store: STORE, p_store: STORE, _local: { id: LOCAL_SHIFT, opening_cents: 1 } }), status: 'queued', attempts: 0, serverRef: '', note: '', queuedAt: '2026-01-01T09:00:00Z' });
    ctx.bridge.ops.set('inv-late', { id: 'inv-late', kind: 'invoice', payload: JSON.stringify({ _store: STORE, ...testInvoicePayload('i-late',LOCAL_SHIFT,1,1) }), status: 'queued', attempts: 0, serverRef: '', note: '', queuedAt: '2026-01-01T05:00:00Z' });
    ctx.bridge.ops.set('sc-early', { id: 'sc-early', kind: 'shift_close', payload: JSON.stringify({ _store: STORE, p_shift: LOCAL_SHIFT, p_counted_cents: 1, p_event: 'e1' }), status: 'queued', attempts: 0, serverRef: '', note: '', queuedAt: '2026-01-01T00:00:00Z' });
    await ctx.w.eval('syncPush()');
    const order = ctx.calls.filter(c => ['rfq_pilot_request_shift', 'rfq_pilot_post_invoice_guarded', 'rfq_pilot_close_shift'].includes(c));
    assert.deepEqual(order, ['rfq_pilot_request_shift', 'rfq_pilot_post_invoice_guarded', 'rfq_pilot_close_shift'], 'الترتيب مناعة عن انقلاب الساعة');
  } finally { ctx.close(); }
});

test('دين المالك دون نت: رسالة الحفظ المؤقت الصادقة عبر نموذج حقيقي', async () => {
  const ctx = await boot({ online: () => false, rpc: () => ({ status: 200, data: {} }) });
  try {
    ctx.w.eval(`state.role='owner';state.customers=[];renderCustomers();`);
    ctx.w.eval(`document.getElementById('debtAmount').value='5';document.getElementById('debtReason').value='تجربة';`);
    ctx.w.eval(`document.getElementById('ownerDebtForm').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));`);
    await new Promise(r => setTimeout(r, 400));
    assert.match(ctx.w.eval(`document.getElementById('message').textContent`), /حُفظ دين المالك على الهاتف — مستند مؤقت/, 'رسالة الحفظ المؤقت صادقة');
    assert.equal([...ctx.bridge.ops.values()].some(o => o.kind === 'owner_debt' && o.status === 'queued'), true);
  } finally { ctx.close(); }
});

test('شرط المالك (6): عمود shift_id موجود وقيمته فارغة — approved وحدها لا تربط أي وردية مفتوحة', async () => {
  const SRV = '99999999-9999-4999-8999-999999999999';
  const REQ = 'aaaaaaaa-0000-4000-8000-00000000000a';
  let fillShift = false;
  const ctx = await boot({
    online: () => true,
    rpc: (name,_count,payload) => name === 'rfq_pilot_my_open_shift' ? { status: 200, data: { id: SRV } }
      : name === 'rfq_pilot_request_shift' ? { status: 200, data: REQ }
      : name === 'rfq_pilot_post_invoice_guarded' ? {status:200,data:mockInvoiceAck(payload,39)}
      : { status: 200, data: [] },
    tables: (tbl) => tbl === 'shift_requests'
      ? [{ id: REQ, status: 'approved', shift_id: fillShift ? SRV : null }]
      : [],
  });
  try {
    ctx.w.eval(SETUP_LOCAL_SHIFT);
    ctx.w.eval(`ofxQueue('invoice',${JSON.stringify(testInvoicePayload('inv-39',LOCAL_SHIFT))},'inv-39');`);
    await ctx.w.eval('syncPush()');
    await ctx.w.eval('syncPush()');
    const so = ctx.bridge.ops.get('shift_open:' + LOCAL_SHIFT);
    assert.equal(so.status, 'sent_awaiting_owner', 'معلّقة — لا ربط بالموافقة وحدها');
    assert.ok(!ctx.bridge.meta.has('shift_map:' + STORE + ':' + LOCAL_SHIFT), 'الوردية المفتوحة ' + SRV + ' لم تُربط بالطلب');
    assert.equal(ctx.bridge.ops.get('inv-39').status, 'queued', 'البيع المرتبط يبقى في الطابور بأمان — لا دفع على ربط غير مثبت');
    assert.ok(so.note.includes(REQ), 'المعرّف الكامل للطلب ظاهر للمراجعة في سبب التعليق');
    fillShift = true; // الخادم يثبت الارتباط: صف الطلب صار يحمل معرف ورديته الكامل
    await ctx.w.eval('syncPush()');
    assert.equal(ctx.bridge.meta.get('shift_map:' + STORE + ':' + LOCAL_SHIFT), SRV, 'الربط بالمعرّف الكامل كما هو — بلا اقتطاع أو تغيير');
    assert.equal(ctx.bridge.ops.get('shift_open:' + LOCAL_SHIFT).status, 'confirmed');
    assert.equal(ctx.bridge.ops.get('inv-39').status, 'confirmed', 'وبعد ثبوت الارتباط يُدفع البيع المرتبط');
  } finally { ctx.close(); }
});

test('شرط المالك (6): المعرّف الكامل متاح للمراجعة في مركز المزامنة — لا اكتفاء بالمقتطع', async () => {
  const FULL = '33333333-0000-4000-8000-000000000003';
  const ctx = await boot({ online: () => true, rpc: () => ({ status: 200, data: [] }) });
  try {
    ctx.bridge.ops.set(FULL, { id: FULL, kind: 'invoice', payload: JSON.stringify({ _store: STORE, p_shift: 's', p_device: 'd1', p_invoice: 'p40' }), status: 'conflict', attempts: 1, serverRef: '', note: 'تعارض تجربة', queuedAt: '2026-01-01T00:00:00Z' });
    ctx.w.eval(`state.role='owner';renderOfflineCenter();`);
    const home = ctx.w.eval(`document.getElementById('homeView').textContent`);
    assert.ok(home.includes('المعرّف الكامل'), 'عنوان المعرّف الكامل معروض في مركز المزامنة');
    assert.ok(home.includes(FULL), 'المعرّف الكامل نفسه متاح للمالك — ليس المقتطع وحده');
  } finally { ctx.close(); }
});

test('شرط المالك (7): طلب وردية أقدم من 100 سجل يُعالج — مع عزل صارم لعمليات المتاجر', async () => {
  const ctx = await boot({
    online: () => true, listLimit: 100,
    rpc: (name) => name === 'rfq_pilot_my_open_shift' ? { status: 200, data: { id: 'srv-shift-old' } } : { status: 200, data: [] },
    tables: (tbl) => tbl === 'shift_requests' ? [{ id: 'req-old', status: 'approved', shift_id: 'srv-shift-old' }] : [],
  });
  try {
    // طلب قديم بحالة sent_awaiting_owner — ليس في «المعلّقة» وخرج من حد العرض 100
    ctx.bridge.ops.set('shift_open:' + LOCAL_SHIFT, { id: 'shift_open:' + LOCAL_SHIFT, kind: 'shift_open', payload: JSON.stringify({ _store: STORE, p_store: STORE, _local: { id: LOCAL_SHIFT, opening_cents: 1 } }), status: 'sent_awaiting_owner', attempts: 1, serverRef: 'req-old', note: 'وصل الطلب', queuedAt: '2025-12-01T00:00:00Z' });
    for (let i = 0; i < 120; i++) ctx.bridge.ops.set('n' + i, { id: 'n' + i, kind: 'invoice', payload: JSON.stringify({ _store: STORE, p_shift: 'srv-x', p_device: 'd1', p_invoice: 'i' + i, p_customer: null, p_lines: [], p_cash_cents: 1, p_sms_consent: false }), status: 'confirmed', attempts: 1, serverRef: String(i), note: '', queuedAt: '2026-01-01T00:00:0' + (i % 10) + 'Z' });
    // طلب متجر آخر في قائمة المراجعة: عزله صارم — لا يُعالَج في هذه الجلسة إطلاقًا
    ctx.bridge.ops.set('shift_open:OTHER', { id: 'shift_open:OTHER', kind: 'shift_open', payload: JSON.stringify({ _store: STORE_B, p_store: STORE_B }), status: 'sent_awaiting_owner', attempts: 1, serverRef: 'req-other-store', note: '', queuedAt: '2025-11-01T00:00:00Z' });
    ctx.bridge.meta.set('local_shift:' + STORE, JSON.stringify({ id: LOCAL_SHIFT, opening_cents: 1 }));
    await ctx.w.eval('syncPush()');
    assert.ok(ctx.calls.includes('table:shift_requests'), 'المحرك سأل عن حالة الطلب القديم — لم يتجمد خارج حد العرض 100');
    assert.equal(ctx.bridge.meta.get('shift_map:' + STORE + ':' + LOCAL_SHIFT), 'srv-shift-old', 'وربطه بدليل صف الطلب نفسه الكامل');
    assert.equal(ctx.bridge.ops.get('shift_open:' + LOCAL_SHIFT).status, 'confirmed');
    assert.ok(!ctx.bridge.meta.has('shift_map:' + STORE + ':OTHER'), 'وردية المتجر الآخر لم تُربط — عزل صارم');
    assert.equal(ctx.bridge.ops.get('shift_open:OTHER').status, 'sent_awaiting_owner', 'وحالته لم تُمس في هذه الجلسة');
  } finally { ctx.close(); }
});

test('شرط المالك (7): الجلسة تنجو من انتهاء الرمز دون نت — فتحان من نفس التخزين ثم عودة الإنترنت والتجديد والمزامنة', async () => {
  const persist = new Map(); // رف تخزين واحد متسلسل بين الفتحين — بلا إعادة بذر للجلسة
  persist.set('rafiq-test-web-config', JSON.stringify({ url: URL0, key: KEY }));
  persist.set('rafiq-cloud-session-v1', JSON.stringify({ url: URL0, key: KEY, access: 'old', refreshToken: 'r', expiresAt: Date.now() - 60000, user: { id: 'u1', email: 'w@t.test' } }));
  persist.set('rafiq-cloud-membership-v1', JSON.stringify({ userId: 'u1', store: STORE, role: 'worker' }));
  persist.set('rafiq-worker-state-v1', JSON.stringify({ userId: 'u1', store: STORE, approved: true, lease: true, shift: 'srv-cached', at: '' }));
  const net = { v: false };
  const openOnce = async () => {
    const ctx = await boot({ online: () => net.v, noState: true, rpc: (name,_n,payload) => name === 'rfq_pilot_post_invoice_guarded' ? {status:200,data:mockInvoiceAck(payload,5)} : { status: 200, data: [] } });
    const ls = ctx.w.localStorage;
    for (const [k, v] of persist) ls.setItem(k, v);
    // نطاق lib.mjs (Node) يرى نفس تخزين النافذة — رف واحد فعلي لكلا النطاقين (يسد فجوة JSDOM)
    globalThis.localStorage = {
      getItem: (k) => ls.getItem(k), setItem: (k, v) => ls.setItem(k, v),
      removeItem: (k) => ls.removeItem(k), clear: () => ls.clear(),
      key: (i) => ls.key(i), get length() { return ls.length; },
    };
    await ctx.w.eval('tryRestoreSession()');
    return { ctx, ls };
  };
  const closeOpen = (op) => {
    try {
      persist.clear();
      for (let i = 0; i < op.ls.length; i++) { const k = op.ls.key(i); persist.set(k, op.ls.getItem(k)); }
    } finally { delete globalThis.localStorage; op.ctx.close(); }
  };
  // الفتح الأول: رمز منتهٍ + لا نت — دخول مؤقت صادق، ومحاولة التجديد الفاشلة يجب ألا تمحو الجلسة
  const op1 = await openOnce();
  try {
    assert.equal(op1.ctx.w.eval('state.store'), STORE, 'الفتح الأول: دخل المتجر مؤقتًا دون نت برمز منتهٍ');
  } finally { closeOpen(op1); }
  assert.ok(persist.has('rafiq-cloud-session-v1'), 'فشل التجديد بعطل شبكة عابر لم يمسح الجلسة المحفوظة');
  // الفتح الثاني: من نفس الرف دون إعادة بذر — ثم عودة الإنترنت: تجديد فعلي ثم مزامنة
  const op2 = await openOnce();
  try {
    assert.equal(op2.ctx.w.eval('state.store'), STORE, 'الفتح الثاني: استُعيد المتجر من نفس التخزين دون إعادة بذر');
    net.v = true;
    const prevFetch = globalThis.fetch;
    globalThis.fetch = async (url, opt) => {
      if (String(url).includes('/auth/v1/token')) {
        const body = { access_token: 't2', refresh_token: 'r2', expires_in: 3600, user: { id: 'u1' } };
        return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body, headers: { get: () => null } };
      }
      return prevFetch(url, opt);
    };
    try {
      op2.ctx.w.eval(`ofxQueue('invoice',${JSON.stringify(testInvoicePayload('inv-42','srv-cached'))},'inv-42');`);
      await op2.ctx.w.eval('syncAll()');
      assert.equal(op2.ctx.w.eval('state.api.access'), 't2', 'عودة الإنترنت: الرمز المنتهي جُدّد فعليًا');
      assert.equal(JSON.parse(op2.ls.getItem('rafiq-cloud-session-v1')).access, 't2', 'والرمز الجديد حُفظ في نفس التخزين المتسلسل');
      assert.equal(op2.ctx.bridge.ops.get('inv-42').status, 'confirmed', 'والمزامنة اكتملت بعد التجديد — بلا دخول ثانٍ ولا فقد للعملية');
    } finally { globalThis.fetch = prevFetch; }
  } finally { closeOpen(op2); }
});

test('شرط المالك (7): خطأ 503 لا يعيد طلب الوردية بلا عهدة — يبقى في الطابور ويُعاد كاملًا', async () => {
  let healthy = false;
  const ctx = await boot({
    online: () => true,
    rpc: (name) => name === 'rfq_pilot_request_shift'
      ? (healthy ? { status: 200, data: 'req-1' } : { status: 503, data: { message: 'Service Unavailable' } })
      : { status: 200, data: [] },
    tables: () => [],
  });
  try {
    ctx.w.eval(SETUP_LOCAL_SHIFT);
    await ctx.w.eval('syncPush()');
    let bodies = ctx.bodies.filter(b => b.path.includes('request_shift')).map(b => JSON.parse(b.body));
    assert.equal(bodies.length, 1, 'محاولة واحدة فقط — 503 ليس ترخيصًا لإعادة الإرسال بلا عهدة');
    assert.equal(bodies[0].p_opening_cents, 50000, 'والمحاولة حملت العهدة كاملة');
    assert.equal(ctx.bridge.ops.get('shift_open:' + LOCAL_SHIFT).status, 'queued', 'والطلب بقي في الطابور — لا مؤكدًا ولا تعارضًا');
    healthy = true;
    await ctx.w.eval('syncPush()');
    bodies = ctx.bodies.filter(b => b.path.includes('request_shift')).map(b => JSON.parse(b.body));
    assert.equal(bodies.length, 2, 'عند تعافي الخادم أُعيد الطلب مرة واحدة إضافية');
    assert.equal(bodies[1].p_opening_cents, 50000, 'وبالعهدة كاملة — لم تُسقط أبدًا');
    assert.equal(ctx.bridge.ops.get('shift_open:' + LOCAL_SHIFT).status, 'sent_awaiting_owner');
  } finally { ctx.close(); }
});

test('شرط المالك (7): النسخة المحلية تظهر فعلًا حين الجهاز متصل والخادم ساقط — القول يطابق الفعل', async () => {
  const ctx = await boot({
    online: () => true,
    rpc: () => ({ status: 503, data: { message: 'Service Unavailable' } }),
    tables: () => ({ status: 503, data: { message: 'Service Unavailable' } }),
  });
  try {
    ctx.bridge.mirror.set(STORE + ':products:p-mir', { tbl: STORE + ':products', id: 'p-mir', json: JSON.stringify({ id: 'p-mir', name: 'صنف من المرآة', price_cents: 1500, stock_milli: 3000 }) });
    await ctx.w.eval('safeRefresh()');
    assert.equal(ctx.w.eval('state.serverDown'), true, 'حالة «الخادم غير متاح» مسجلة');
    const home = ctx.w.eval(`document.getElementById('homeView').textContent`);
    assert.match(home, /الجهاز متصل بالشبكة لكن الخادم غير متاح/, 'والرسالة صادقة');
    assert.equal(ctx.w.eval('state.products.length'), 1, 'والحالة عُبئت من المرآة رغم أن الجهاز متصل');
    const opts = ctx.w.eval(`[...document.getElementById('saleProduct').options].map(o=>o.textContent).join('|')`);
    assert.ok(opts.includes('صنف من المرآة'), 'وصنف المرآة ظاهر فعلًا في قائمة البيع — لا رسالة بلا عرض');
  } finally { ctx.close(); }
});

test('شرط المالك (7): الحسم المحلي معطل مؤقتًا — التعارض محفوظ وظاهر للمالك بلا زرّي قرار', async () => {
  const FULL = '33333333-0000-4000-8000-000000000003';
  const ctx = await boot({ online: () => true, rpc: () => ({ status: 200, data: [] }) });
  try {
    ctx.bridge.ops.set(FULL, { id: FULL, kind: 'invoice', payload: JSON.stringify({ _store: STORE, p_shift: 's', p_device: 'd1', p_invoice: 'p45' }), status: 'conflict', attempts: 1, serverRef: '', note: 'تعارض محفوظ', queuedAt: '2026-01-01T00:00:00Z' });
    ctx.w.eval(`state.role='owner';renderOfflineCenter();`);
    const text = ctx.w.eval(`document.getElementById('homeView').textContent`);
    assert.match(text, /الحسم معطل مؤقتًا حتى اعتماد مسار التوثيق الخادمي 000503/, 'إعلان صريح: الحسم معطل مؤقتًا حتى التوثيق الخادمي');
    assert.ok(text.includes('المعرّف الكامل ' + FULL), 'والتعارض محفوظ وظاهر بمعرّفه الكامل');
    const labels = ctx.w.eval(`[...document.getElementById('homeView').querySelectorAll('button')].map(b=>b.textContent).join('|')`);
    assert.ok(!labels.includes('اعتماد كعملية جديدة برقم جديد'), 'زر الحسم الأول معطل (غير موجود)');
    assert.ok(!labels.includes('تسجيل الإلغاء محليًا'), 'وزر الحسم الثاني معطل (غير موجود)');
    assert.equal(ctx.bridge.ops.get(FULL).status, 'conflict', 'والعملية كما هي — لم تُحذف ولم تُعدَّل');
    assert.equal(ctx.bridge.meta.get('owner_local_decisions:' + STORE), undefined, 'ولم يُكتب أي سجل قرار محلي جديد');
  } finally { ctx.close(); }
});

test('شرط المالك (8): رد 500 بجسم نصي لا يمحو الجلسة عند التجديد — التصنيف برمز الاستجابة لا بالنص', async () => {
  const ctx = await boot({ online: () => true, noState: true, rpc: () => ({ status: 200, data: [] }) });
  const ls = ctx.w.localStorage;
  ls.setItem('rafiq-test-web-config', JSON.stringify({ url: URL0, key: KEY }));
  ls.setItem('rafiq-cloud-session-v1', JSON.stringify({ url: URL0, key: KEY, access: 'old', refreshToken: 'r', expiresAt: Date.now() - 60000, user: { id: 'u1', email: 'w@t.test' } }));
  ls.setItem('rafiq-cloud-membership-v1', JSON.stringify({ userId: 'u1', store: STORE, role: 'worker' }));
  ls.setItem('rafiq-worker-state-v1', JSON.stringify({ userId: 'u1', store: STORE, approved: true, lease: true, shift: 'srv-cached', at: '' }));
  globalThis.localStorage = { getItem: k => ls.getItem(k), setItem: (k, v) => ls.setItem(k, v), removeItem: k => ls.removeItem(k), clear: () => ls.clear(), key: i => ls.key(i), get length() { return ls.length; } };
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async (url, opt) => {
    if (String(url).includes('/auth/v1/token')) {
      const body = { message: 'Internal Server Error' }; // 500 بجسم نصي — حالة المراجع الأولى
      return { ok: false, status: 500, text: async () => JSON.stringify(body), json: async () => body, headers: { get: () => null } };
    }
    return prevFetch(url, opt);
  };
  try {
    await ctx.w.eval('tryRestoreSession()');
    assert.ok(!!ls.getItem('rafiq-cloud-session-v1'), 'رد 500 بجسم نصي لم يمسح الجلسة المحفوظة');
    assert.ok(!!ctx.w.eval('state.api'), 'ولم يهبط المستخدم للدخول — الخطأ صُنّف عابرًا برمز الاستجابة');
    assert.match(ctx.w.eval(`document.getElementById('message').textContent`), /خطأ خادم مؤقت/, 'ورسالة صادقة: خطأ خادم مؤقت والجلسة محفوظة');
  } finally { globalThis.fetch = prevFetch; delete globalThis.localStorage; ctx.close(); }
});

test('شرط المالك (8): رد 500 بجسم نصي لا يمنع عرض المرآة — serverDown تُقرَّر برمز الاستجابة', async () => {
  const ctx = await boot({
    online: () => true,
    rpc: () => ({ status: 500, data: { message: 'Internal Server Error' } }),
    tables: () => ({ status: 500, data: { message: 'Internal Server Error' } }),
  });
  try {
    ctx.bridge.mirror.set(STORE + ':products:p-mir', { tbl: STORE + ':products', id: 'p-mir', json: JSON.stringify({ id: 'p-mir', name: 'صنف من المرآة', price_cents: 1500, stock_milli: 3000 }) });
    await ctx.w.eval('safeRefresh()');
    assert.equal(ctx.w.eval('state.serverDown'), true, '500 بجسم نصي = خادم ساقط مؤقتًا — برمز الاستجابة');
    const home = ctx.w.eval(`document.getElementById('homeView').textContent`);
    assert.match(home, /الجهاز متصل بالشبكة لكن الخادم غير متاح/, 'والرسالة صادقة');
    const opts = ctx.w.eval(`[...document.getElementById('saleProduct').options].map(o=>o.textContent).join('|')`);
    assert.ok(opts.includes('صنف من المرآة'), 'والمرآة معروضة فعلًا — القول يطابق الفعل');
  } finally { ctx.close(); }
});

test('شرط المالك (8): رسالة عمل 400 فيها «does not exist» لا تُسقط العهدة — محاولة واحدة وتعارض صريح', async () => {
  const ctx = await boot({
    online: () => true,
    rpc: (name) => name === 'rfq_pilot_request_shift' ? { status: 400, data: { message: 'device does not exist' } } : { status: 200, data: [] },
    tables: () => [],
  });
  try {
    ctx.w.eval(SETUP_LOCAL_SHIFT);
    await ctx.w.eval('syncPush()');
    const bodies = ctx.bodies.filter(b => b.path.includes('request_shift')).map(b => JSON.parse(b.body));
    assert.equal(bodies.length, 1, 'محاولة واحدة — رسالة العمل ليست ترخيصًا لإعادة الإرسال بلا عهدة');
    assert.equal(bodies[0].p_opening_cents, 50000, 'والمحاولة حملت العهدة كاملة');
    const so = ctx.bridge.ops.get('shift_open:' + LOCAL_SHIFT);
    assert.equal(so.status, 'conflict', 'رفض عمل 400 = تعارض صريح ظاهر للمالك');
    assert.match(so.note, /device does not exist/, 'ورسالة الخادم محفوظة في التعارض');
    assert.ok(!/العهدة لم تُضمَّن/.test(so.note), 'بلا ادعاء كاذب بمسار «الخادم الأقدم»');
  } finally { ctx.close(); }
});

test('حارس (8): إبطال مؤكد invalid_grant يمحو الجلسة فعلًا — لا جلسة زومبي بعد الرموز الميتة', async () => {
  const ctx = await boot({ online: () => true, noState: true, rpc: () => ({ status: 200, data: [] }) });
  const ls = ctx.w.localStorage;
  ls.setItem('rafiq-test-web-config', JSON.stringify({ url: URL0, key: KEY }));
  ls.setItem('rafiq-cloud-session-v1', JSON.stringify({ url: URL0, key: KEY, access: 'old', refreshToken: 'used', expiresAt: Date.now() - 60000, user: { id: 'u1', email: 'w@t.test' } }));
  ls.setItem('rafiq-cloud-membership-v1', JSON.stringify({ userId: 'u1', store: STORE, role: 'worker' }));
  globalThis.localStorage = { getItem: k => ls.getItem(k), setItem: (k, v) => ls.setItem(k, v), removeItem: k => ls.removeItem(k), clear: () => ls.clear(), key: i => ls.key(i), get length() { return ls.length; } };
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async (url, opt) => {
    if (String(url).includes('/auth/v1/token')) {
      const body = { error: 'invalid_grant', error_description: 'Invalid Refresh Token: Already Used' };
      return { ok: false, status: 400, text: async () => JSON.stringify(body), json: async () => body, headers: { get: () => null } };
    }
    return prevFetch(url, opt);
  };
  try {
    await ctx.w.eval('tryRestoreSession()');
    assert.equal(ls.getItem('rafiq-cloud-session-v1'), null, 'الإبطال الخادمي المؤكد (400 invalid_grant) مسح الجلسة من التخزين');
    assert.equal(ctx.w.eval('state.api'), null, 'ولم يدخل المستخدم مؤقتًا برمز ميت');
  } finally { globalThis.fetch = prevFetch; delete globalThis.localStorage; ctx.close(); }
});

test('شرط المالك (9): تجديد 400 يحمل نص «unavailable» لا يمحو الجلسة المحفوظة — نص الأعمال ليس إبطالًا مؤكدًا', async () => {
  const ctx = await boot({ online: () => true, noState: true, rpc: () => ({ status: 200, data: [] }) });
  const ls = ctx.w.localStorage;
  ls.setItem('rafiq-test-web-config', JSON.stringify({ url: URL0, key: KEY }));
  ls.setItem('rafiq-cloud-session-v1', JSON.stringify({ url: URL0, key: KEY, access: 'old', refreshToken: 'r', expiresAt: Date.now() - 60000, user: { id: 'u1', email: 'w@t.test' } }));
  ls.setItem('rafiq-cloud-membership-v1', JSON.stringify({ userId: 'u1', store: STORE, role: 'worker' }));
  globalThis.localStorage = { getItem: k => ls.getItem(k), setItem: (k, v) => ls.setItem(k, v), removeItem: k => ls.removeItem(k), clear: () => ls.clear(), key: i => ls.key(i), get length() { return ls.length; } };
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async (url, opt) => {
    if (String(url).includes('/auth/v1/token')) {
      const body = { message: 'Service temporarily unavailable' }; // 400 أعمال بنص outage — مسبار المراجع
      return { ok: false, status: 400, text: async () => JSON.stringify(body), json: async () => body, headers: { get: () => null } };
    }
    return prevFetch(url, opt);
  };
  try {
    await ctx.w.eval('tryRestoreSession()');
    assert.ok(!!ls.getItem('rafiq-cloud-session-v1'), 'رد 400 بأعمال (نص unavailable) لم يمسح الجلسة المحفوظة');
    assert.equal(ctx.w.eval('state.api'), null, 'وعاد للدخول بصدق بدل ادعاء «خطأ خادم مؤقت» سيبقيه على رمز مرفوض');
  } finally { globalThis.fetch = prevFetch; delete globalThis.localStorage; ctx.close(); }
});

test('شرط المالك (9): رد 429 (حد المعدل) عند التجديد لا يمحو الجلسة — عابر، والجلسة محفوظة مع إعادة المحاولة', async () => {
  const ctx = await boot({ online: () => true, noState: true, rpc: () => ({ status: 200, data: [] }) });
  const ls = ctx.w.localStorage;
  ls.setItem('rafiq-test-web-config', JSON.stringify({ url: URL0, key: KEY }));
  ls.setItem('rafiq-cloud-session-v1', JSON.stringify({ url: URL0, key: KEY, access: 'old', refreshToken: 'r', expiresAt: Date.now() - 60000, user: { id: 'u1', email: 'w@t.test' } }));
  ls.setItem('rafiq-cloud-membership-v1', JSON.stringify({ userId: 'u1', store: STORE, role: 'worker' }));
  globalThis.localStorage = { getItem: k => ls.getItem(k), setItem: (k, v) => ls.setItem(k, v), removeItem: k => ls.removeItem(k), clear: () => ls.clear(), key: i => ls.key(i), get length() { return ls.length; } };
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async (url, opt) => {
    if (String(url).includes('/auth/v1/token')) {
      const body = { message: 'Rate limit exceeded' }; // 429 — مسبار المراجع الثالث
      return { ok: false, status: 429, text: async () => JSON.stringify(body), json: async () => body, headers: { get: () => null } };
    }
    return prevFetch(url, opt);
  };
  try {
    await ctx.w.eval('tryRestoreSession()');
    assert.ok(!!ls.getItem('rafiq-cloud-session-v1'), '429 لم يمسح الجلسة المحفوظة — حد المعدل عابر لا إبطال');
    assert.ok(!!ctx.w.eval('state.api'), 'وصُنّف عابرًا برمز الاستجابة — لم يهبط المستخدم للدخول');
    assert.match(ctx.w.eval(`document.getElementById('message').textContent`), /جلستك محفوظة/, 'ورسالة صادقة: الجلسة محفوظة وستُعاد المحاولة');
  } finally { globalThis.fetch = prevFetch; delete globalThis.localStorage; ctx.close(); }
});

test('شرط المالك (9): رفض توقيع يذكر اسم الدالة وحده دون p_opening_cents لا يُسقط العهدة — محاولة واحدة وتعارض صريح', async () => {
  const ctx = await boot({
    online: () => true,
    rpc: (name) => name === 'rfq_pilot_request_shift' ? { status: 400, data: { message: 'could not find the function rafiq_public.rfq_pilot_request_shift(uuid, integer, text)' } } : { status: 200, data: [] },
    tables: () => [],
  });
  try {
    ctx.w.eval(SETUP_LOCAL_SHIFT);
    await ctx.w.eval('syncPush()');
    const bodies = ctx.bodies.filter(b => b.path.includes('request_shift')).map(b => JSON.parse(b.body));
    assert.equal(bodies.length, 1, 'محاولة واحدة — ذكر اسم الدالة وحده ليس ترخيصًا بإسقاط العهدة');
    assert.equal(bodies[0].p_opening_cents, 50000, 'والمحاولة حملت العهدة كاملة');
    const so = ctx.bridge.ops.get('shift_open:' + LOCAL_SHIFT);
    assert.equal(so.status, 'conflict', 'رفض لا يسمّي المعامل p_opening_cents صراحة = تعارض ظاهر للمالك');
    assert.ok(!/العهدة لم تُضمَّن/.test(so.note), 'بلا ادعاء كاذب بمسار «الخادم الأقدم»');
  } finally { ctx.close(); }
});

test('شرط المالك (9): نص «unavailable» مع رمز 400 في الطابور = تعارض صريح، لا بقاء عابرًا في الطابور إلى الأبد', async () => {
  const ctx = await boot({
    online: () => true,
    rpc: (name) => name === 'rfq_pilot_request_shift' ? { status: 400, data: { message: 'Service temporarily unavailable' } } : { status: 200, data: [] },
    tables: () => [],
  });
  try {
    ctx.w.eval(SETUP_LOCAL_SHIFT);
    await ctx.w.eval('syncPush()');
    const so = ctx.bridge.ops.get('shift_open:' + LOCAL_SHIFT);
    assert.equal(so.status, 'conflict', 'رد أعمال 400 — ولو حمل نص outage — تعارض صريح لا صمت في الطابور');
    assert.match(so.note, /unavailable/i, 'ورسالة الخادم محفوظة في التعارض كما هي');
    const bodies = ctx.bodies.filter(b => b.path.includes('request_shift'));
    assert.equal(bodies.length, 1, 'محاولة واحدة — لا إعادة إرسال متكررة خلف نص عابر');
  } finally { ctx.close(); }
});

test('شرط المالك (9): زر الأرشيف الظاهر مخفي — القراءة والتصدير باقيان وآلية الفتح لم تُحذف', async () => {
  const ctx = await boot({ online: () => true, rpc: () => ({ status: 200, data: [] }), tables: () => [] });
  try {
    assert.equal(ctx.w.eval(`document.getElementById('openArchive').classList.contains('hide')`), true, 'زر «فتح أرشيف الهاتف» صار مخفيًا من الواجهة');
    for (const id of ['exportInvoices', 'exportCustomers', 'exportDebts']) {
      assert.equal(ctx.w.eval(`document.getElementById('${id}').classList.contains('hide')`), false, `تصدير ${id}بقى ظاهرًا — القراءة والتصدير لم يُمسّا`);
    }
    assert.equal(ctx.w.eval(`typeof document.getElementById('openArchive').onclick`), 'function', 'آلية فتح الأرشيف بقيت مربوطة بالجسر — إخفاء لا حذف');
  } finally { ctx.close(); }
});

test('شرط المالك (9): إقلاع بلا إعداد سحابي: الشاشة الموحدة في وضع التهيئة — الحفظ عبر الجسر ثم إعادة الإقلاع، والدفتر القديم لا يُفتح', async () => {
  const ctx = await boot({ online: () => true, noState: true, embedded: true, configStatus: 404, rpc: () => ({ status: 200, data: [] }) });
  try {
    await new Promise(r => setTimeout(r, 40)); // مهلة تحميل التهيئة غير الموجود (404)
    assert.equal(ctx.w.eval(`document.getElementById('setupScreen').classList.contains('hide')`), false, 'شاشة التهيئة هي الظاهرة — لا دفتر قديم ولا طريق مسدود');
    assert.match(ctx.w.eval(`document.getElementById('message').textContent`), /لم يُهيَّأ بعد|أدخل رابطه/i, 'ورسالة صادقة تطلب تهيئة المشروع');
    const saved = []; const restarts = [];
    ctx.bridge.savePilotConfiguration = (u, k) => { saved.push({ u, k }); return '{"ok":true}'; };
    ctx.bridge.restartForConfiguration = () => { restarts.push(1); return '{"ok":true}'; };
    ctx.w.eval(`document.getElementById('projectUrl').value='${URL0}';document.getElementById('publicKey').value='${KEY}';`);
    ctx.w.eval(`document.getElementById('setupForm').dispatchEvent(new Event('submit',{cancelable:true,bubbles:true}))`);
    await new Promise(r => setTimeout(r, 80));
    assert.deepEqual(saved, [{ u: URL0, k: KEY }], 'التكوين يُسلَّم للجسر (يُشفَّر في Keystore الهاتف) — لا تخزين WebView');
    assert.equal(restarts.length, 1, 'وبعد الحفظ تُعاد الشاشة الرئيسية لتقلع الواجهة الموحدة بالتكوين الجديد');
    assert.equal(ctx.w.eval(`localStorage.getItem('rafiq-test-web-config')`), null, 'وفي وضع الهاتف لا يُكتب أي تكوين في تخزين WebView');
  } finally { ctx.close(); }
});

// ===== شرط المالك (10): ملاحظات المراجع على rev2 — 400 بنص «Network unavailable»، ذكر الأرشيف في بطاقة التصدير، وقراءة الإقلاع من Room =====

test('شرط المالك (10): 400 بنص «Network unavailable» عند استعادة الجلسة رد أعمال — لا دخول مؤقت بلا اتصال ولا مسح للجلسة', async () => {
  const ctx = await boot({ online: () => true, noState: true, rpc: () => ({ status: 200, data: [] }) });
  const ls = ctx.w.localStorage;
  ls.setItem('rafiq-test-web-config', JSON.stringify({ url: URL0, key: KEY }));
  ls.setItem('rafiq-cloud-session-v1', JSON.stringify({ url: URL0, key: KEY, access: 'old', refreshToken: 'r', expiresAt: Date.now() - 60000, user: { id: 'u1', email: 'w@t.test' } }));
  ls.setItem('rafiq-cloud-membership-v1', JSON.stringify({ userId: 'u1', store: STORE, role: 'worker' }));
  globalThis.localStorage = { getItem: k => ls.getItem(k), setItem: (k, v) => ls.setItem(k, v), removeItem: k => ls.removeItem(k), clear: () => ls.clear(), key: i => ls.key(i), get length() { return ls.length; } };
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async (url, opt) => {
    if (String(url).includes('/auth/v1/token')) {
      const body = { message: 'Network unavailable' }; // 400 أعمال بنص شبكي — مسبار المراجع المستقل
      return { ok: false, status: 400, text: async () => JSON.stringify(body), json: async () => body, headers: { get: () => null } };
    }
    return prevFetch(url, opt);
  };
  try {
    await ctx.w.eval('tryRestoreSession()');
    assert.ok(!!ls.getItem('rafiq-cloud-session-v1'), 'الجلسة المحفوظة لم تُمسح — رد أعمال ليس إبطالًا');
    assert.equal(ctx.w.eval('state.api'), null, 'الخادم رد (400) — ليس انقطاعًا: لا دخول مؤقت بلا اتصال برمز مرفوض');
    assert.equal(ctx.w.eval('state.offlineNow'), false, 'لا يُدّعى وضع عدم الاتصال مع وجود رد أعمال صريح');
    assert.ok(!/لا يوجد اتصال/.test(ctx.w.eval(`document.getElementById('message').textContent`)), 'والرسالة لا تدعي انقطاعًا كاذبًا');
  } finally { globalThis.fetch = prevFetch; delete globalThis.localStorage; ctx.close(); }
});

test('شرط المالك (10): 400 بنص «Network unavailable» عند إرسال فاتورة = خطأ صريح — لا طابور «بانتظار المزامنة» ولا مستند مؤقت', async () => {
  const ctx = await boot({
    online: () => true,
    rpc: (name) => name === 'rfq_pilot_post_invoice_guarded' ? { status: 400, data: { message: 'Network unavailable' } } : { status: 200, data: [] },
    tables: () => [],
  });
  try {
    ctx.w.eval(SALE);
    await assert.rejects(() => ctx.w.eval('submitPending()'), /Network unavailable/i, 'رد الأعمال يظهر خطأً صريحًا للمستخدم لا صمتًا');
    assert.equal(ctx.bridge.ops.size, 0, 'طابور المزامنة فارغ — العملية لم تتحول لمستند مؤقت بسبب رد أعمال');
    assert.ok(ctx.w.eval('!!getPending()'), 'والعملية المعلقة باقية — لم تُعرض كمنجزة ولم تُطوى بصمت');
  } finally { ctx.close(); }
});

test('شرط المالك (10): ذكر الأرشيف زال من عنوان بطاقة التصدير ووصفها — القراءة والتصدير باقيان ولا يُحذف شيء', async () => {
  const ctx = await boot({ online: () => true, rpc: () => ({ status: 200, data: [] }), tables: () => [] });
  try {
    const title = ctx.w.eval(`document.getElementById('exportInvoices').closest('.card').querySelector('h2').textContent`);
    const desc = ctx.w.eval(`document.getElementById('exportInvoices').closest('.card').querySelector('p.muted').textContent`);
    assert.ok(!/أرشيف/i.test(title), `عنوان بطاقة التصدير بلا ذكر أرشيف (الحالي: «${title}»)`);
    assert.ok(!/أرشيف/i.test(desc), `ووصفها بلا ذكر أرشيف (الحالي: «${desc}»)`);
    assert.match(desc, /القراءة والتصدير/, 'الوصف ما زال يعد القراءة والتصدير بعد انتهاء الاشتراك');
    assert.match(desc, /ولا يُحذف شيء/, 'وعد «لا يُحذف شيء» باقٍ — الإخفاء ليس حذفًا');
    for (const id of ['exportInvoices', 'exportCustomers', 'exportDebts']) {
      assert.equal(ctx.w.eval(`document.getElementById('${id}').classList.contains('hide')`), false, `زر التصدير ${id} ما زال ظاهرًا`);
    }
    assert.equal(ctx.w.eval(`document.getElementById('openArchive').classList.contains('hide')`), true, 'زر الفتح ما زال مخفيًا');
    assert.equal(ctx.w.eval(`typeof document.getElementById('openArchive').onclick`), 'function', 'وآلية الفتح ما زالت مربوطة — إخفاء لا حذف');
  } finally { ctx.close(); }
});

test('شرط المالك (10): قراءة إعداد الإقلاع من Room انتقلت عن الخيط الرئيسي — عامل خلفي، واختبار الإعداد المحفوظ موجود', () => {
  const kt = readFileSync(new URL('../../app/src/main/java/net/arena/rafiq/MainActivity.kt', import.meta.url), 'utf8');
  assert.match(kt, /bootWorker\.execute\s*\{[\s\S]{0,400}?pilotConfigurationForLaunch\(\)/, 'قراءة إعداد الإقلاع تتم داخل عامل خلفي');
  assert.ok(!/if \(!archiveMode\) \{\s*val launchCfg = try \{ api\.pilotConfigurationForLaunch\(\)/.test(kt), 'لا قراءة متزامنة على الخيط الرئيسي في onCreate');
  assert.match(kt, /cloudStorageOverride \?: KeystoreCloudConfigurationStorage/, 'وصلة اختبار CI للإعداد المحفوظ — الإنتاج يبقى Keystore');
  assert.match(kt, /bootWorker\.shutdown\(\)/, 'والعامل يُغلق في onDestroy');
  const tst = readFileSync(new URL('../../app/src/test/java/net/arena/rafiq/MainActivityLaunchTest.kt', import.meta.url), 'utf8');
  assert.match(tst, /fun savedCloudConfigurationLaunchesUnifiedPilotWithConfigurationExtras/, 'اختبار حالة الإعداد المحفوظ (Robolectric) موجود — يُنفَّذ في CI ويُتحقق هنا静态ً');
});

// R60–R64: sale durability at the actual Android/WebView boundary; no real server or SQL.
test('R60: Android sends only a Room-queued sale and retries the identical id after WebView death and lost ACK', async () => {
  const durable=makeBridge(), key=`rafiq-test-pending-sale:${STORE}:u1`;
  let id=null, lostAck=true, committed=0;
  const params={embedded:true,sharedBridge:durable,online:()=>true,tables:matchingSaleLines,rpc:(name,_count,payload)=>{
    if(name==='rfq_pilot_post_invoice_v3'){
      if(!id)id=payload.p_invoice;
      assert.equal(payload.p_invoice,id,'retry never generates a different invoice id');
      assert.equal(durable.ops.get(id)?.status,'queued','the complete Room outbox entry exists BEFORE the RPC');
      assert.equal(JSON.parse(durable.ops.get(id).payload)._snapshot[0].price_cents,100);
      assert.equal(durable.meta.get(key),'','the staging intent is cleared: syncPush is the only sender');
      if(lostAck){committed++;throw Error('Failed to fetch');} // server commits but response disappears
      return {status:200,data:{invoice_id:id,number:9,total_cents:100,due_cents:0,already_committed:true}};
    }
    return {status:200,data:[]};
  }};
  const first=await boot(params);
  await new Promise(done=>setImmediate(done));
  try {
    first.w.eval(`state.shift='s';state.api.access='t';state.api.expiresAt=Date.now()+3600000;state.cart=[{product_id:'p',name:'Tea',price_cents:100,qty_milli:1000}];
      document.getElementById('cashPaid').value='1';
      document.getElementById('saleForm').dispatchEvent(new Event('submit',{cancelable:true,bubbles:true}));`);
    await new Promise(done=>setTimeout(done,45));
    assert.match(id,/^[0-9a-f-]{36}$/i);
    assert.equal(committed,1);
    assert.equal(durable.ops.get(id).status,'queued','lost ACK is not treated as confirmation');
    assert.equal(first.w.eval('state.invoice.provisional'),true);
    assert.match(first.w.document.getElementById('printArea').textContent,new RegExp(id));
    assert.equal(first.w.sessionStorage.getItem(key),null,'Android does not rely on WebView session');
  } finally {first.close();}
  const second=await boot(params);
  await new Promise(done=>setImmediate(done));
  try {
    second.w.eval("state.shift='s';state.api.access='t';state.api.expiresAt=Date.now()+3600000;restoreQueuedSale()");
    assert.equal(second.w.eval('state.invoice.localId'),id,'provisional document recovers from Room on reopen');
    assert.equal(second.w.eval('state.invoice.provisional'),true);
    lostAck=false;
    await second.w.eval('syncAll()');
    assert.equal(committed,1,'retry did not charge a second invoice in the mock server');
    const sent=[...first.bodies,...second.bodies].filter(x=>x.path.endsWith('/rpc/rfq_pilot_post_invoice_v3')).map(x=>JSON.parse(x.body).p_invoice);
    assert.deepEqual(sent,[id,id],'server idempotency key is unchanged across processes');
    assert.equal(durable.ops.get(id).status,'confirmed');
    assert.equal(second.w.eval('state.invoice.number'),9,'only a matching server reply makes the document final');
    assert.match(second.w.document.getElementById('printArea').textContent,/فاتورة رقم 9/);
  } finally {second.close();}
});

test('R61: Android rejects sale before any network request if Room claims success without persisting', async () => {
  const ctx=await boot({embedded:true,online:()=>true,rpc:()=>({status:200,data:{invoice_id:'x',number:1,total_cents:100,due_cents:0}})});
  await new Promise(done=>setImmediate(done));
  try {
    ctx.bridge.metaSet=()=>'{"ok":true}'; // fake success with no corresponding read-back
    ctx.w.eval(`state.shift='s';state.api.access='t';state.api.expiresAt=Date.now()+3600000;state.cart=[{product_id:'p',name:'Tea',price_cents:100,qty_milli:1000}];
      document.getElementById('cashPaid').value='1';
      document.getElementById('saleForm').dispatchEvent(new Event('submit',{cancelable:true,bubbles:true}));`);
    await new Promise(done=>setTimeout(done,25));
    assert.equal(ctx.calls.includes('rfq_pilot_post_invoice_guarded'),false,'do not send a sale that was not durably recorded');
    assert.match(ctx.w.document.getElementById('message').textContent,/حفظ|تخزين|قاعدة الهاتف/);
  } finally {ctx.close();}
});

test('R62: a legacy Android session sale is migrated to Room before its session copy is removed', async () => {
  const ctx=await boot({embedded:true,online:()=>false,rpc:()=>({status:200,data:[]})});
  await new Promise(done=>setImmediate(done));
  try {
    const key=`rafiq-test-pending-sale:${STORE}:u1`;
    ctx.w.sessionStorage.setItem(key,JSON.stringify({id:'old-1',payload:{p_invoice:'old-1',p_cash_cents:1},snapshot:[]}));
    assert.equal(ctx.w.eval('getPending().id'),'old-1');
    assert.equal(JSON.parse(ctx.bridge.meta.get(key)||'null')?.id,'old-1');
    assert.equal(ctx.w.sessionStorage.getItem(key),null);
  } finally {ctx.close();}
});

test('R63: web-only preview retains sessionStorage behaviour without depending on the Android bridge', async () => {
  const ctx=await boot({online:()=>false,rpc:()=>({status:200,data:[]})});
  try {
    ctx.w.eval("setPending({id:'preview-1',payload:{p_invoice:'preview-1'},snapshot:[]})");
    assert.equal(ctx.w.eval('getPending().id'),'preview-1');
    assert.equal(ctx.bridge.meta.size,0);
  } finally {ctx.close();}
});

test('R64: empty server acknowledgement leaves the same Android sale in Room as provisional', async () => {
  const ctx=await boot({embedded:true,online:()=>true,rpc:name=>({status:200,data:name==='rfq_pilot_post_invoice_guarded'?null:[]})});
  await new Promise(done=>setImmediate(done));
  try {
    ctx.w.eval("state.shift='s';state.api.access='t';state.api.expiresAt=Date.now()+3600000;setPending({id:'inv-null',payload:{p_shift:'s',p_device:'d1',p_invoice:'inv-null',p_customer:null,p_lines:[{product_id:'p',qty_milli:1000}],p_cash_cents:100,p_sms_consent:false},snapshot:[{product_id:'p',name:'Tea',price_cents:100,qty_milli:1000}]})");
    await ctx.w.eval('submitPending()');
    assert.equal(ctx.calls.filter(x=>x==='rfq_pilot_post_invoice_guarded').length,1);
    assert.equal(ctx.bridge.ops.get('inv-null').status,'queued','do not settle a 200 without an invoice id and number');
    assert.equal(ctx.w.eval('state.invoice.provisional'),true);
    assert.equal(ctx.bridge.meta.get(`rafiq-test-pending-sale:${STORE}:u1`),'','staged intent is now represented by the outbox');
  } finally {ctx.close();}
});

test('R65: credit sale with changed server amount does not silently replace a customer-facing provisional amount', async () => {
  const ctx=await boot({embedded:true,online:()=>true,rpc:(name,_count,payload)=>name==='rfq_pilot_post_invoice_v3'
    ? {status:200,data:{invoice_id:payload.p_invoice,number:17,total_cents:120,due_cents:120}}
    : {status:200,data:[]}});
  await new Promise(done=>setImmediate(done));
  try {
    ctx.w.eval(`state.shift='s';state.api.access='t';state.api.expiresAt=Date.now()+3600000;state.cart=[{product_id:'p',name:'Tea',price_cents:100,qty_milli:1000}];
      state.customers=[{id:'c1',name:'Customer',active:true}];renderCustomers();
      document.getElementById('saleCustomer').value='c1';document.getElementById('cashPaid').value='0';
      document.getElementById('saleForm').dispatchEvent(new Event('submit',{cancelable:true,bubbles:true}));`);
    await new Promise(done=>setTimeout(done,35));
    assert.equal(ctx.calls.filter(x=>x==='rfq_pilot_post_invoice_v3').length,1,JSON.stringify({msg:ctx.w.document.getElementById('message').textContent, customer:ctx.w.document.getElementById('saleCustomer').value}));
    const [saved]=[...ctx.bridge.ops.values()].filter(x=>x.kind==='invoice');
    assert.equal(JSON.parse(saved.payload).p_customer,'c1');
    assert.equal(JSON.parse(saved.payload)._snapshot[0].price_cents,100);
    assert.equal(saved.status,'conflict','a server-committed amount mismatch is explicit, not ordinary confirmation');
    assert.match(saved.note,/مختلف|راجع المالك/);
    assert.equal(ctx.bridge.meta.get(`rafiq-test-pending-sale:${STORE}:u1`),'');
    assert.equal(ctx.w.eval('state.invoice.provisional'),true,'do not replace a provisional receipt with different line prices');
  } finally {ctx.close();}
});

test('R66: offline credit receipt retains its snapshot and mismatched server total becomes a visible review item', async () => {
  let online=false;
  const ctx=await boot({embedded:true,online:()=>online,rpc:(name,_count,payload)=>name==='rfq_pilot_post_invoice_v3'
    ? {status:200,data:{invoice_id:payload.p_invoice,number:18,total_cents:120,due_cents:120}}
    : {status:200,data:[]}});
  await new Promise(done=>setImmediate(done));
  try {
    ctx.w.eval(`state.shift='s';state.api.access='t';state.api.expiresAt=Date.now()+3600000;state.cart=[{product_id:'p',name:'Tea',price_cents:100,qty_milli:1000}];
      state.customers=[{id:'c1',name:'Customer',active:true}];renderCustomers();
      document.getElementById('saleCustomer').value='c1';document.getElementById('cashPaid').value='0';
      document.getElementById('saleForm').dispatchEvent(new Event('submit',{cancelable:true,bubbles:true}));`);
    await new Promise(done=>setTimeout(done,30));
    const [op]=[...ctx.bridge.ops.values()].filter(x=>x.kind==='invoice');
    assert.ok(op);
    assert.equal(JSON.parse(op.payload)._snapshot[0].price_cents,100);
    assert.equal(op.status,'queued');
    assert.equal(ctx.w.eval('state.invoice.provisional'),true);
    online=true;ctx.w.eval('state.offlineNow=false');
    await ctx.w.eval('syncPush()');
    assert.equal(ctx.bridge.ops.get(op.id).status,'conflict','server-committed mismatch is NOT marked an ordinary confirmed local receipt');
    assert.match(ctx.bridge.ops.get(op.id).note,/أقر|أكّد|مختلف/);
    assert.equal(ctx.w.eval('state.invoice.provisional'),true);
  } finally {ctx.close();}
});

test('R67: offline sale is never marked confirmed for a 200 response without an invoice acknowledgement', async () => {
  const ctx=await boot({embedded:true,online:()=>true,rpc:name=>({status:200,data:name==='rfq_pilot_post_invoice_guarded'?null:[]})});
  await new Promise(done=>setImmediate(done));
  try {
    ctx.w.eval("state.api.access='t';state.api.expiresAt=Date.now()+3600000;state.offlineNow=false;ofxQueue('invoice',{p_shift:'s',p_device:'d1',p_invoice:'inv-unack',p_customer:'c1',p_lines:[{product_id:'p',qty_milli:1000}],p_cash_cents:0,p_sms_consent:false,_snapshot:[{product_id:'p',name:'Tea',price_cents:100,qty_milli:1000}]},'inv-unack')");
    await ctx.w.eval('syncPush()');
    assert.notEqual(ctx.bridge.ops.get('inv-unack').status,'confirmed');
  } finally {ctx.close();}
});

test('R68: a 200 response for a different invoice id cannot clear the Android pending sale', async () => {
  const ctx=await boot({embedded:true,online:()=>true,rpc:name=>({status:200,data:name==='rfq_pilot_post_invoice_guarded'
    ? {invoice_id:'a-different-invoice',number:27,total_cents:100,due_cents:0} : []})});
  await new Promise(done=>setImmediate(done));
  try {
    ctx.w.eval("state.shift='s';state.api.access='t';state.api.expiresAt=Date.now()+3600000;setPending({id:'inv-expected',payload:{p_shift:'s',p_device:'d1',p_invoice:'inv-expected',p_customer:null,p_lines:[{product_id:'p',qty_milli:1000}],p_cash_cents:100,p_sms_consent:false},snapshot:[{product_id:'p',name:'Tea',price_cents:100,qty_milli:1000}]})");
    await ctx.w.eval('submitPending()');
    assert.equal(ctx.bridge.ops.get('inv-expected').status,'queued','an unrelated invoice id is not confirmation');
    assert.equal(ctx.bridge.meta.get(`rafiq-test-pending-sale:${STORE}:u1`),'');
    assert.equal(ctx.w.eval('state.invoice.provisional'),true);
    assert.equal(ctx.w.eval('state.invoice.localId'),'inv-expected');
  } finally {ctx.close();}
});

test('R69: Android Room outbox write failure blocks the RPC and retains the original id for retry', async () => {
  const ctx=await boot({embedded:true,online:()=>true,tables:matchingSaleLines,rpc:(name,_n,payload)=>name==='rfq_pilot_post_invoice_v3'
    ? {status:200,data:mockInvoiceAck(payload,31)}
    : {status:200,data:[]}});
  await new Promise(done=>setImmediate(done));
  try {
    const realAdd=ctx.bridge.ofxAdd;
    ctx.bridge.ofxAdd=()=>'{"ok":true}'; // dishonest bridge: no row was committed
    ctx.w.eval(`state.shift='s';state.api.access='t';state.api.expiresAt=Date.now()+3600000;state.cart=[{product_id:'p',name:'Tea',price_cents:100,qty_milli:1000}];
      document.getElementById('cashPaid').value='1';
      document.getElementById('saleForm').dispatchEvent(new Event('submit',{cancelable:true,bubbles:true}));`);
    await new Promise(done=>setTimeout(done,25));
    const key=`rafiq-test-pending-sale:${STORE}:u1`;
    const id=JSON.parse(ctx.bridge.meta.get(key)||'null')?.id;
    assert.ok(id,'staging intent survives the failed outbox transfer');
    assert.equal(ctx.bridge.ops.size,0);
    assert.equal(ctx.calls.includes('rfq_pilot_post_invoice_v3'),false,'no network before verified outbox record');
    assert.equal(ctx.w.eval('state.invoice'),null);
    ctx.bridge.ofxAdd=realAdd;
    await ctx.w.eval('submitPending()');
    assert.equal(ctx.bridge.ops.get(id).status,'confirmed');
    assert.equal(ctx.w.eval('state.invoice.number'),31);
    assert.equal(JSON.parse(ctx.bodies.find(x=>x.path.endsWith('/rpc/rfq_pilot_post_invoice_v3')).body).p_invoice,id);
  } finally {ctx.close();}
});

test('R70: a Room-staged sale is automatically moved to the outbox at reopen, without making an offline RPC', async () => {
  const durable=makeBridge(), id='55555555-5555-4555-8555-555555555555', device='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const key=`rafiq-test-pending-sale:${STORE}:u1`;
  const first=await boot({embedded:true,sharedBridge:durable,online:()=>false,rpc:()=>({status:200,data:[]})});
  await new Promise(done=>setImmediate(done));
  try {
    first.w.eval(`setPending({id:'${id}',payload:{p_shift:'s',p_device:'${device}',p_invoice:'${id}',p_customer:null,p_lines:[{product_id:'p',qty_milli:1000}],p_cash_cents:100,p_sms_consent:false},snapshot:[{product_id:'p',name:'Tea',price_cents:100,qty_milli:1000}]})`);
    assert.equal(JSON.parse(durable.meta.get(key)).id,id);
    assert.equal(durable.ops.size,0,'simulated crash occurred between the two local writes');
  } finally {first.close();}
  const next=await boot({embedded:true,sharedBridge:durable,online:()=>false,rpc:()=>({status:200,data:[]})});
  await new Promise(done=>setImmediate(done));
  try {
    next.w.localStorage.setItem('rafiq-test-device:v2:android:u1',device);
    await next.w.eval(`enterSession({id:'u1',email:'test@example.com'},{store_id:'${STORE}',role:'worker'})`);
    assert.equal(durable.ops.get(id).status,'queued');
    assert.equal(durable.meta.get(key),'');
    assert.equal(next.w.eval('state.invoice.localId'),id);
    assert.equal(next.w.eval('state.invoice.provisional'),true);
    assert.equal(next.calls.filter(x=>x==='rfq_pilot_post_invoice_guarded').length,0);
  } finally {next.close();}
});

test('R73: an Android sale rejected with HTTP 400 becomes a preserved review item, not an offline-network excuse', async () => {
  const ctx=await boot({embedded:true,online:()=>true,rpc:name=>name==='rfq_pilot_post_invoice_v3'
    ? {status:400,data:{message:'Network unavailable'}} : {status:200,data:[]}});
  await new Promise(done=>setImmediate(done));
  try {
    ctx.w.eval(`state.shift='s';state.api.access='t';state.api.expiresAt=Date.now()+3600000;state.cart=[{product_id:'p',name:'Tea',price_cents:100,qty_milli:1000}];
      document.getElementById('cashPaid').value='1';
      document.getElementById('saleForm').dispatchEvent(new Event('submit',{cancelable:true,bubbles:true}));`);
    await new Promise(done=>setTimeout(done,30));
    const [op]=[...ctx.bridge.ops.values()].filter(x=>x.kind==='invoice');
    assert.equal(op.status,'conflict');
    assert.match(op.note,/Network unavailable/);
    assert.equal(ctx.w.eval('state.invoice.provisional'),true);
    assert.equal(ctx.w.eval(`syncCenterCard().textContent.includes('Network unavailable')`),true);
  } finally {ctx.close();}
});

test('R74: a bridge claiming to settle an invoice without writing Room must not promote the receipt to confirmed', async () => {
  const ctx=await boot({embedded:true,online:()=>true,tables:matchingSaleLines,rpc:(name,_n,payload)=>name==='rfq_pilot_post_invoice_guarded'
    ? {status:200,data:{invoice_id:payload.p_invoice,number:41,total_cents:100,due_cents:0}}
    : {status:200,data:[]}});
  await new Promise(done=>setImmediate(done));
  try {
    ctx.bridge.ofxSettle=()=>'{"ok":true}'; // dishonest result; on-disk status remains queued
    ctx.w.eval(`state.shift='s';state.api.access='t';state.api.expiresAt=Date.now()+3600000;state.cart=[{product_id:'p',name:'Tea',price_cents:100,qty_milli:1000}];
      document.getElementById('cashPaid').value='1';
      document.getElementById('saleForm').dispatchEvent(new Event('submit',{cancelable:true,bubbles:true}));`);
    await new Promise(done=>setTimeout(done,35));
    const [op]=[...ctx.bridge.ops.values()].filter(x=>x.kind==='invoice');
    assert.equal(op.status,'queued');
    assert.equal(ctx.w.eval('state.invoice.provisional'),true,'read back Room status by id before confirmation');
  } finally {ctx.close();}
});

test('R76: equal invoice TOTAL with changed individual server prices remains a review conflict, never a confirmed old receipt', async () => {
  const ctx=await boot({embedded:true,online:()=>true,
    rpc:(name,_n,payload)=>name==='rfq_pilot_post_invoice_v3'
      ? {status:200,data:{invoice_id:payload.p_invoice,number:52,total_cents:300,due_cents:300}}
      : {status:200,data:[]},
    tables:(tbl,params)=>tbl==='invoice_lines'
      ? [{invoice_id:String(params.invoice_id).slice(3),product_id:'p1',name_snapshot:'Tea',price_cents:110,qty_milli:1000},
         {invoice_id:String(params.invoice_id).slice(3),product_id:'p2',name_snapshot:'Sugar',price_cents:190,qty_milli:1000}]
      : []});
  await new Promise(done=>setImmediate(done));
  try {
    ctx.w.eval(`state.shift='s';state.api.access='t';state.api.expiresAt=Date.now()+3600000;
      state.cart=[{product_id:'p1',name:'Tea',price_cents:100,qty_milli:1000},{product_id:'p2',name:'Sugar',price_cents:200,qty_milli:1000}];
      state.customers=[{id:'c1',name:'Customer',active:true}];renderCustomers();
      document.getElementById('saleCustomer').value='c1';document.getElementById('cashPaid').value='0';
      document.getElementById('saleForm').dispatchEvent(new Event('submit',{cancelable:true,bubbles:true}));`);
    await new Promise(done=>setTimeout(done,40));
    const [op]=[...ctx.bridge.ops.values()].filter(x=>x.kind==='invoice');
    assert.equal(op.status,'conflict','the server has committed different line prices despite an equal total');
    assert.match(op.note,/السعر|أسعار|سطور|صنف/);
    assert.equal(ctx.w.eval('state.invoice.provisional'),true);
  } finally {ctx.close();}
});

test('R75: Android bridge exposes an unbounded Room lookup by exact operation id for confirmation read-back', () => {
  const dao=readFileSync(new URL('../../app/src/main/java/net/arena/rafiq/data/SyncEntities.kt',import.meta.url),'utf8');
  const native=readFileSync(new URL('../../app/src/main/java/net/arena/rafiq/cloud/CloudNativeBridge.kt',import.meta.url),'utf8');
  assert.match(dao, /SELECT \* FROM ofx_ops WHERE id=:id LIMIT 1[\s\S]*?fun getById\(id: String\)/);
  assert.match(native, /@JavascriptInterface\s+fun ofxGet\(id: String\): String[\s\S]*?db\.ofx\(\)\.getById\(id\)/);
  assert.match(source, /b\.ofxGet\?\.\(o\.id\)/);
});

test('R77: if server invoice lines are temporarily unreadable, a sale keeps its id and retries until line-level verification', async () => {
  let linesReadable=false, id=null, commits=0;
  const ctx=await boot({embedded:true,online:()=>true,
    rpc:(name,_n,payload)=>{
      if(name!=='rfq_pilot_post_invoice_v3')return {status:200,data:[]};
      if(!id){id=payload.p_invoice;commits++;}
      else assert.equal(payload.p_invoice,id);
      return {status:200,data:{invoice_id:id,number:71,total_cents:100,due_cents:0,already_committed:commits>0}};
    },
    tables:(tbl,params)=>tbl==='invoice_lines'&&!linesReadable
      ? {status:503,data:{message:'temporary read failure'}}
      : matchingSaleLines(tbl,params)});
  await new Promise(done=>setImmediate(done));
  try {
    ctx.w.eval(`state.shift='s';state.api.access='t';state.api.expiresAt=Date.now()+3600000;state.cart=[{product_id:'p',name:'Tea',price_cents:100,qty_milli:1000}];
      document.getElementById('cashPaid').value='1';
      document.getElementById('saleForm').dispatchEvent(new Event('submit',{cancelable:true,bubbles:true}));`);
    await new Promise(done=>setTimeout(done,35));
    assert.equal(ctx.bridge.ops.get(id).status,'queued');
    assert.equal(ctx.w.eval('state.invoice.provisional'),true);
    linesReadable=true;
    await ctx.w.eval('syncAll()');
    assert.equal(commits,1,'same mock server invoice is reused');
    assert.equal(ctx.bridge.ops.get(id).status,'confirmed');
    assert.equal(ctx.w.eval('state.invoice.number'),71);
    assert.equal(ctx.calls.filter(x=>x==='rfq_pilot_post_invoice_v3').length,2);
  } finally {ctx.close();}
});

test('R79: a zero-price sale cannot treat missing amount fields as a zero-value server acknowledgement', async () => {
  const ctx=await boot({embedded:true,online:()=>true,
    rpc:(name,_n,payload)=>name==='rfq_pilot_post_invoice_guarded'
      ? {status:200,data:{invoice_id:payload.p_invoice,number:81,total_cents:null,due_cents:null}}
      : {status:200,data:[]},
    tables:(tbl,params)=>tbl==='invoice_lines'
      ? [{invoice_id:String(params.invoice_id).slice(3),product_id:'p',name_snapshot:'Tea',price_cents:0,qty_milli:1000}]
      : []});
  await new Promise(done=>setImmediate(done));
  try {
    ctx.w.eval(`state.shift='s';state.api.access='t';state.api.expiresAt=Date.now()+3600000;state.cart=[{product_id:'p',name:'Tea',price_cents:0,qty_milli:1000}];
      document.getElementById('cashPaid').value='0';
      document.getElementById('saleForm').dispatchEvent(new Event('submit',{cancelable:true,bubbles:true}));`);
    await new Promise(done=>setTimeout(done,35));
    const [op]=[...ctx.bridge.ops.values()].filter(x=>x.kind==='invoice');
    assert.equal(op.status,'queued','null is not the number zero');
    assert.equal(ctx.w.eval('state.invoice.provisional'),true);
  } finally {ctx.close();}
});

test('R81: reopening an Android session online automatically retries a queued receipt with its original invoice id', async () => {
  const durable=makeBridge(), id='66666666-6666-4666-8666-666666666666', device='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const first=await boot({embedded:true,sharedBridge:durable,online:()=>false,rpc:()=>({status:200,data:[]})});
  await new Promise(done=>setImmediate(done));
  try {
    first.w.eval(`state.shift='srv-1';state.api.access='t';state.api.expiresAt=Date.now()+3600000;
      setPending({id:'${id}',payload:{p_shift:'srv-1',p_device:'${device}',p_invoice:'${id}',p_customer:null,p_lines:[{product_id:'p',qty_milli:1000}],p_cash_cents:100,p_sms_consent:false},snapshot:[{product_id:'p',name:'Tea',price_cents:100,qty_milli:1000}]})`);
    await first.w.eval('submitPending()');
    assert.equal(durable.ops.get(id).status,'queued');
  } finally {first.close();}
  const next=await boot({embedded:true,sharedBridge:durable,online:()=>true,
    rpc:(name,_n,payload)=>name==='rfq_pilot_post_invoice_guarded'
      ? {status:200,data:mockInvoiceAck(payload,91)}
      : name==='rfq_pilot_request_device' ? {status:200,data:'approved'}
      : name==='rfq_pilot_claim_worker' ? {status:200,data:'2026-10-19T00:00:00Z'}
      : name==='rfq_pilot_my_open_shift' ? {status:200,data:{id:'srv-1'}}
      : name==='rfq_pilot_license_current' ? {status:200,data:true}
      : {status:200,data:[]},
    tables:(tbl,params)=>tbl==='devices' ? [{id:device,status:'approved'}]
      : matchingSaleLines(tbl,params)});
  await new Promise(done=>setImmediate(done));
  try {
    next.w.localStorage.setItem('rafiq-test-device:v2:android:u1',device);
    next.w.eval("state.api.access='t';state.api.expiresAt=Date.now()+3600000");
    await next.w.eval(`enterSession({id:'u1',email:'test@example.com'},{store_id:'${STORE}',role:'worker'})`);
    await new Promise(done=>setTimeout(done,25)); // refresh launches the already queued sync automatically
    assert.equal(durable.ops.get(id).status,'confirmed');
    assert.equal(next.calls.filter(x=>x==='rfq_pilot_post_invoice_guarded').length,1);
    assert.equal(JSON.parse(next.bodies.find(x=>x.path.endsWith('/rpc/rfq_pilot_post_invoice_guarded')).body).p_invoice,id);
    assert.equal(next.w.eval('state.invoice.number'),91);
  } finally {next.close();}
});

// New guarded invoice contract: deliberately not run in the local no-build round.
test('R82: a legacy queued sale without a stored price snapshot never calls the old or new posting RPC', async () => {
  const ctx=await boot({online:()=>true,rpc:()=>({status:200,data:{}})});
  try{
    ctx.w.eval(`ofxQueue('invoice',{p_shift:'s',p_device:'d1',p_invoice:'old-sale',p_customer:null,
      p_lines:[{product_id:'p',qty_milli:1000}],p_cash_cents:100,p_sms_consent:false},'old-sale')`);
    await ctx.w.eval('syncPush()');
    assert.equal(ctx.bridge.ops.get('old-sale').status,'conflict');
    assert.match(ctx.bridge.ops.get('old-sale').note,/لقطة أسعار/);
    assert.equal(ctx.calls.filter(c=>c.includes('post_invoice')).length,0);
  }finally{ctx.close();}
});

test('R83: a durable Android invoice sends matching expected price/name fields only to the guarded RPC', async () => {
  const ctx=await boot({embedded:true,online:()=>true,
    rpc:(name,_n,payload)=>name==='rfq_pilot_post_invoice_guarded'
      ? {status:200,data:mockInvoiceAck(payload,7)} : {status:200,data:[]}});
  await new Promise(done=>setImmediate(done));
  try{
    ctx.w.eval(SALE);
    await ctx.w.eval('submitPending()');
    const [call]=ctx.bodies.filter(x=>x.path.endsWith('/rpc/rfq_pilot_post_invoice_guarded'));
    assert.ok(call,'only the guarded RPC receives the sale');
    const sent=JSON.parse(call.body);
    assert.deepEqual(sent.p_lines,[{product_id:'p',qty_milli:1000,expected_price_cents:100,expected_name:'Tea'}]);
    assert.ok(!('_snapshot' in sent)&&!('_store' in sent));
    assert.equal(ctx.bridge.ops.get('inv-1').status,'confirmed');
  }finally{ctx.close();}
});

test('R84: an atomic server price-drift rejection leaves the local receipt provisional and reviewable', async () => {
  const ctx=await boot({embedded:true,online:()=>true,
    rpc:name=>name==='rfq_pilot_post_invoice_guarded'
      ? {status:400,data:{message:'invoice_snapshot_changed'}} : {status:200,data:[]}});
  await new Promise(done=>setImmediate(done));
  try{
    ctx.w.eval(SALE);await ctx.w.eval('submitPending()');
    assert.equal(ctx.bridge.ops.get('inv-1').status,'conflict');
    assert.match(ctx.bridge.ops.get('inv-1').note,/invoice_snapshot_changed/);
    assert.equal(ctx.w.eval('state.invoice.provisional'),true);
  }finally{ctx.close();}
});

test('R85: a committed invoice replays with a closed shift/expired local lease and no general line-table RLS', async () => {
  const ctx=await boot({online:()=>true,
    rpc:(name,_n,payload)=>name==='rfq_pilot_post_invoice_guarded'
      ? {status:200,data:mockInvoiceAck(payload,13,{already_committed:true})}
      : {status:200,data:[]},
    tables:(table)=>table==='invoice_lines'
      ? {status:403,data:{message:'no live worker lease'}} : []});
  try{
    ctx.w.eval(`ofxQueue('invoice',${JSON.stringify(testInvoicePayload('closed-ack'))},'closed-ack');
      state.shift=null;state.lease=false;`);
    await ctx.w.eval('syncPush()');
    assert.equal(ctx.bridge.ops.get('closed-ack').status,'confirmed');
    assert.equal(ctx.bridge.ops.get('closed-ack').serverRef,'13');
    assert.equal(ctx.calls.includes('table:invoice_lines'),false,'the guarded reply includes verifiable committed lines');
  }finally{ctx.close();}
});

test('R86: expired-license recovery is replay-only and never commits a previously unknown sale', async () => {
  const ctx=await boot({online:()=>true,
    rpc:name=>name==='rfq_pilot_post_invoice_guarded'
      ? {status:400,data:{message:'invoice_replay_not_found'}} : {status:200,data:[]}});
  try{
    ctx.w.eval(`ofxQueue('invoice',${JSON.stringify(testInvoicePayload('unposted'))},'unposted');
      state.readOnly=true;state.lease=false;`);
    await ctx.w.eval('syncPush()');
    await ctx.w.eval('syncPush()');
    assert.equal(ctx.bridge.ops.get('unposted').status,'queued');
    const sent=ctx.bodies.filter(x=>x.path.endsWith('/rpc/rfq_pilot_post_invoice_guarded'));
    assert.equal(sent.length,1,'a missing prior commit is not retried in a tight loop');
    assert.equal(JSON.parse(sent[0].body).p_replay_only,true);
  }finally{ctx.close();}
});

test('R87: guarded SQL fail-closes the legacy endpoint and places the row-lock price check before financial writes', () => {
  const sql=readFileSync(new URL('../../supabase/migrations/20261019000504_guarded_invoice.sql',import.meta.url),'utf8');
  assert.match(sql,/revoke all on function public\.rfq_pilot_post_invoice\(uuid,uuid,uuid,uuid,jsonb,bigint,boolean\)/);
  assert.match(sql,/rfq_pilot_denied_sessions/);
  assert.match(sql,/if p_replay_only then raise exception 'invoice_replay_not_found'/);
  assert.ok(sql.indexOf('select * into v_prev from public.rfq_pilot_invoices')<
    sql.indexOf('select * into v_shift from public.rfq_pilot_shifts'));
  assert.ok(sql.indexOf("raise exception 'invoice_snapshot_changed'")<
    sql.indexOf('insert into public.rfq_pilot_invoices'));
  assert.match(sql,/v_product\.price_cents<>v_expected_price or v_product\.name<>/);
  assert.match(sql,/l\.invoice_id=v_prev\.id/);
});

// Same installed package, first launch after the test-server cleanup: source tests only.
test('R88: the first in-place launch discards stale Room work before any sync and later launches keep NEW work', async () => {
  const durable=makeBridge();
  durable.ops.set('stale',{id:'stale',kind:'invoice',payload:'{}',status:'queued',queuedAt:'old'});
  durable.mirror.set('old',{});durable.meta.set('local_shift:old','old');
  const first=await boot({embedded:true,sharedBridge:durable,online:()=>false,
    rpc:()=>({status:200,data:[]})});
  try{
    assert.equal(durable.ops.size,0,'old queued sale cannot re-upload after the update');
    assert.equal(durable.mirror.size,0);
    assert.equal(durable.meta.size,0);
    first.w.eval(SALE);await first.w.eval('submitPending()');
    assert.equal(durable.ops.get('inv-1').status,'queued','a NEW offline sale is still durable');
  }finally{first.close();}
  const second=await boot({embedded:true,sharedBridge:durable,online:()=>false,
    rpc:()=>({status:200,data:[]})});
  try{assert.equal(durable.ops.get('inv-1').status,'queued','the reset runs only once');}
  finally{second.close();}
});

test('R89: an unverified Android reset fails closed before any network or sale', async () => {
  const durable=makeBridge();let rpcCalls=0;
  durable.beginPilotDemoReset=()=>'{"ok":false}';
  await assert.rejects(()=>boot({embedded:true,sharedBridge:durable,online:()=>true,
    rpc:()=>{rpcCalls++;return {status:200,data:[]};}}),/pilot_reset_required_before_network/);
  assert.equal(rpcCalls,0);
});

test('R90: local cleanup is atomic and keeps the cloud binding and app identity', () => {
  const bridgeSrc=readFileSync(new URL('../../app/src/main/java/net/arena/rafiq/cloud/CloudNativeBridge.kt',import.meta.url),'utf8');
  const gradle=readFileSync(new URL('../../app/build.gradle.kts',import.meta.url),'utf8');
  assert.match(bridgeSrc,/db\.runInTransaction\s*\{[\s\S]*?val testTables = listOf\([\s\S]*?"sync_meta", "mirror_rows", "ofx_ops"[\s\S]*?"invoice_items", "invoices", "shifts"[\s\S]*?for \(table in testTables\) sql\.execSQL/);
  assert.match(bridgeSrc,/resetPrepared = true[\s\S]*?fun finishPilotDemoReset/);
  assert.match(bridgeSrc,/putBoolean\(RESET_KEY, true\)\.commit\(\)/);
  assert.doesNotMatch(bridgeSrc,/"settings", "users"/);
  assert.match(gradle,/applicationId = "net\.arena\.rafiq"/);
  assert.match(gradle,/versionCode = maxOf\(130,/);
  assert.match(source,/sessionStorage\.clear\(\)/);
  assert.match(source,/startsWith\('rafiq-test-device:v2:android:'\)/);
});
