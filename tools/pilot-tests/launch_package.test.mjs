import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname,join} from 'node:path';
import {sha256Bytes,hmacSha256,b32encode,b32decode,bytesHex,deviceCodeFrom,buildActivationCode,verifyActivationCode,activationUntil,LocalStore} from '../../web-client/lib.mjs';

const root=join(dirname(fileURLToPath(import.meta.url)),'../..');
const webjs=readFileSync(join(root,'web-client/web.js'),'utf8');
const html=readFileSync(join(root,'web-client/index.html'),'utf8');

test('launch: sha256/hmac مطابقان للمواصفات RFC',()=>{
  assert.equal(bytesHex(sha256Bytes('')),'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(bytesHex(sha256Bytes('abc')),'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(bytesHex(hmacSha256(new Uint8Array(20).fill(0x0b),'Hi There')),
    'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7');
  assert.equal(bytesHex(hmacSha256('Jefe','what do ya want for nothing?')),
    '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843');
});

test('launch: base32 ذهابًا وإيابًا',()=>{
  const b=new Uint8Array([1,2,3,4,5,250,251]);
  assert.deepEqual([...b32decode(b32encode(b))],[...b]);
});

test('launch: رمز الجهاز ثابت لكل جهاز ومختلف بين الأجهزة',()=>{
  const dc=deviceCodeFrom('device-abc');
  assert.equal(dc.length,8);
  assert.equal(dc,deviceCodeFrom('device-abc'));
  assert.notEqual(dc,deviceCodeFrom('device-xyz'));
});

test('launch: الكود مرتبط بالجهاز ويرفض العبث',()=>{
  const dc=deviceCodeFrom('device-abc');
  const code=buildActivationCode(dc,{type:2,months:12});
  assert.match(code,/^RFQ-[A-Z2-7]{4}-[A-Z2-7]{4}$/);
  const r=verifyActivationCode(dc,code);
  assert.equal(r.ok,true);assert.equal(r.months,12);assert.equal(r.type,2);assert.equal(r.mode,'both');
  assert.equal(verifyActivationCode('ZZZZZZZZ',code).ok,false);
  const tampered=code.slice(0,5)+(code[5]==='A'?'B':'A')+code.slice(6);
  assert.equal(verifyActivationCode(dc,tampered).ok,false);
  assert.equal(verifyActivationCode(dc,'RFQ-1111-2222').ok,false);
  assert.equal(verifyActivationCode(dc,buildActivationCode(dc,{type:0,months:63})).months,63);
  assert.equal(verifyActivationCode(dc,buildActivationCode(dc,{type:1,months:1})).mode,'online');
  assert.throws(()=>buildActivationCode(dc,{type:2,months:0}));
});

test('launch: مدة الصلاحية تُحسب محليًا',()=>{
  assert.equal(activationUntil(12,'2026-01-15T10:00:00Z').slice(0,7),'2027-01');
  assert.equal(activationUntil(1,'2026-01-31T10:00:00Z').slice(0,7),'2026-02');
  assert.ok(new Date(activationUntil(63))>new Date(Date.now()+15*365*864e5));
});

function memKv(){const m=new Map();return {get:k=>m.get(k)||null,set:(k,v)=>m.set(k,v),m};}
function seedStore(){
  const kv=memKv();const ls=new LocalStore(kv);
  ls.rpc('rfq_pilot_request_shift',{p_device:'d1'});
  ls.rpc('rfq_pilot_create_customer',{p_id:'c1',p_name:'صاق',p_phone:'777'});
  ls.rpc('rfq_pilot_save_product',{p_id:'p1',p_name:'شاشة',p_price_cents:1250000,p_cost_cents:900000,p_initial_stock_milli:10000});
  return {ls,kv};
}
const INV=(over={})=>({p_shift:null,p_device:'d1',p_invoice:'i1',p_customer:'c1',
  p_lines:[{product_id:'p1',qty_milli:5000,expected_price_cents:1250000,expected_name:'شاشة'}],
  p_cash_cents:200000,p_other_cents:0,p_sms_consent:false,...over});

test('local: فاتورة دين → كشف مطابق + رصيد مؤكد',()=>{
  const {ls}=seedStore();
  const inv=ls.rpc('rfq_pilot_post_invoice_v3',INV({p_shift:ls.db.shift_open}));
  assert.equal(inv.number,1);assert.equal(inv.total_cents,6250000);assert.equal(inv.due_cents,6050000);
  const st=ls.rpc('rfq_pilot_customer_statement',{p_customer:'c1'});
  assert.equal(st.balance_cents,6050000);
  assert.equal(st.balance_cents,st.entries[st.entries.length-1].balance_after_cents);
  assert.equal(st.debit_cents,6050000);
  assert.equal(ls.rpc('rfq_pilot_customer_balance',{p_customer:'c1'}),6050000);
});

test('local: دفع محفظة/حوالة يُخصم من الدين (منطق v3)',()=>{
  const {ls}=seedStore();
  const inv=ls.rpc('rfq_pilot_post_invoice_v3',INV({p_shift:ls.db.shift_open,p_customer:null,p_cash_cents:5000000,p_other_cents:1250000,p_other_method:'wallet'}));
  assert.equal(inv.due_cents,0);assert.equal(inv.other_paid_cents,1250000);
  assert.equal(ls.rpc('rfq_pilot_customer_balance',{p_customer:'c1'}),0);
});

test('local: تحصيل + مرتجع + عكس — الرصيد يساوي مجموع القيود دائمًا',()=>{
  const {ls}=seedStore();
  ls.rpc('rfq_pilot_post_invoice_v3',INV({p_shift:ls.db.shift_open}));
  ls.rpc('rfq_pilot_collect_debt_v2',{p_shift:ls.db.shift_open,p_device:'d1',p_event:'e1',p_customer:'c1',p_amount_cents:1050000,p_method:'cash'});
  assert.equal(ls.rpc('rfq_pilot_customer_balance',{p_customer:'c1'}),5000000);
  const ret=ls.rpc('rfq_pilot_sales_return',{p_invoice:'i1',p_lines:[{invoice_line_id:ls.db.invoice_lines[0].id,qty_milli:1000}],
    p_refund_method:'debt',p_reason:'عيب مصنعي',p_id:'r1'});
  assert.equal(ret.total_cents,1250000);
  const st=ls.rpc('rfq_pilot_customer_statement',{p_customer:'c1'});
  assert.equal(st.balance_cents,3750000); // 6,050,000 − 1,050,000 − 1,250,000 (المرتجع محسوب سدادًا)
  assert.equal(st.balance_cents,st.entries[st.entries.length-1].balance_after_cents);
  assert.equal(st.credit_cents,2300000);
});

test('local: إلغاء فاتورة يعكس الدين ويعيد المخزون',()=>{
  const {ls}=seedStore();
  ls.rpc('rfq_pilot_post_invoice_v3',INV({p_shift:ls.db.shift_open,p_invoice:'i9'}));
  ls.rpc('rfq_pilot_void_invoice',{p_invoice:'i9',p_reason:'إلغاء تجريبي موثّق'});
  assert.equal(ls.rpc('rfq_pilot_customer_balance',{p_customer:'c1'}),0);
  assert.equal(ls.db.products.find(p=>p.id==='p1').stock_milli,10000);
});

test('local: الفاتورة معرّفها=idempotent — لا تكرار',()=>{
  const {ls}=seedStore();
  const a=ls.rpc('rfq_pilot_post_invoice_v3',INV({p_shift:ls.db.shift_open}));
  const b=ls.rpc('rfq_pilot_post_invoice_v3',INV({p_shift:ls.db.shift_open}));
  assert.equal(b.already_committed,true);assert.equal(b.number,a.number);
  assert.equal(ls.db.invoices.length,1);
});

test('local: المخزون يرفض البيع بأكثر من المتوفر',()=>{
  const {ls}=seedStore();
  assert.throws(()=>ls.rpc('rfq_pilot_post_invoice_v3',INV({p_shift:ls.db.shift_open,
    p_lines:[{product_id:'p1',qty_milli:20000,expected_price_cents:1250000,expected_name:'شاشة'}]})),/غير متوفرة/);
});

test('local: التقارير الأساسية تعمل (يومي/متابعة/ربح/زبائن)',()=>{
  const {ls}=seedStore();
  ls.rpc('rfq_pilot_post_invoice_v3',INV({p_shift:ls.db.shift_open}));
  const d=ls.rpc('rfq_pilot_daily_report',{p_date:new Date().toISOString().slice(0,10)});
  assert.equal(d.sales_totals.count,1);assert.equal(d.sales_totals.total_cents,6250000);
  const m=ls.rpc('rfq_pilot_owner_monitor',{});
  assert.equal(m.today.invoices,1);assert.equal(m.totals.customers,1);
  const p=ls.rpc('rfq_pilot_profit_report',{p_from:'2000-01-01',p_to:'2099-01-01'});
  assert.equal(p.invoices,1);assert.equal(p.net_revenue_cents,6250000);
  const cr=ls.rpc('rfq_pilot_customers_report',{});
  assert.equal(cr.length,1);assert.equal(cr[0].balance_cents,6050000);
});

test('local: التوريدات (شراء/سداد/كشف مورّد) تعمل',()=>{
  const {ls}=seedStore();
  ls.rpc('rfq_pilot_create_supplier',{p_id:'s1',p_name:'شركة التوريد',p_phone:'733'});
  const pu=ls.rpc('rfq_pilot_save_purchase_v2',{p_supplier:'s1',p_lines:[{product_id:'p1',qty_milli:4000,cost_cents:1000000}],
    p_paid_cents:2000000,p_note:'دفعة أولى'});
  assert.equal(pu.total_cents,4000000);
  assert.equal(ls.rpc('rfq_pilot_suppliers_overview',{}).find(s=>s.id==='s1').balance_cents,2000000);
  const rows=ls.rpc('rfq_pilot_supplier_statement',{p_supplier:'s1'});
  assert.equal(rows[rows.length-1].balance_cents,2000000);
});

test('local: الاستمرارية — البيانات تبقى بعد إعادة فتح المخزن',()=>{
  const {ls,kv}=seedStore();
  ls.rpc('rfq_pilot_post_invoice_v3',INV({p_shift:ls.db.shift_open}));
  const ls2=new LocalStore(kv);
  assert.equal(ls2.rpc('rfq_pilot_customer_balance',{p_customer:'c1'}),6050000);
});

test('launch: الشاشات والربط موجودون في الواجهة',()=>{
  for(const id of ['activationScreen','modeScreen','localSetupScreen','pinScreen','activationForm','modeOnline','modeOffline','localSetupForm','pinForm','pinChangeMode','launchRenewBtn','launchModeBtn','launchDeviceCode','launchInfo'])
    assert.ok(html.includes(`id="${id}"`),'missing #'+id);
  for(const s of ['function bootLaunch(','function enterLocalSession(','function makeLocalApi(','function netReady(','function showActivationScreen('])
    assert.ok(webjs.includes(s),'missing '+s);
  assert.ok(webjs.includes("netReady()"),'netReady not used');
  assert.ok(webjs.includes('LocalStore'),'LocalStore not wired');
  assert.ok(html.includes('جميع الحقوق محفوظة لمنصة دهفة للتقنية'),'drawer footer missing');
});
