import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname,join} from 'node:path';
import {LocalStore,validatePurchaseDraft,isoDateValid,sellableQty,expiringBatches,productBatches,parseOcrLine} from '../../web-client/lib.mjs';

const root=join(dirname(fileURLToPath(import.meta.url)),'../..');
const webjs=readFileSync(join(root,'web-client/web.js'),'utf8');
const html=readFileSync(join(root,'web-client/index.html'),'utf8');

function memKv(){const m=new Map();return {get:k=>m.get(k)||null,set:(k,v)=>m.set(k,v),m};}
function seedStore(){
  const kv=memKv();const ls=new LocalStore(kv);
  ls.rpc('rfq_pilot_request_shift',{p_device:'d1'});
  ls.rpc('rfq_pilot_save_product',{p_id:'p1',p_name:'حليب',p_price_cents:500,p_cost_cents:300,p_initial_stock_milli:0});
  ls.rpc('rfq_pilot_create_supplier',{p_id:'s1',p_name:'شركة التوريد',p_phone:''});
  return {ls,kv};
}
const DRAFT=(over={})=>({reviewedByOwner:true,imageSha256:'a'.repeat(64),supplierId:'s1',
  invoiceDateIso:'2026-10-01',invoiceRef:'INV-7',paymentType:'credit',
  declaredTotalCents:1000,paidCents:400,
  lines:[{productId:'p1',quantity:2,unitCostCents:500,expiryIso:'2027-01-01',expiryRequired:true,reviewed:true}],
  ...over});

test('draft: القبول الأساسي يرجع الإجمالي والمدفوع والدين',()=>{
  const r=validatePurchaseDraft(DRAFT());
  assert.deepEqual(r,{ok:true,total_cents:1000,paid_cents:400,debt_cents:600});
});

test('draft: بصمة الصورة إلزامية وصيغتها 64 خانة',()=>{
  assert.equal(validatePurchaseDraft(DRAFT({imageSha256:null})).reason,'أرفق صورة فاتورة الشراء الأصلية للتحقق منها');
  assert.equal(validatePurchaseDraft(DRAFT({imageSha256:'zz'})).ok,false);
  assert.ok(isoDateValid('2026-02-28'));
  assert.ok(!isoDateValid('2026-02-31'),'31 فبراير يُرفض — لا نعوّض التاريخ');
  assert.ok(!isoDateValid('2026-2-1'));
});

test('draft: مراجعة المالك إلزامية للصورة ولكل سطر',()=>{
  assert.equal(validatePurchaseDraft(DRAFT({reviewedByOwner:false})).reason,'راجع صورة الفاتورة وكل بند ثم أكّدها قبل الترحيل');
  assert.match(validatePurchaseDraft(DRAFT({lines:[{productId:'p1',quantity:2,unitCostCents:500,expiryIso:'2027-01-01',expiryRequired:true,reviewed:false}]})).reason,/راجع السطر 1/);
});

test('draft: ربط الصنف والكمية والتكلفة وحدودها',()=>{
  assert.match(validatePurchaseDraft(DRAFT({lines:[{productId:null,quantity:2,unitCostCents:500,reviewed:true}]})).reason,/اربط السطر 1/);
  assert.match(validatePurchaseDraft(DRAFT({lines:[{productId:'p1',quantity:0,unitCostCents:500,reviewed:true}]})).reason,/كمية السطر 1/);
  assert.match(validatePurchaseDraft(DRAFT({lines:[{productId:'p1',quantity:2,unitCostCents:-1,reviewed:true}]})).reason,/تكلفة السطر 1/);
  assert.match(validatePurchaseDraft(DRAFT({lines:[]})).reason, /أدخل بنود الفاتورة/);
});

test('draft: صلاحية كل دفعة — إلزامية عند الطلب، وبلا تاريخ مقترح لا تُخترع',()=>{
  assert.match(validatePurchaseDraft(DRAFT({lines:[{productId:'p1',quantity:2,unitCostCents:500,expiryIso:null,expiryRequired:true,reviewed:true}]})).reason,/أكّد تاريخ صلاحية السطر 1/);
  assert.match(validatePurchaseDraft(DRAFT({lines:[{productId:'p1',quantity:2,unitCostCents:500,expiryIso:'2026-02-31',expiryRequired:true,reviewed:true}]})).reason,/أكّد تاريخ صلاحية السطر 1/,'تاريخ مقطوع/تالف = غير مؤكد لا بديل');
  assert.match(validatePurchaseDraft(DRAFT({lines:[{productId:'p1',quantity:2,unitCostCents:500,expiryIso:'2026-02-31',expiryRequired:false,reviewed:true}]})).reason,/تاريخ صلاحية السطر 1 غير صالح/);
  const r=validatePurchaseDraft(DRAFT({lines:[{productId:'p1',quantity:2,unitCostCents:500,expiryIso:null,expiryRequired:false,reviewed:true}]}));
  assert.equal(r.ok,true,'بلا صلاحية مطلوبة = سطر مسموح');
});

