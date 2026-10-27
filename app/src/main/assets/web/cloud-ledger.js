/* Original Android cash/POS/customers/owner views use ONE server financial ledger.
 * Room remains an unmodified local archive. Mutations save an intent UUID on this
 * handset BEFORE contacting the server; uncertain replies never create a new UUID.
 * Foreground sound is not background Push. No automatic SMS or cloud PDF here.
 */
(function(root){
  'use strict';
  const $=id=>root.document.getElementById(id),shift=()=>root.RafiqCloudShift;
  const uuid=x=>/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(x||''));
  const money=n=>shift().formatCents(n),parse=n=>shift().amountCents(n);
  const commands=new Set(['rfq_pilot_post_invoice_checked','rfq_pilot_create_customer',
    'rfq_pilot_collect_debt','rfq_pilot_owner_add_debt','rfq_pilot_cash_advance',
    'rfq_pilot_owner_cash_adjust','rfq_pilot_create_product_once','rfq_pilot_adjust_stock']);
  const L={panel:null,kind:null,nav:0,identity:null,ready:false,loading:false,queued:false,busy:false,
    products:[],customers:[],cart:[],selected:'',invoice:null,sound:null,eventCursor:new Map()};
  function el(tag,text,cls){const n=root.document.createElement(tag);if(text!=null)n.textContent=String(text);
    if(cls)n.className=cls;return n;}
  function note(text,error=false){const n=$('cloudLedgerMessage');if(!n)return;
    n.textContent=String(text);n.className='flash '+(error?'error':'ok');}
  function current(s){return !!s&&L.panel?.isConnected&&
    (s.ledgerNav===undefined||s.ledgerNav===L.nav)&&
    L.panel.dataset.localUid===String(s.localUid)&&L.panel.dataset.localRole===s.role&&
    shift()?.session()?.epoch===s.epoch&&shift()?.session()?.userId===s.userId&&
    shift()?.session()?.store===s.store;}
  function session(){const s=shift()?.session();return current(s)?{...s,ledgerNav:L.nav}:null;}
  function identity(s){return `${s.store}:${s.userId}:${s.epoch}`;}
  function stopSound(){if(L.sound){try{L.sound.close().catch(()=>{});}catch{}L.sound=null;}}
  function resetIdentity(s){const key=identity(s);if(L.identity!==key){stopSound();L.eventCursor.clear();
    L.identity=key;L.products=[];L.customers=[];L.cart=[];L.selected='';L.invoice=null;L.ready=false;}}
  function pendingKey(s){return `rafiq:cloud-intent:v1:${s.store}:${s.userId}`;}
  function pending(s){const raw=root.localStorage.getItem(pendingKey(s));if(!raw)return null;
    let p;try{p=JSON.parse(raw);}catch{throw Error('تعذر قراءة العملية المالية المعلّقة؛ أوقف القيود وراجع الهاتف');}
    if(!p||!commands.has(p.name)||!p.payload||typeof p.payload!=='object'||
       !uuid(p.event)||JSON.stringify(p).length>5000)
      throw Error('عملية معلقة غير صالحة؛ لا تسجل قيداً جديداً');
    return p;}
  function setPending(s,p){try{if(p)root.localStorage.setItem(pendingKey(s),JSON.stringify(p));
    else root.localStorage.removeItem(pendingKey(s));}
    catch{throw Error('تعذر حفظ هوية العملية على هذا الهاتف؛ توقف عن تسجيل المال');}}
  function safeUuid(){if(root.crypto?.randomUUID)return root.crypto.randomUUID();
    if(!root.crypto?.getRandomValues)throw Error('تعذر إنشاء معرف آمن؛ لا تسجل قيداً');
    const b=new Uint8Array(16);root.crypto.getRandomValues(b);b[6]=(b[6]&15)|64;b[8]=(b[8]&63)|128;
    const h=Array.from(b,x=>x.toString(16).padStart(2,'0')).join('');
    return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;}
  function amount(v,allowZero=false){const n=parse(v);if(!allowZero&&n<=0)throw Error('المبلغ يجب أن يكون أكبر من صفر');return n;}
  function qty(v){const s=String(v??'').trim().replace(/[٠-٩]/g,d=>String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
    .replace(/[۰-۹]/g,d=>String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d))).replace(/٫/g,'.');
    if(!/^\d{1,4}(?:\.\d{1,3})?$/.test(s))throw Error('اكتب كمية موجبة بثلاث منازل عشرية على الأكثر');
    const [a,b='']=s.split('.'),n=Number(a)*1000+Number(b.padEnd(3,'0'));
    if(n<1||n>1000000)throw Error('الكمية المسموحة من ٠٫٠٠١ حتى ١٠٠٠');return n;}
  function confirmed(text){if(!root.confirm(text))throw Error('أُلغي الطلب دون تسجيل أي قيد');}
  function writable(s,ownerOnly=false){if(!s||!L.ready||L.loading||!s.approved||!root.navigator.onLine||
    (ownerOnly&&s.role!=='owner')||(s.role==='worker'&&!s.shift))return false;
    try{return !pending(s);}catch{return false;}}
  function setButtons(s){const can=!L.busy&&writable(s),owner=!L.busy&&writable(s,true);
    const retry=$('cloudPending')?.querySelector('button');if(retry)retry.disabled=L.busy||!root.navigator.onLine;
    const reload=$('cloudSaleReload');if(reload)reload.disabled=L.busy||L.loading;
    const notice=$('cloudOwnerNotification');if(notice)notice.hidden=s?.role!=='owner'||!s.approved;
    const sound=$('cloudOwnerSound')||$('cloudEyeSound');if(sound){sound.disabled=L.busy||s?.role!=='owner'||!s.approved;
      sound.textContent=L.sound?'إيقاف نغمة المالك في التطبيق':'تفعيل نغمة المالك أثناء فتح التطبيق فقط';}
    for(const id of ['cloudSaleSubmit','cloudSaleAdd','cloudCustomerSubmit','cloudCollectionSubmit'])if($(id))
      $(id).disabled=!can||(id==='cloudSaleSubmit'&&!L.cart.length)||
        (id==='cloudCollectionSubmit'&&s?.role!=='worker');
    for(const id of ['cloudOwnerDebtSubmit','cloudAdvanceSubmit','cloudCashAdjustSubmit',
      'cloudProductSubmit','cloudStockSubmit'])if($(id))$(id).disabled=!owner;}
  async function run(fn){if(L.busy)return;L.busy=true;const nav=L.nav;setButtons(session());
    try{await fn();}catch(e){if(nav!==L.nav)return;note(e?.name==='AbortError'||e?.name==='TypeError'?
      'نتيجة الاتصال غير مؤكدة. لا تنشئ قيداً بمعرف جديد؛ أعد العملية المعلقة نفسها بعد عودة الاتصال.':
      (e?.message||'تعذر تأكيد القيد الخادمي'),true);}
    finally{if(nav===L.nav){L.busy=false;const s=session();if(s){try{pendingUi(s);}catch(e){note(e.message,true);}setButtons(s);}}}}
  function financialPayloadValid(s,p){if(!commands.has(p.name)||!p.payload)return false;
    if(p.payload.p_store!=null&&p.payload.p_store!==s.store)return false;
    if(p.payload.p_device!=null&&p.payload.p_device!==s.device)return false;
    if(p.payload.p_shift!=null&&!uuid(p.payload.p_shift))return false;
    if(p.name==='rfq_pilot_post_invoice_checked'&&
      (p.payload.p_invoice!==p.event||!Number.isSafeInteger(p.payload.p_quoted_total_cents)||
       p.payload.p_quoted_total_cents<0))return false;
    if(p.name==='rfq_pilot_create_customer'&&p.payload.p_id!==p.event)return false;
    if(p.name==='rfq_pilot_create_product_once'&&p.payload.p_id!==p.event)return false;
    for(const name of ['rfq_pilot_collect_debt','rfq_pilot_owner_add_debt',
      'rfq_pilot_cash_advance','rfq_pilot_owner_cash_adjust','rfq_pilot_adjust_stock'])
      if(p.name===name&&p.payload.p_event!==p.event)return false;
    return true;}
  function pendingUi(s){$('cloudPending')?.remove();const n=$('cloudLedgerMessage');if(!n||!s)return;
    const p=pending(s);if(!p)return;
    const box=el('div',null,'card mt');box.id='cloudPending';
    box.append(el('p',`قيد خادمي غير مؤكَّد (${p.kind}): لا تُنشئ قيداً جديداً. المعرف ${p.event.slice(0,8)}`,'flash error'));
    const btn=el('button','التحقق بإعادة العملية نفسها (منع التكرار)','btn amber wide');btn.type='button';
    btn.disabled=L.busy||!root.navigator.onLine;
    btn.onclick=()=>run(async()=>{await retryPending(s);note('أكد الخادم العملية بالمعرف نفسه.');await refresh();});
    box.append(btn);n.insertAdjacentElement('afterend',box);}
  function afterAck(p,result){const forms={rfq_pilot_create_customer:'cloudCustomerForm',
      rfq_pilot_collect_debt:'cloudCollectionForm',rfq_pilot_owner_add_debt:'cloudOwnerDebtForm',
      rfq_pilot_cash_advance:'cloudAdvanceForm',rfq_pilot_owner_cash_adjust:'cloudCashAdjustForm',
      rfq_pilot_create_product_once:'cloudProductForm',rfq_pilot_adjust_stock:'cloudStockForm'};
    if(p.name==='rfq_pilot_post_invoice_checked'){L.cart=[];if(L.kind==='pos')renderCart();showReceipt(result);}
    else if($(forms[p.name]))$(forms[p.name]).reset();}
  function showReceipt(r){const box=$('cloudSaleReceipt');if(!box||!r?.invoice_id)return;
    box.hidden=false;box.replaceChildren(el('div',`أكد الخادم الفاتورة #${r.number}`,'h2'),
      el('p',`الإجمالي ${money(r.total_cents)} • الدين ${money(r.due_cents)} • المعرّف ${r.invoice_id}`),
      el('p','لا SMS تلقائي ولا PDF خادمي في هذه النسخة؛ لا تفتح فاتورة Room بالرقم نفسه.','small muted'));}
  function confirmedResult(p,r){const cents=n=>typeof n==='number'&&Number.isSafeInteger(n);
    if(p.name==='rfq_pilot_post_invoice_checked')return r&&typeof r==='object'&&
      r.invoice_id===p.event&&cents(r.number)&&r.number>0&&
      cents(r.total_cents)&&r.total_cents===p.payload.p_quoted_total_cents&&
      cents(r.due_cents)&&r.due_cents===r.total_cents-p.payload.p_cash_cents&&
      typeof r.already_committed==='boolean';
    if(p.name==='rfq_pilot_cash_advance')return r&&typeof r==='object'&&
      r.event_id===p.event&&cents(r.till_cents)&&cents(r.customer_balance_cents)&&
      typeof r.already_committed==='boolean';
    if(p.name==='rfq_pilot_create_customer'||p.name==='rfq_pilot_create_product_once')return r===p.event;
    return cents(r);}
  async function retryPending(s){if(!current(s)||!root.navigator.onLine)throw Error('اتصل بالإنترنت وسجل دخول هذا الحساب أولاً');
    const p=pending(s);if(!p||!financialPayloadValid(s,p))throw Error('قيد معلق غير متطابق مع الحساب؛ لا تعِد القيد');
    const result=await s.api.rpc(p.name,p.payload);
    if(!current(s))throw Error('تغير الحساب قبل تأكيد القيد؛ تحقق من الحساب نفسه');
    if(JSON.stringify(pending(s))!==JSON.stringify(p))throw Error('تغير القيد المعلّق؛ توقف للتحقق');
    if(!confirmedResult(p,result))throw Error('رد الخادم غير مكتمل أو مخالف للقيد؛ احتفظ بمعرف العملية ولا تنشئ قيداً جديداً');
    setPending(s,null);afterAck(p,result);pendingUi(s);return result;}
  async function once(s,kind,name,event,payload){if(!current(s)||!root.navigator.onLine||!L.ready)
      throw Error('دفتر الخادم غير جاهز؛ لا تسجل مالاً محلياً');
    if(pending(s))throw Error('عملية معلقة؛ تحقق من معاملتها ذاتها أولاً');
    const p={kind,name,event,payload};if(!financialPayloadValid(s,p))throw Error('قيد غير آمن');
    setPending(s,p);pendingUi(s);setButtons(s);
    try{return await retryPending(s);}catch(e){
      // Only a structured, transactional P0001 refusal from the FIRST request
      // is known not to have committed. A later retry after a lost reply is
      // deliberately NOT cleared: the original request may still be running.
      if(e?.definiteNoCommit&&current(s)){
        let unchanged=false;try{unchanged=JSON.stringify(pending(s))===JSON.stringify(p);}catch{}
        if(unchanged){setPending(s,null);pendingUi(s);setButtons(s);
          e.message=`رفض الخادم الطلب دون قيد. حُذفت نية هذه المحاولة فقط؛ حدّث الأسعار/الرصيد وراجع من جديد. السبب: ${e.message}`;}
      }
      throw e;}}
  function row(main,detail){const r=el('div',null,'rowline'),title=el('span',null,'who');
    title.append(el('span',main,'nm'));if(detail)title.append(el('span',detail,'sub'));r.append(title);return r;}
  function options(select,items,label,empty){if(!select)return;const before=select.value;select.replaceChildren();
    const first=el('option',empty);first.value='';select.append(first);
    for(const x of items){const o=el('option',label(x));o.value=x.id;select.append(o);}
    if(items.some(x=>x.id===before))select.value=before;}
  function time(v){const n=new Date(v);return Number.isNaN(n.getTime())?'':n.toLocaleString('ar-YE');}
  function lockView(s){for(const id of ['cloudPosWorker','cloudCustomersActive','cloudDashboardActive','cloudEyeActive'])
      if($(id))$(id).hidden=!s;
    for(const id of ['cloudPosLocked','cloudCustomersLocked','cloudDashboardLocked','cloudEyeLocked'])
      if($(id))$(id).hidden=!!s;}
  async function heartbeat(s){if(s.role!=='worker')return;
    await s.api.rpc('rfq_pilot_heartbeat',{p_store:s.store,p_device:s.device});
    if(!current(s))throw Error('تغير الحساب أثناء التحديث');}
  async function shiftsFor(s){if(s.role==='owner')return s.api.table('rfq_pilot_shifts',{
      store_id:'eq.'+s.store,status:'eq.open',select:'id,worker_id,opening_cents,opened_at',order:'opened_at.desc',limit:'30'});
    if(!s.shift)return [];
    const id=await s.api.rpc('rfq_pilot_my_open_shift',{p_store:s.store,p_device:s.device});
    if(id!==s.shift)throw Error('انتهت الوردية أو تغيرت؛ ارجع للصندوق وحدّث الحالة');
    return [{id,worker_id:s.userId}];}
  function renderCashSnapshot(snap){$('cloudCashSummary').replaceChildren(el('span',
      `عهدة ${money(snap.opening_cents)} • بيع نقدي ${money(snap.sale_cents)} • تحصيل ${money(snap.collection_cents)} • سلف مصروفة ${money(snap.cash_advance_cents)} • باقي الحركات ${money(snap.other_net_cents)} • المتوقع في الدرج ${money(snap.expected_cents)}`));
    const list=$('cloudCashEntries');list.replaceChildren();const names={sale:'بيع نقدي',collection:'تحصيل',
      cash_advance:'سلفة نقدية مصروفة',income:'دخل',expense:'مصروف',withdraw:'سحب مالك'};
    for(const x of snap.entries||[])list.append(row(`${names[x.kind]||x.kind}: ${money(x.amount_cents)}`,
      `${time(x.created_at)}${x.reason?' • '+x.reason:''}`));
    if(!snap.entries?.length)list.append(el('p','لم تسجل حركات نقدية في هذه الوردية بعد.','muted'));
    if((snap.entries||[]).length>=snap.shown_limit)list.append(el('p','آخر 60 حركة فقط؛ الرصيد يحسب الجميع.','small muted'));}
  async function loadCash(s){await heartbeat(s);const shifts=await shiftsFor(s);if(!current(s))return;
    const select=$('cloudCashShift');options(select,shifts,x=>`${x.id.slice(0,8)} — العامل ${x.worker_id.slice(0,8)}`,'— لا وردية مفتوحة —');
    if(s.role==='worker'&&shifts.length)select.value=shifts[0].id;
    else if(!select.value&&shifts.length)select.value=shifts[0].id;
    $('cloudCashAdjustForm').hidden=s.role!=='owner'||!select.value;
    if(!select.value){$('cloudCashSummary').textContent='لا وردية خادمية مفتوحة؛ لا رصيد موحد مع أرشيف الهاتف.';
      $('cloudCashEntries').replaceChildren();note('لا وردية خادمية مفتوحة؛ لا حركة صندوق.');return;}
    const snap=await s.api.rpc('rfq_pilot_shift_cash_snapshot',{
      p_shift:select.value,p_device:s.role==='worker'?s.device:null});
    if(!current(s)||select.value!==snap.shift_id)return;
    renderCashSnapshot(snap);note('تأكد رصيد الصندوق من الخادم؛ لا يدخل أرشيف هذا الهاتف في الإجمالي.');}
  function cartTotal(){return L.cart.reduce((sum,x)=>sum+Math.round(x.price_cents*x.qty_milli/1000),0);}
  function renderDue(){if(!$('cloudSaleDue'))return;let paid;
    try{paid=amount($('cloudSalePaid').value,true);}catch{$('cloudSaleDue').textContent='اكتب مبلغ النقد صحيحاً (0 للآجل الكامل)';return;}
    $('cloudSaleDue').textContent=`النقد ${money(paid)} • الباقي بالدين ${money(Math.max(0,cartTotal()-paid))}`;}
  function renderCart(){const box=$('cloudSaleCart');if(!box)return;box.replaceChildren();
    for(const line of L.cart){const item=row(`${line.name} × ${line.qty_milli/1000}`,
      money(Math.round(line.price_cents*line.qty_milli/1000)));
      const btn=el('button','إزالة','btn sm ghost');btn.type='button';btn.onclick=()=>{
        L.cart=L.cart.filter(x=>x.id!==line.id);renderCart();};item.append(btn);box.append(item);}
    if(!L.cart.length)box.append(el('p','السلة فارغة؛ لم يُسجَّل أي قيد.','muted'));
    $('cloudSaleTotal').textContent=`الإجمالي الخادمي الاسترشادي: ${money(cartTotal())}`;
    renderDue();setButtons(session());}
  function renderSaleProducts(){const search=$('cloudSaleSearch');if(!search)return;
    const q=search.value.trim().toLocaleLowerCase('ar');const filtered=L.products.filter(x=>
      !q||x.name.toLocaleLowerCase('ar').includes(q)||String(x.barcode||'').includes(q));
    options($('cloudSaleProduct'),filtered.slice(0,80),
      x=>`${x.name} — ${money(x.price_cents)} — رصيد ${x.stock_milli/1000}`,
      filtered.length?'اختر الصنف الصحيح':'لا تطابق في مخزون المتجر الجديد');}
  async function loadPos(s){if(s.role!=='worker'){lockView(null);note('البيع في وردية العامل فقط.',true);return;}
    if(!s.approved||!s.shift){lockView(null);note('لا بيع دون جهاز معتمد ووردية خادمية مفتوحة. ابدأ من الصندوق.',true);return;}
    await heartbeat(s);await shiftsFor(s);
    const [products,customers]=await Promise.all([
      s.api.table('rfq_pilot_products',{store_id:'eq.'+s.store,active:'eq.true',
        select:'id,name,barcode,unit,price_cents,stock_milli,active',order:'name.asc',limit:'300'}),
      s.api.table('rfq_pilot_customers',{store_id:'eq.'+s.store,active:'eq.true',
        select:'id,name,phone,active',order:'name.asc',limit:'300'})]);
    if(!current(s))return;L.products=products;L.customers=customers;
    const latest=new Map(products.map(p=>[p.id,p]));
    const stale=L.cart.filter(line=>{const p=latest.get(line.id);
      return !p||p.price_cents!==line.price_cents||p.stock_milli<line.qty_milli;});
    if(stale.length)L.cart=L.cart.filter(line=>!stale.includes(line));
    options($('cloudSaleCustomer'),customers,x=>x.name,'بلا زبون — دفع كامل');
    renderSaleProducts();renderCart();lockView(s);
    $('cloudPosSession').textContent=`وردية الخادم ${s.shift.slice(0,8)} • ${products.length} صنف/حتى 300 • تحديث المخزون من الخادم`;
    note(stale.length?`تغيّر سعر/رصيد ${stale.map(x=>x.name).join('، ')}؛ أُزيل من المسودة دون فاتورة. راجع السلة والدفع وأضفه بالسعر الجديد بعد التحديث.`:
      'الوردية معتمدة. البيع النهائي لا يُحفظ إلا بعد مراجعة المبلغ والزبون وتأكيد خادمي.',!!stale);}
  function renderCustomerList(data){$('cloudAllDebts').textContent=money(data.outstanding_cents);
    $('cloudCustomersCount').textContent=`${data.customer_count} زبون خادمي؛ تُعرض أول ${data.shown_limit} بالاسم فقط. الرصيد الكلي يحسب الجميع.`;
    const select=$('cloudSelectedCustomer');options(select,data.customers,x=>`${x.name} — ${money(x.balance_cents)}`,'— اختر زبوناً —');
    if(L.selected&&data.customers.some(x=>x.id===L.selected))select.value=L.selected;
    L.selected=select.value;const list=$('cloudCustomerList');list.replaceChildren();
    for(const x of data.customers){const r=row(x.name,`${money(x.balance_cents)} • ${x.phone||'لا هاتف'}`);
      r.tabIndex=0;r.onclick=()=>{select.value=x.id;select.dispatchEvent(new root.Event('change'));};list.append(r);}
    if(!data.customers.length)list.append(el('p','لا زبائن خادميون؛ أرشيف الهاتف غير مستورد.','muted'));}
  async function loadStatement(s){const id=$('cloudSelectedCustomer')?.value,box=$('cloudCustomerEntries');
    if(!id){$('cloudCustomerBalance').textContent='الرصيد: —';box.replaceChildren();return;}
    const result=await s.api.rpc('rfq_pilot_customer_statement',{
      p_store:s.store,p_device:s.device,p_customer:id});
    if(!current(s)||$('cloudSelectedCustomer')?.value!==id)return;
    $('cloudCustomerBalance').textContent=`رصيد ${result.customer_name}: ${money(result.balance_cents)}`;
    box.replaceChildren();const labels={invoice_due:'بضاعة بالدين — فاتورة',cash_advance:'سلفة نقدية مصروفة',
      collection:'تحصيل نقدي',owner_debit:'دين يدوي بلا صرف'};
    for(const e of result.entries||[])box.append(row(`${labels[e.kind]||e.kind}: ${money(e.amount_cents)}`,
      `${time(e.created_at)}${e.invoice_id?' • فاتورة '+e.invoice_id.slice(0,8):''}${e.note?' • '+e.note:''}`));
    if(!result.entries?.length)box.append(el('p','لا قيود لهذا الزبون بعد.','muted'));
    if(result.entry_count>result.shown_limit)box.append(el('p','آخر 150 قيداً فقط؛ الرصيد يحسب الجميع.','small muted'));}
  async function loadCustomers(s){await heartbeat(s);const [data,shifts]=await Promise.all([
      s.api.rpc('rfq_pilot_customer_overview',{p_store:s.store,p_device:s.device}),
      s.role==='owner'?shiftsFor(s):Promise.resolve([])]);
    if(!current(s))return;L.customers=data.customers||[];renderCustomerList(data);
    $('cloudCollectionForm').hidden=s.role!=='worker';$('cloudOwnerDebtForm').hidden=s.role!=='owner';
    $('cloudAdvanceForm').hidden=s.role!=='owner';
    options($('cloudAdvanceShift'),shifts,x=>`${x.id.slice(0,8)} — العامل ${x.worker_id.slice(0,8)}`,'— اختر وردية خادمية —');
    if($('cloudSelectedCustomer').value)await loadStatement(s);
    else{$('cloudCustomerBalance').textContent='الرصيد: —';$('cloudCustomerEntries').replaceChildren();}
    if(!current(s))return;lockView(s);note('كشف الديون من الخادم؛ أرشيف الهاتفين منفصل.');}
  function stats(box,pairs){box.replaceChildren();for(const [label,value] of pairs){const r=el('div',null,'card tight');
      r.append(el('div',label,'small muted'),el('b',value,'h2'));box.append(r);}}
  async function loadDashboard(s){if(s.role!=='owner')throw Error('اللوحة للمالك فقط');
    const [summary,invoices,shifts,products]=await Promise.all([
      s.api.rpc('rfq_pilot_owner_summary',{p_store:s.store}),
      s.api.table('rfq_pilot_invoices',{store_id:'eq.'+s.store,
        select:'id,number,total_cents,cash_paid_cents,due_cents,worker_id,created_at',order:'created_at.desc',limit:'30'}),
      shiftsFor(s),s.api.table('rfq_pilot_products',{store_id:'eq.'+s.store,active:'eq.true',
        select:'id,name,stock_milli',order:'name.asc',limit:'300'})]);
    if(!current(s))return;
    stats($('cloudDashboardStats'),[['مبيعات بضاعة',money(summary.sales_cents)],
      ['نقد البيع',money(summary.cash_received_on_sales_cents)],
      ['دين بضاعة جديد',money(summary.goods_credit_cents)],
      ['دين الزبائن القائم',money(summary.outstanding_debt_cents)],
      ['سلف نقدية للزبائن',money(summary.cash_advances_cents)],
      ['هامش تقديري لا ربح صافٍ',money(summary.gross_margin_estimate_cents)]]);
    const till=$('cloudDashboardTills');till.replaceChildren();for(const x of shifts){
      const snap=await s.api.rpc('rfq_pilot_shift_cash_snapshot',{p_shift:x.id,p_device:null});
      if(!current(s))return;till.append(row(`وردية ${x.id.slice(0,8)} • العامل ${x.worker_id.slice(0,8)}`,
        `عهدة ${money(snap.opening_cents)} • الدرج الآن ${money(snap.expected_cents)}`));}
    if(!shifts.length)till.append(el('p','لا ورديات خادمية مفتوحة.','muted'));
    const list=$('cloudDashboardInvoices');list.replaceChildren();for(const i of invoices)
      list.append(row(`فاتورة ${i.number} • ${money(i.total_cents)}`,
        `نقد ${money(i.cash_paid_cents)} • دين ${money(i.due_cents)} • ${time(i.created_at)} • عامل ${i.worker_id.slice(0,8)}`));
    if(!invoices.length)list.append(el('p','لا فواتير خادمية بعد.','muted'));
    options($('cloudStockProduct'),products,x=>`${x.name} — رصيد ${x.stock_milli/1000}`,'— اختر صنفاً خادمياً —');
    lockView(s);note('البيانات أُخذت من الخادم؛ إن كانت هناك حركة جديدة حدّث الصفحة.');}
  const eventLabels={device_requested:'طلب جهاز جديد',shift_requested:'طلب وردية من عامل',
    shift_approved:'اعتماد الوردية',shift_rejected:'رفض وردية',shift_closed:'إغلاق وردية',
    sale:'فاتورة بيع',collection:'تحصيل دين',cash_advance:'سلفة نقدية للزبون',
    cash_income:'دخل للصندوق',cash_expense:'مصروف من الصندوق',cash_withdraw:'سحب مالك',owner_debt:'دين يدوي'};
  function ping(){if(!L.sound)return;try{const ctx=L.sound,osc=ctx.createOscillator(),gain=ctx.createGain();
    osc.type='sine';osc.frequency.value=880;gain.gain.value=.09;osc.connect(gain);gain.connect(ctx.destination);
    osc.start();osc.stop(ctx.currentTime+.18);}catch{note('تعذر صوت التنبيه؛ راجع سجل العين.',true);}}
  async function pollOwnerEvents(s){if(s.role!=='owner'||root.document.visibilityState!=='visible')return [];
    const events=await s.api.table('rfq_pilot_owner_events',{store_id:'eq.'+s.store,
      select:'id,topic,reference_id,amount_cents,created_at',order:'id.desc',limit:'60'});
    if(!current(s))return [];
    const latest=Number(events[0]?.id||0),previous=L.eventCursor.get(s.store);
    if(previous!=null&&latest>previous){const fresh=events.filter(e=>Number(e.id)>previous),
        badge=$('cloudOwnerEventNotice');
      if(badge&&fresh.length){badge.hidden=false;
        badge.textContent=`${fresh.length} حدث جديد: ${eventLabels[fresh[0].topic]||'حركة موثقة'}. افتح العين للمراجعة.`;}
      if(fresh.length&&L.sound)ping();}
    if(previous==null||latest>previous)L.eventCursor.set(s.store,latest);
    return events;}
  function bindSound(id){const button=$(id);if(!button)return;button.onclick=()=>run(async()=>{
      const s=session();if(s?.role!=='owner'||!s.approved)throw Error('نغمة المالك للمالك المعتمد فقط');
      if(L.sound){stopSound();note('أُوقفت نغمة المقدمة.');return;}
      const Audio=root.AudioContext||root.webkitAudioContext;
      if(!Audio)throw Error('WebAudio غير مدعوم؛ لا تعتمد على النغمة');
      const ctx=new Audio();await ctx.resume();if(!current(s)){await ctx.close();return;}
      L.sound=ctx;note('النغمة أثناء ظهور التطبيق فقط، ليست إشعار Push في الخلفية.');});}
  async function loadEye(s){if(s.role!=='owner')throw Error('العين عن بُعد للمالك فقط');
    const [summary,events]=await Promise.all([
      s.api.rpc('rfq_pilot_owner_summary',{p_store:s.store}),pollOwnerEvents(s)]);
    if(!current(s))return;
    stats($('cloudEyeStats'),[['مبيعات بضاعة',money(summary.sales_cents)],
      ['دين الزبائن القائم',money(summary.outstanding_debt_cents)],
      ['سلف نقدية',money(summary.cash_advances_cents)]]);
    const list=$('cloudEyeEvents');list.replaceChildren();for(const e of events)
      list.append(row(`${eventLabels[e.topic]||e.topic}${e.amount_cents==null?'':' • '+money(e.amount_cents)}`,
        `${time(e.created_at)} • ${e.reference_id.slice(0,8)}`));
    if(!events.length)list.append(el('p','لا أحداث منذ ترقية مخطط الاختبار.','muted'));
    if(events.length===60)list.append(el('p','آخر 60 حدثاً فقط؛ ليس الأرشيف الكامل.','small muted'));
    lockView(s);note('سجل أحداث خادمي أثناء ظهور التطبيق فقط؛ لا Push خلفية.');}
  async function refresh(){if(L.loading){L.queued=true;return;}
    const s=session();if(!s){stopSound();L.eventCursor.clear();L.identity=null;
      L.ready=false;lockView(null);setButtons(null);
      note('افتح الصندوق وسجّل دخول حساب المتجر الموافق لدور هذا الهاتف.',true);return;}
    resetIdentity(s);if(!s.approved){L.ready=false;lockView(null);setButtons(s);
      note('الجهاز غير معتمد أو لم تتحدث حالته. ارجع للصندوق.',true);return;}
    L.loading=true;L.ready=false;setButtons(s);let success=false;
    try{if(L.kind==='cash')await loadCash(s);
      else if(L.kind==='pos')await loadPos(s);
      else if(L.kind==='customers')await loadCustomers(s);
      else if(L.kind==='dashboard')await loadDashboard(s);
      else if(L.kind==='eye')await loadEye(s);
      if(current(s)){pendingUi(s);success=true;
        if(s.role==='owner'&&L.kind!=='eye')
          pollOwnerEvents(s).catch(()=>{/* فشل التنبيه لا يوقف دفتر المال. */});}}
    catch(e){if(current(s)){L.ready=false;setButtons(s);note(
      'لم يتأكد دفتر الخادم. تحقق من SQL الاختبارية والجلسة والاتصال: '+(e?.message||'خطأ'),true);
      try{pendingUi(s);}catch(err){note(err.message,true);}}}
    finally{if(s.ledgerNav===L.nav){L.loading=false;L.ready=success&&current(s);setButtons(session());
      if(L.queued&&L.panel?.isConnected){L.queued=false;
        root.setTimeout(()=>refresh().catch(e=>note(e.message,true)),0);}}}}
  function addProduct(product,count){const s=session();if(!writable(s)||s.role!=='worker')return false;
    const p=L.products.find(x=>x.id===product.id);if(!p||p.stock_milli<1)return false;
    const q=qty(String(count)),old=L.cart.find(x=>x.id===p.id),sum=q+(old?.qty_milli||0);
    if(sum>p.stock_milli||sum>1000000||(L.cart.length>=100&&!old))return false;
    if(old)old.qty_milli=sum;else L.cart.push({id:p.id,name:p.name,price_cents:p.price_cents,qty_milli:q});
    renderCart();return true;}
  function voiceAdapter(){root.rafiqVoicePos={cloud:true,
    findProducts(query){if(!session()||!L.ready)return [];const q=String(query||'').trim().toLocaleLowerCase('ar');
      return L.products.filter(p=>p.name.toLocaleLowerCase('ar').includes(q)||String(p.barcode||'')===q)
        .slice(0,8).map(p=>({...p,stock:p.stock_milli/1000}));},
    addProduct(product,count){return addProduct(product,count);},
    quote(){if(!L.cart.length)throw Error('السلة فارغة');return {totalCents:cartTotal(),
      lines:L.cart.map(x=>`${x.name} × ${x.qty_milli/1000}`)};},
    checkout(kind,customerQuery){if(!writable(session())||!L.cart.length)return false;
      const exact=String(customerQuery||'').trim();
      if(kind==='cash'){$('cloudSalePaid').value=String(cartTotal()/100);$('cloudSaleCustomer').value='';}
      else{$('cloudSalePaid').value='0';if(exact){const matches=L.customers.filter(c=>
        c.name.trim()===exact||String(c.phone||'')===exact);if(matches.length===1)$('cloudSaleCustomer').value=matches[0].id;}}
      renderDue();$('cloudSalePaid').scrollIntoView?.({block:'center'});return true;},
    lastInvoiceId(){return null;} // Room PDF must never receive a cloud UUID.
  };}
  function bindPos(){voiceAdapter();$('cloudSaleSearch').oninput=renderSaleProducts;
    $('cloudSaleReload').onclick=()=>run(refresh);
    $('cloudSalePaid').oninput=renderDue;
    $('cloudSaleCamera').onclick=()=>{if(!root.openCameraScanner){note('ماسح الهاتف غير متاح',true);return;}
      root.openCameraScanner(code=>{$('cloudSaleSearch').value=String(code).slice(0,80);renderSaleProducts();});};
    $('cloudSaleAdd').onclick=()=>run(async()=>{const p=L.products.find(x=>x.id===$('cloudSaleProduct').value);
      if(!p||!addProduct(p,$('cloudSaleQty').value))throw Error('اختر صنفاً بكمية ضمن الرصيد الخادمي');
      note('أُضيف إلى السلة للمراجعة؛ لا فاتورة ولا حركة صندوق بعد.');});
    $('cloudSaleForm').onsubmit=e=>{e.preventDefault();run(async()=>{const s=session();
      if(!writable(s)||s.role!=='worker')throw Error('لا وردية خادمية معتمدة');
      if(!L.cart.length)throw Error('السلة فارغة');
      const total=cartTotal(),cash=amount($('cloudSalePaid').value,true);
      if(cash>total)throw Error('المقبوض أكبر من الإجمالي؛ لا يصرف الباقي نقداً هنا');
      const customer=$('cloudSaleCustomer').value||null,due=total-cash;
      if((due>0&&!customer)||(due===0&&customer))throw Error('اختر زبوناً فقط إذا بقي مبلغ بالدين');
      confirmed(`فاتورة بضاعة ${money(total)}؛ نقد ${money(cash)}؛ دين ${money(due)}${customer?' للزبون '+(L.customers.find(x=>x.id===customer)?.name||''):''}؟ يخصم الخادم المخزون مرة واحدة.`);
      const event=safeUuid(),lines=L.cart.map(x=>({product_id:x.id,qty_milli:x.qty_milli,
        quoted_price_cents:x.price_cents}));
      const result=await once(s,'فاتورة بضاعة','rfq_pilot_post_invoice_checked',event,{
        p_shift:s.shift,p_device:s.device,p_invoice:event,p_customer:customer,p_lines:lines,
        p_cash_cents:cash,p_sms_consent:false,p_quoted_total_cents:total});
      if(!current(s))return;L.invoice=result;
      note(result.already_committed?'أكد الخادم الفاتورة المحفوظة بنفس المعرف.':'حفظ الخادم الفاتورة؛ حدث هاتف المالك لرؤيتها.');
      await refresh();});};}
  function selectedCustomer(){const id=$('cloudSelectedCustomer')?.value;
    if(!uuid(id)||!L.customers.some(x=>x.id===id))throw Error('اختر زبوناً خادمياً');return id;}
  function bindCustomers(){$('cloudSelectedCustomer').onchange=()=>{L.selected=$('cloudSelectedCustomer').value;
      const s=session();if(s)run(()=>loadStatement(s));};
    $('cloudCustomerForm').onsubmit=e=>{e.preventDefault();run(async()=>{const s=session();
      if(!writable(s))throw Error('جلسة المتجر أو الوردية غير جاهزة');
      const name=$('cloudCustomerName').value.trim(),phone=$('cloudCustomerPhone').value.trim();
      if(name.length<1||name.length>120||phone.length>30)throw Error('تحقق من الاسم والهاتف');
      confirmed(`إضافة الزبون ${name} إلى المتجر الجديد بلا نقل دين قديم؟`);
      const event=safeUuid();await once(s,'زبون جديد','rfq_pilot_create_customer',event,{
        p_store:s.store,p_device:s.device,p_id:event,p_name:name,p_phone:phone});
      if(!current(s))return;e.target.reset();note('أُضيف زبون خادمي دون نقل رصيد قديم.');await refresh();});};
    $('cloudCollectionForm').onsubmit=e=>{e.preventDefault();run(async()=>{const s=session();
      if(!writable(s)||s.role!=='worker')throw Error('التحصيل للعامل في وردية مفتوحة فقط');
      const id=selectedCustomer(),v=amount($('cloudCollectionAmount').value);
      confirmed(`قبض ${money(v)} من ${L.customers.find(x=>x.id===id).name}؟ يزيد الصندوق وينقص الدين العام دون توزيع على قيد مخصوص.`);
      const event=safeUuid();await once(s,'تحصيل نقدي','rfq_pilot_collect_debt',event,{
        p_shift:s.shift,p_device:s.device,p_event:event,p_customer:id,p_amount_cents:v});
      if(!current(s))return;e.target.reset();note('أكد الخادم التحصيل وزيادة الصندوق.');await refresh();});};
    $('cloudOwnerDebtForm').onsubmit=e=>{e.preventDefault();run(async()=>{const s=session();
      if(!writable(s,true))throw Error('المالك فقط');const id=selectedCustomer(),v=amount($('cloudOwnerDebtAmount').value),
        reason=$('cloudOwnerDebtReason').value.trim();if(reason.length<3||reason.length>200)throw Error('دوّن سبب الدين اليدوي');
      confirmed(`دين يدوي ${money(v)} على ${L.customers.find(x=>x.id===id).name}، دون بضاعة أو صرف نقد؟`);
      const event=safeUuid();await once(s,'دين يدوي','rfq_pilot_owner_add_debt',event,{
        p_store:s.store,p_customer:id,p_event:event,p_amount_cents:v,p_reason:reason});
      if(!current(s))return;e.target.reset();note('دين يدوي؛ لا حركة صندوق ولا مخزون.');await refresh();});};
    $('cloudAdvanceForm').onsubmit=e=>{e.preventDefault();run(async()=>{const s=session();
      if(!writable(s,true))throw Error('المالك فقط؛ العامل لا يصرف سلفة وحده');
      const id=selectedCustomer(),sid=$('cloudAdvanceShift').value;
      if(!uuid(sid))throw Error('اختر وردية مفتوحة');const v=amount($('cloudAdvanceAmount').value),
        reason=$('cloudAdvanceReason').value.trim();if(reason.length<3||reason.length>200)throw Error('دوّن سبب السلفة');
      const snap=await s.api.rpc('rfq_pilot_shift_cash_snapshot',{p_shift:sid,p_device:null});
      if(!current(s)||snap.status!=='open'||snap.expected_cents<v)throw Error('وردية مغلقة أو نقد غير كافٍ؛ لا تصرف');
      confirmed(`سلفة نقدية حقيقية ${money(v)} إلى ${L.customers.find(x=>x.id===id).name} من درج ${sid.slice(0,8)}؟ ينقص الصندوق ويزيد الدين بلا فاتورة أو مخزون.`);
      const event=safeUuid(),result=await once(s,'سلفة نقدية','rfq_pilot_cash_advance',event,{
        p_shift:sid,p_event:event,p_customer:id,p_amount_cents:v,p_reason:reason});
      if(!current(s))return;e.target.reset();note(`أكد الخادم السلفة: الدرج ${money(result.till_cents)} • دين الزبون ${money(result.customer_balance_cents)}.`);await refresh();});};}
  function bindCash(){bindSound('cloudOwnerSound');$('cloudCashShift').onchange=()=>run(refresh);
    $('cloudCashAdjustForm').onsubmit=e=>{e.preventDefault();run(async()=>{const s=session();
      if(!writable(s,true))throw Error('حركة الصندوق للمالك فقط');
      const sid=$('cloudCashShift').value,kind=$('cloudCashKind').value;
      if(!uuid(sid)||!['income','expense','withdraw'].includes(kind))throw Error('اختر الوردية ونوع الحركة');
      const v=amount($('cloudCashAmount').value),reason=$('cloudCashReason').value.trim();
      if(reason.length<3||reason.length>200)throw Error('سبب الحركة مطلوب');
      confirmed(`${kind==='income'?'إضافة':'صرف'} ${money(v)} في صندوق الوردية ${sid.slice(0,8)}؟`);
      const event=safeUuid();await once(s,'حركة صندوق','rfq_pilot_owner_cash_adjust',event,{
        p_shift:sid,p_event:event,p_kind:kind,p_amount_cents:v,p_reason:reason});
      if(!current(s))return;e.target.reset();note('أقر الخادم حركة الصندوق.');await refresh();});};}
  function bindDashboard(){bindSound('cloudOwnerSound');$('cloudDashboardRefresh').onclick=()=>run(refresh);
    $('cloudProductForm').onsubmit=e=>{e.preventDefault();run(async()=>{const s=session();
      if(!writable(s,true))throw Error('المالك فقط');
      const name=$('cloudProductName').value.trim(),barcode=$('cloudProductBarcode').value.trim(),
        price=amount($('cloudProductPrice').value,true),cost=amount($('cloudProductCost').value,true);
      if(name.length<1||name.length>120||barcode.length>80||price>1000000000||cost>1000000000)
        throw Error('اسم الصنف أو سعره غير صالح؛ الحد التجريبي للسعر عشرة ملايين ريال');
      confirmed(`صنف ${name} بسعر ${money(price)} ورصيد صفر في المتجر الخادمي؟`);
      const event=safeUuid();await once(s,'صنف جديد','rfq_pilot_create_product_once',event,{
        p_store:s.store,p_id:event,p_name:name,p_barcode:barcode,p_unit:'حبة',
        p_price_cents:price,p_cost_cents:cost});
      if(!current(s))return;e.target.reset();note('صنف جديد برصيد صفر؛ أضف المخزون بحركة مستقلة موثقة.');await refresh();});};
    $('cloudStockForm').onsubmit=e=>{e.preventDefault();run(async()=>{const s=session();
      if(!writable(s,true))throw Error('المالك فقط');const product=$('cloudStockProduct').value;
      if(!uuid(product))throw Error('اختر صنفاً خادمياً');
      const count=qty($('cloudStockQty').value),reason=$('cloudStockReason').value.trim();
      if(reason.length<3||reason.length>200)throw Error('سبب حركة المخزون مطلوب');
      confirmed(`إضافة ${count/1000} إلى مخزون الخادم؟ لا يغير رصيد Room.`);
      const event=safeUuid();await once(s,'مخزون صنف','rfq_pilot_adjust_stock',event,{
        p_store:s.store,p_product:product,p_event:event,p_delta_milli:count,p_reason:reason});
      if(!current(s))return;e.target.reset();note('أكد الخادم زيادة رصيد الصنف.');await refresh();});};}
  function bindEye(){bindSound('cloudEyeSound');$('cloudEyeRefresh').onclick=()=>run(refresh);}
  function mount(kind){const ids={cash:'cloudCashLedger',pos:'cloudPos',customers:'cloudCustomers',
    dashboard:'cloudDashboard',eye:'cloudEye'};const panel=$(ids[kind]);if(!panel)return;
    L.nav++;L.kind=kind;L.panel=panel;L.loading=false;L.queued=false;L.busy=false;L.ready=false;
    if(kind==='pos')bindPos();else {root.rafiqVoicePos=null;if(kind==='customers')bindCustomers();
      else if(kind==='cash')bindCash();else if(kind==='dashboard')bindDashboard();else if(kind==='eye')bindEye();}
    root.addEventListener('rafiq:cloud-shift',()=>{if(panel.isConnected&&L.panel===panel)refresh();});
    root.setInterval(()=>{if(panel.isConnected&&root.document.visibilityState==='visible'&&root.navigator.onLine)
      refresh();},kind==='eye'?15000:25000);
    refresh();}
  root.RafiqCloudLedger={mount,refresh,amount,qty};
})(window);
