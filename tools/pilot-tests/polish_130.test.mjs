// واجهة 130 — اختبارات ثابتة تحمي إصلاحات: لوحة المفاتيح، فراغ نموذج البيع،
// بنود الشراء، الملف الشخصي، طلبات الموردين، الكشف الكلاسيكي، قفل البصمة/PIN، وPDF.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const js=readFileSync(new URL('../../web-client/web.js',import.meta.url),'utf8');
const html=readFileSync(new URL('../../web-client/index.html',import.meta.url),'utf8');
const css=readFileSync(new URL('../../web-client/web.css',import.meta.url),'utf8');
const kt=readFileSync(new URL('../../app/src/main/java/net/arena/rafiq/CloudPilotActivity.kt',import.meta.url),'utf8');
const lock=readFileSync(new URL('../../app/src/main/java/net/arena/rafiq/AppLock.kt',import.meta.url),'utf8');

test('130 keyboard: blur/scroll/kb-open + close on buttons',()=>{
  assert.match(js,/function blurActive\(\)/);
  assert.match(js,/setKeyboardOpen\(true\)/);
  assert.match(js,/visualViewport/);
  assert.match(js,/scrollIntoView\(\{block:'center'/);
  assert.match(css,/\.kb-open \.bottom-nav/);
  assert.match(kt,/SOFT_INPUT_ADJUST_RESIZE/);
});

test('130 sale form resets after every save path',()=>{
  assert.match(js,/function resetSaleFields\(\)/);
  const start=js.indexOf('async function submitPending');
  const end=js.indexOf("retryPending").valueOf()>start?js.indexOf("retryPending"):js.indexOf("$('retryPending')");
  const saves=js.slice(start,js.indexOf("$('retryPending').onclick"));
  assert.ok((saves.match(/resetSaleFields\(\)/g)||[]).length>=4,'كل مسارات الحفظ تُفرّغ النموذج');
});

test('130 purchase lines: product options refresh + date dir',()=>{
  assert.match(js,/function refreshDynProductSelects\(\)/);
  assert.match(js,/exp\.dir='ltr'/);
  assert.match(html,/id="productExpiry" dir="ltr"/);
});

test('130 profile + supplier requests + statement + drawer',()=>{
  assert.match(js,/rfq_pilot_save_my_profile/);
  assert.match(js,/rfq_pilot_request_supplier/);
  assert.match(js,/rfq_pilot_decide_supplier_request/);
  assert.match(js,/rfq_pilot_set_member_perm/);
  assert.match(html,/id="statementPanel"/);
  assert.match(html,/drawer-brand/);
  assert.match(html,/drawerStorePhoto/);
  assert.match(html,/id="workerSupplierRequest"/);
  assert.match(js,/stmt-items/);
});

test('130 lock: biometric/PIN bridge',()=>{
  assert.match(kt,/RafiqAppLock/);
  assert.match(lock,/BiometricPrompt/);
  assert.match(js,/bridgeLock/);
  assert.match(html,/lockBiometric/);
});

test('130 whatsapp pdf mode + sms ack fix',()=>{
  assert.match(html,/value="pdf">ملف PDF \+ نص/);
  assert.match(js,/st\.wa_invoice_mode==='pdf'\?'pdf':'text'/);
  assert.match(js,/err=ok\?'':/);
});

test('130 mirrors stay identical',()=>{
  const a=readFileSync(new URL('../../app/src/main/assets/pilot/web.js',import.meta.url),'utf8');
  assert.equal(js,a,'web.js يجب أن يكون متطابقًا في الأصول');
  const h=readFileSync(new URL('../../app/src/main/assets/pilot/index.html',import.meta.url),'utf8');
  assert.equal(html,h,'index.html يجب أن يكون متطابقًا في الأصول');
  const c=readFileSync(new URL('../../app/src/main/assets/pilot/web.css',import.meta.url),'utf8');
  assert.equal(css,c,'web.css يجب أن يكون متطابقًا في الأصول');
});