test('draft: صلاحية أقدم من تاريخ الشراء تُعزل',()=>{
  assert.match(validatePurchaseDraft(DRAFT({lines:[{productId:'p1',quantity:2,unitCostCents:500,expiryIso:'2026-09-01',expiryRequired:true,reviewed:true}]})).reason,/أقدم من تاريخ الشراء/);
});

test('draft: الإجمالي المعلن يجب أن يطابق مجموع البنود (بلا حسم/نقل/رصيد سابق)',()=>{
  assert.equal(validatePurchaseDraft(DRAFT({declaredTotalCents:999})).ok,false);
  assert.match(validatePurchaseDraft(DRAFT({declaredTotalCents:999})).reason,/لا يطابق إجمالي فاتورة المورد/);
  // تقريب إلى قرش: 3 × 33.33 = 99.99 → 10000 قرش
  const r=validatePurchaseDraft(DRAFT({declaredTotalCents:9999,
    lines:[{productId:'p1',quantity:3,unitCostCents:3333,expiryIso:null,expiryRequired:false,reviewed:true}]}));
  assert.equal(r.ok,true);
});

test('draft: المدفوع وطريقة السداد',()=>{
  assert.match(validatePurchaseDraft(DRAFT({paidCents:null})).reason,/حدد المبلغ المدفوع/);
  assert.match(validatePurchaseDraft(DRAFT({paidCents:2000})).reason,/خارج إجمالي الفاتورة/);
  assert.match(validatePurchaseDraft(DRAFT({paymentType:'cash'})).reason,/يجب أن تُدفع كاملة/);
  assert.match(validatePurchaseDraft(DRAFT({paymentType:'credit',paidCents:1000})).reason,/لا يوجد متبقٍ آجل/);
  assert.equal(validatePurchaseDraft(DRAFT({paymentType:'bad'})).reason,'طريقة سداد المشتريات غير صحيحة');
});

function BUY(ls,over={}){
  return ls.rpc('rfq_pilot_save_purchase_v3',{p_supplier:'s1',
    p_lines:[{product_id:'p1',qty_milli:10000,cost_cents:300,expiry_date:'2026-12-01'},
             {product_id:'p1',qty_milli:20000,cost_cents:280,expiry_date:'2027-03-01'}],
    p_paid_cents:8600,p_declared_total_cents:8600,p_invoice_ref:'INV-7',p_invoice_date:'2026-10-01',
    p_image_sha256:'a'.repeat(64),p_image_thumb:'data:image/jpeg;base64,x',p_idempotency_key:'k1',...over});
}
function SELL(ls,qtyM,id){
  return ls.rpc('rfq_pilot_post_invoice_v3',{p_shift:null,p_device:'d1',p_invoice:id,p_customer:null,
    p_lines:[{product_id:'p1',qty_milli:qtyM,expected_price_cents:500,expected_name:'حليب'}],
    p_cash_cents:Math.round(qtyM/1000*500),p_other_cents:0,p_sms_consent:false});
}

test('local: الشراء يبني دفعتين بصلاحياتهما + ميتا الفاتورة',()=>{
  const {ls}=seedStore();
  const r=BUY(ls);
  assert.equal(r.total_cents,8600);
  const b=productBatches(ls,'p1');
  assert.equal(b.length,2);
  assert.deepEqual(b.map(x=>[x.qty_milli,x.expiry_date]),[[10000,'2026-12-01'],[20000,'2027-03-01']]);
  const pu=ls.db.purchases.find(p=>p.id===r.purchase_id);
  assert.equal(pu.invoice_ref,'INV-7');assert.equal(pu.image_sha256,'a'.repeat(64));
  assert.equal(pu.pay_kind,'cash');
});

test('local: الترحيل معرّفه idempotent — إعادة الضغط لا تكرر القيد',()=>{
  const {ls}=seedStore();
  const a=BUY(ls);
  const b=BUY(ls);
  assert.equal(b.already_committed,true);assert.equal(b.purchase_id,a.purchase_id);
  assert.equal(ls.db.purchases.length,1);
  assert.equal(productBatches(ls,'p1').length,2);
});

test('local: البيع يصرف بالأقرب صلاحية أولًا (FEFO)',()=>{
  const {ls}=seedStore();
  BUY(ls);
  SELL(ls,12000,'i1');
  const b=productBatches(ls,'p1');
  assert.deepEqual(b.map(x=>[x.qty_milli,x.expiry_date]),[[18000,'2027-03-01']]);
});

test('local: الإلغاء يستعيد الدفعات الأصلية كاملة',()=>{
  const {ls}=seedStore();
  BUY(ls);SELL(ls,12000,'i1');
  ls.rpc('rfq_pilot_void_invoice',{p_invoice:'i1',p_reason:'إلغاء تجريبي موثّق'});
  assert.deepEqual(productBatches(ls,'p1').map(x=>[x.qty_milli,x.expiry_date]),[[10000,'2026-12-01'],[20000,'2027-03-01']]);
  assert.equal(ls.db.products.find(p=>p.id==='p1').stock_milli,30000);
});

test('local: الكمية المنتهية غير صالحة للبيع',()=>{
  const {ls}=seedStore();
  ls.rpc('rfq_pilot_save_purchase_v3',{p_supplier:'s1',
    p_lines:[{product_id:'p1',qty_milli:5000,cost_cents:300,expiry_date:'2020-01-01'}],
    p_paid_cents:0,p_declared_total_cents:1500});
  assert.equal(sellableQty(ls,'p1'),0);
  assert.throws(()=>SELL(ls,5000,'i9'),/منتهية الصلاحية/);
});

test('local: تقرير القريب انتهاءً والمنتهي يعمل',()=>{
  const {ls}=seedStore();
  BUY(ls);
  const rows=expiringBatches(ls,3650);
  assert.equal(rows.length,2);
  assert.equal(rows[0].expiry_date,'2026-12-01');
});

test('local: كشف المورّد يفصل رقم الفاتورة وتاريخها وصلاحية البنود',()=>{
  const {ls}=seedStore();
  BUY(ls);
  const st=ls.rpc('rfq_pilot_supplier_statement',{p_supplier:'s1'});
  const pu=st.find(r=>r.kind==='purchase');
  assert.equal(pu.invoice_ref,'INV-7');assert.equal(pu.invoice_date,'2026-10-01');
  assert.deepEqual(pu.lines.map(l=>l.expiry_date),['2026-12-01','2027-03-01']);
});

test('local: صلاحية الشراء البسيط (v2) تُقبل من الحقول القديمة أيضًا',()=>{
  const {ls}=seedStore();
  ls.rpc('rfq_pilot_save_purchase_v2',{p_supplier:'s1',
    p_lines:[{product_id:'p1',qty_milli:4000,cost_cents:100,expiry:'2027-06-01'}],p_paid_cents:0});
  assert.equal(productBatches(ls,'p1').find(b=>b.expiry_date==='2027-06-01').qty_milli,4000);
});

test('ocr: محلل الأسطر يقترح الاسم والباركود وينبّه على الناقص',()=>{
  const r=parseOcrLine('حليب نيدو 1234567890123 4500 5');
  assert.equal(r.name,'حليب نيدو');
  assert.equal(r.barcode,'1234567890123');
  assert.ok(r.flags.length>0,'السطر الملتبس يحمل تنبيهات لا قرارًا');
});

test('ui: شاشة القراءة والمراجعة موصولة بالكامل',()=>{
  for(const id of ['ocrDraftCard','ocrCaptureBtn','ocrFile','ocrRunBtn','ocrImagePreview','ocrInvoiceRef','ocrInvoiceDate',
    'ocrSupplier','ocrPayType','ocrPayMethod','ocrDeclaredTotal','ocrPaid','ocrFromShift','ocrLinesBox','ocrAddRowBtn',
    'ocrMarkAllBtn','ocrPostBtn','ocrRulesMsg','expiringCard','expiringTable'])
    assert.ok(html.includes(`id="${id}"`),'missing #'+id);
  assert.ok(html.includes('wasm-unsafe-eval'),'CSP must allow wasm for local OCR');
  assert.ok(html.includes('assets/tesseract/tesseract.min.js'),'OCR engine not linked');
  for(const s of ["function renderOcrRows","validatePurchaseDraft(draft)","rfq_pilot_save_purchase_v3","runLocalOcr","normalizeInvoiceImage"])
    assert.ok(webjs.includes(s),'missing '+s);
  assert.ok(webjs.includes("expiry:x.noExpiry?null:(x.expiry||null),"),'server expiry key missing');
});
