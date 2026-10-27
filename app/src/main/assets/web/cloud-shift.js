/* Cloud shift on the ORIGINAL cash screen. No Pilot window, Room writes, sale, or secrets.
 * Supabase Auth tokens live in JS memory only and are cleared on local account switch.
 * All real authority is the signed-in server RPC; local PIN is never a cloud role.
 */
(function (root) {
  'use strict';
  const $ = id => root.document.getElementById(id);
  const uuid = s => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(s || ''));
  const rpcNames = new Set(['rfq_pilot_request_device', 'rfq_pilot_approve_device',
    'rfq_pilot_claim_worker', 'rfq_pilot_request_shift', 'rfq_pilot_approve_shift',
    'rfq_pilot_my_open_shift', 'rfq_pilot_reject_shift', 'rfq_pilot_close_shift',
    'rfq_pilot_heartbeat', 'rfq_pilot_post_invoice_checked', 'rfq_pilot_create_customer',
    'rfq_pilot_collect_debt', 'rfq_pilot_owner_add_debt', 'rfq_pilot_owner_cash_adjust',
    'rfq_pilot_cash_advance', 'rfq_pilot_shift_cash_snapshot',
    'rfq_pilot_customer_statement', 'rfq_pilot_customer_overview',
    'rfq_pilot_owner_summary', 'rfq_pilot_create_product_once', 'rfq_pilot_adjust_stock']);
  const tableNames = new Set(['rfq_pilot_members', 'rfq_pilot_devices',
    'rfq_pilot_shift_requests', 'rfq_pilot_shifts', 'rfq_pilot_stores',
    'rfq_pilot_products', 'rfq_pilot_customers', 'rfq_pilot_invoices',
    'rfq_pilot_owner_events']);
  const state = {api:null, user:null, store:null, role:null, device:null, localUid:null,
    approved:false,shift:null,ownerShifts:[],
    busy:false, loading:false, reloadRequested:false, uncertain:false, epoch:0, version:0};
  function session() {return state.api && state.user ? {api:state.api,userId:state.user.id,
    store:state.store,role:state.role,device:state.device,localUid:state.localUid,
    approved:state.approved,shift:state.shift,ownerShifts:state.ownerShifts.slice(),epoch:state.epoch}:null;}
  function notify(){root.dispatchEvent(new root.Event('rafiq:cloud-shift'));}

  function amountCents(value) {
    const raw = String(value ?? '').trim().replace(/[٠-٩]/g, d => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
      .replace(/[۰-۹]/g, d => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d))).replace(/٫/g, '.');
    if (!/^(?:\d+|\d{1,3}(?:[,٬]\d{3})+)(?:\.\d{1,2})?$/.test(raw)) {
      throw Error('اكتب مبلغاً صحيحاً بالريال؛ لا يُحوَّل الإدخال الفارغ أو غير الصالح إلى صفر');
    }
    const s=raw.replace(/[,٬]/g,'');
    if(!/^\d{1,9}(?:\.\d{1,2})?$/.test(s))throw Error('المبلغ أكبر من الحد التجريبي المسموح');
    const [whole, fraction=''] = s.split('.');
    return Number(whole)*100 + Number(fraction.padEnd(2, '0'));
  }
  function formatCents(n) { return new Intl.NumberFormat('ar-YE', {maximumFractionDigits:2}).format(Number(n || 0)/100) + ' ريال'; }
  function node(tag,text,cls) { const e=root.document.createElement(tag); if(text!=null)e.textContent=String(text);
    if(cls)e.className=cls;return e; }
  function message(text,error=false) { const box=$('serverShiftMessage'); if(!box)return;
    box.textContent=String(text);box.className='flash '+(error?'error':'ok');box.hidden=false; }
  function cloudConfig() {
    if (!root.RafiqNative?.cloudShiftPublicConfig) throw Error('هذه الشاشة تحتاج تطبيق Android الأصلي');
    let data;try{data=JSON.parse(root.RafiqNative.cloudShiftPublicConfig());}catch{throw Error('تعذر قراءة إعداد المتجر');}
    if(data?.error)throw Error(data.error);
    const u=String(data?.url||''), k=String(data?.key||'');
    if(!/^https:\/\/[a-z0-9][a-z0-9-]{4,61}[a-z0-9]\.supabase\.co$/i.test(u) ||
       (!/^sb_publishable_[A-Za-z0-9_-]{20,512}$/.test(k) &&
        !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(k)))
      throw Error('إعداد الخادم العام غير صالح؛ راجع التهيئة على هذا الهاتف');
    return {url:u,key:k};
  }
  function deviceId(userId) {
    const key='rafiq-test-device:v2:android:'+userId; // نفس UUID التجربة السابق على هذا الهاتف إن توفر.
    const saved=root.localStorage.getItem(key);
    if(uuid(saved))return saved;
    if(!root.crypto?.getRandomValues)throw Error('تعذر إنشاء معرّف آمن للجهاز؛ لا تطلب وردية');
    const id=root.crypto.randomUUID?root.crypto.randomUUID():(()=>{
      const b=new Uint8Array(16);root.crypto.getRandomValues(b);b[6]=(b[6]&15)|64;b[8]=(b[8]&63)|128;
      const h=Array.from(b, x=>x.toString(16).padStart(2,'0')).join('');
      return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
    })();
    root.localStorage.setItem(key,id);return id;
  }
  class CloudApi {
    constructor(config) {this.url=config.url;this.key=config.key;this.access='';this.refreshToken='';this.expiresAt=0;this.refreshing=null;this.generation=0;}
    clear(){this.generation++;this.access='';this.refreshToken='';this.expiresAt=0;this.refreshing=null;}
    async send(path,{method='GET',body=null,token=''}={}) {
      const headers={'apikey':this.key,'Accept':'application/json'};
      if(body!==null)headers['Content-Type']='application/json';
      if(token)headers.Authorization='Bearer '+token;
      const controller=new AbortController(); const timer=root.setTimeout(()=>controller.abort(),12000);
      try{
        // Receiver must be Window in Android WebView; never cache fetch as an unbound method.
        const response=await root.fetch(this.url+path,{method,headers,body:body===null?undefined:JSON.stringify(body),
          credentials:'omit',redirect:'error',referrerPolicy:'no-referrer',cache:'no-store',signal:controller.signal});
        const raw=await response.text();let data;try{data=raw?JSON.parse(raw):null;}catch{data=null;}
        if(!response.ok){const serverMessage=String(data?.message||data?.error_description||data?.error||`HTTP ${response.status}`).slice(0,160);
          const error=Error(serverMessage);error.sqlState=String(data?.code||'');
          // Only these transactional business refusals of the FIRST attempt prove
          // no ledger entry was posted. A timeout, parse failure, 409, or UUID
          // conflict is never permission to discard a saved financial intent.
          error.definiteNoCommit=error.sqlState==='P0001'&&new Set([
            'price_changed_refresh_cart','insufficient_stock','invalid_invoice_quote',
            'invalid_payment','invalid_credit_customer','customer_not_found',
            'collection_exceeds_debt','insufficient_till_cash','invalid_cash_advance',
            'invalid_collection'
          ]).has(serverMessage);
          throw error;}
        return data;
      }finally{root.clearTimeout(timer);}
    }
    async signIn(email,password) {
      const generation=this.generation;
      const result=await this.send('/auth/v1/token?grant_type=password',{method:'POST',body:{email:String(email).trim(),password:String(password)}});
      if(generation!==this.generation)throw Error('أُغلقت الجلسة قبل اكتمال الدخول');
      if(!uuid(result?.user?.id)||!result?.access_token||!result?.refresh_token)throw Error('دخول غير مكتمل');
      this.access=result.access_token;this.refreshToken=result.refresh_token;
      this.expiresAt=Date.now()+(Number(result.expires_in)||3600)*1000;
      return result.user;
    }
    async renew() {
      if(!this.refreshToken)throw Error('انتهت الجلسة؛ سجّل الدخول مجدداً');
      if(this.refreshing)return this.refreshing;
      const generation=this.generation;
      this.refreshing=(async()=>{const r=await this.send('/auth/v1/token?grant_type=refresh_token',{
        method:'POST',body:{refresh_token:this.refreshToken}});
        if(generation!==this.generation)throw Error('أُغلقت الجلسة');
        if(!r?.access_token||!r?.refresh_token)throw Error('تعذر تجديد الجلسة');
        this.access=r.access_token;this.refreshToken=r.refresh_token;
        this.expiresAt=Date.now()+(Number(r.expires_in)||3600)*1000;})();
      try{await this.refreshing;}catch(e){this.clear();throw e;}finally{this.refreshing=null;}
    }
    async rest(path,method='GET',body=null) {
      if(!this.access)throw Error('سجّل دخول المتجر على هذه الشاشة أولاً');
      const generation=this.generation;
      if(Date.now()+30000>=this.expiresAt)await this.renew();
      if(generation!==this.generation||!this.access)throw Error('أُغلقت الجلسة؛ سجّل الدخول مجدداً');
      return this.send('/rest/v1/'+path,{method,body,token:this.access});
    }
    rpc(name,args) {if(!rpcNames.has(name))throw Error('إجراء غير مسموح');return this.rest('rpc/'+name,'POST',args);}
    table(name,params) {if(!tableNames.has(name))throw Error('جدول غير مسموح');
      return this.rest(name+'?'+new URLSearchParams(params).toString());}
    async signOut() {const token=this.access;this.clear();
      if(token)await this.send('/auth/v1/logout',{method:'POST',body:{},token});}
  }
  function clear() {
    state.api?.clear();state.api=null;state.user=null;state.store=null;state.role=null;state.device=null;
    state.approved=false;state.shift=null;state.ownerShifts=[];
    state.busy=false;state.loading=false;state.reloadRequested=false;state.uncertain=false;
    state.epoch++;state.version++;notify();
  }
  function localLogout() {
    const api=state.api;
    if(api)api.signOut().catch(()=>{/* تُمسح رموز الهاتف حتى لو تعذر الخروج الشبكي. */});
    clear();
  }
  function bindButton(button, action) {button.type='button';button.onclick=()=>{
    if(state.uncertain){message('تحقق من حالة الخادم بالتحديث أولاً قبل إعادة أي قرار غير مؤكد.',true);return;}
    return run(action,true);};return button;}
  async function run(action, write=false) {
    if(state.busy)return;state.busy=true;if(write)state.version++;
    const box=$('serverShift');if(box)box.classList.add('rfq-pending');
    try{await action();}catch(e){const network=e?.name==='AbortError'||e?.name==='TypeError';
      if(write&&network)state.uncertain=true;
      message(network?
      'نتيجة الطلب غير مؤكدة بسبب الاتصال بالشبكة. حدّث حالة الخادم قبل تكرار العملية؛ لا تفتح وردية محلية.':
      (e?.message||'تعذر الاتصال بالخادم'),true);
    }finally{state.busy=false;if(box)box.classList.remove('rfq-pending');}
  }
  async function signIn() {
    const email=$('serverShiftEmail').value.trim(), pass=$('serverShiftPassword').value;
    if(!email||!pass)throw Error('أدخل بريد حساب المتجر وكلمة مروره على هاتفك');
    const api=state.api||new CloudApi(cloudConfig()), panel=$('serverShift'), epoch=state.epoch;
    const stillHere=()=>epoch===state.epoch&&panel?.isConnected&&$('serverShift')===panel;
    try{
      const user=await api.signIn(email,pass);
      if(!stillHere()){api.clear();return;}
      $('serverShiftPassword').value='';
      const rows=await api.table('rfq_pilot_members',{user_id:'eq.'+user.id,active:'eq.true',select:'store_id,role',limit:'2'});
      if(!stillHere()){api.clear();return;}
      const localRole=panel.dataset.localRole;
      if(rows?.length!==1||rows[0].role!==localRole||!uuid(rows[0].store_id))
        throw Error('دور الحساب السحابي لا يطابق دور الدخول المحلي، أو عضويته غير مؤكدة');
      const id=deviceId(user.id);
      state.api=api;state.user=user;state.store=rows[0].store_id;state.role=rows[0].role;state.device=id;
      $('serverShiftLogin').hidden=true;$('serverShiftSession').hidden=false;
      $('serverShiftIdentity').textContent=`${user.email||email} • ${state.role==='owner'?'مالك':'عامل'} • الحساب الخادمي`;
      const status=await api.rpc('rfq_pilot_request_device',{
        p_store:state.store,p_device:id,p_kind:state.role==='owner'?'owner_phone':'cashier_phone'});
      if(!stillHere()){api.clear();return;}
      message(status==='approved'?'الجهاز معتمد. جارٍ التحقق من الوردية...':'أُرسل طلب اعتماد الجهاز؛ لا تُستخدم الوردية المحلية.');
      await refresh();
    }catch(e){api.clear();if(!stillHere())return;
      $('serverShiftPassword').value='';clear();
      $('serverShiftLogin').hidden=false;$('serverShiftSession').hidden=true;throw e;}
  }
  async function refresh() {
    const panel=$('serverShift');if(!panel?.isConnected||!state.api)return;
    if(state.loading){state.reloadRequested=true;return;}
    const epoch=state.epoch, version=state.version;
    const onScreen=()=>epoch===state.epoch&&panel.isConnected&&$('serverShift')===panel;
    const stillHere=()=>onScreen()&&version===state.version;
    state.loading=true;
    try{
      const devices=await state.api.table('rfq_pilot_devices',{
        store_id:'eq.'+state.store,id:'eq.'+state.device,select:'id,status',limit:'1'});
      if(!stillHere())return;
      const approved=devices?.[0]?.status==='approved';
      state.approved=approved;state.shift=null;state.ownerShifts=[];notify();
      const body=$('serverShiftBody');body.replaceChildren();
      body.append(node('p',`الجهاز: ${approved?'معتمد':devices?.[0]?.status||'بانتظار الاعتماد'} • المعرّف: ${state.device}`,'small muted rfq-device-id'));
      if(state.role==='worker'){
        if(!approved){body.append(node('p','انتظر موافقة المالك على الجهاز، ثم حدّث هذه الشاشة.','flash error'));state.uncertain=false;return;}
        try{await state.api.rpc('rfq_pilot_claim_worker',{p_store:state.store,p_device:state.device});}
        catch(e){if(stillHere())body.append(node('p','جلسة العامل غير متاحة: '+e.message,'flash error'));return;}
        if(!stillHere())return;
        const [shift,requests]=await Promise.all([
          state.api.rpc('rfq_pilot_my_open_shift',{p_store:state.store,p_device:state.device}),
          state.api.table('rfq_pilot_shift_requests',{
            store_id:'eq.'+state.store,worker_id:'eq.'+state.user.id,select:'id,status,created_at',order:'created_at.desc',limit:'3'})]);
        if(!stillHere())return;
        state.uncertain=false;
        state.shift=shift||null;notify();
        if(shift){body.append(node('p','وردية معتمدة من الخادم — رقم '+String(shift).slice(0,8),'flash ok'));
          body.append(node('p','يمكن تجربة البيع الوهمي على الشاشة الأصلية من دفتر المتجر الخادمي فقط.','muted'));}
        else{
          body.append(node('p','لا توجد وردية خادمية معتمدة، حتى لو ظهرت وردية محلية في الأرشيف.','flash error'));
          if(!requests.some(r=>r.status==='pending')){
            const req=bindButton(node('button','اطلب فتح وردية من المالك','btn p'),async()=>{
              await state.api.rpc('rfq_pilot_request_shift',{p_store:state.store,p_device:state.device});
              message('أُرسل طلب الوردية للخادم؛ انتظر قرار المالك.');await refresh();});
            body.append(req);
          }
        }
        for(const r of requests)body.append(node('p',`الطلب ${String(r.id).slice(0,8)}: ${r.status==='approved'?'قُبل سابقاً':r.status==='pending'?'بانتظار المالك':r.status==='rejected'?'رفضه المالك':'ملغى'}`,'small'));
      }else{
        const [pendingDevices,requests,shifts]=await Promise.all([
          state.api.table('rfq_pilot_devices',{store_id:'eq.'+state.store,status:'eq.pending',select:'id,user_id,kind,created_at',order:'created_at.desc'}),
          state.api.table('rfq_pilot_shift_requests',{store_id:'eq.'+state.store,status:'eq.pending',select:'id,worker_id,cashier_device_id,created_at',order:'created_at.desc'}),
          state.api.table('rfq_pilot_shifts',{store_id:'eq.'+state.store,status:'eq.open',select:'id,worker_id,opening_cents,opened_at',order:'opened_at.desc'})]);
        if(!stillHere())return;
        state.uncertain=false;state.ownerShifts=shifts;notify();
        for(const d of pendingDevices){const row=node('div',null,'card tight');
          row.append(node('p',`جهاز ينتظر الموافقة: ${d.kind} • المستخدم ${d.user_id} • الجهاز ${d.id}`,'rfq-device-id'));
          row.append(bindButton(node('button','اعتماد الجهاز بعد التحقق من هاتف العامل','btn sm'),async()=>{
            await state.api.rpc('rfq_pilot_approve_device',{p_store:state.store,p_device:d.id});
            message('اعتمد الخادم الجهاز.');await refresh();}));body.append(row);}
        for(const r of requests){const row=node('div',null,'card tight');
          row.append(node('p',`طلب وردية من العامل ${String(r.worker_id).slice(0,8)} • جهاز ${r.cashier_device_id}`,'rfq-device-id'));
          const label=node('label','عهدة الافتتاح بالريال اليمني (تجربة فقط)');
          const amount=node('input');amount.type='text';amount.inputMode='decimal';amount.autocomplete='off';amount.placeholder='اكتب مبلغًا قبل الموافقة';
          label.append(amount);row.append(label);
          row.append(bindButton(node('button','تأكيد وفتح وردية على الخادم','btn p'),async()=>{
            const cents=amountCents(amount.value);
            await state.api.rpc('rfq_pilot_approve_shift',{p_request:r.id,p_opening_cents:cents});
            message('وافَق الخادم على الوردية؛ حدّث هاتف العامل.');await refresh();}));
          row.append(bindButton(node('button','رفض الطلب — لا تُفتح وردية','btn ghost'),async()=>{
            await state.api.rpc('rfq_pilot_reject_shift',{p_request:r.id});
            message('سُجل رفض المالك على الخادم؛ سيراه العامل عند التحديث.');await refresh();}));
          body.append(row);}
        for(const s of shifts){const row=node('div',null,'card tight');
          row.append(node('p',`وردية خادمية مفتوحة: العامل ${String(s.worker_id).slice(0,8)} • العهدة ${formatCents(s.opening_cents)}`,'flash ok'));
          const label=node('label','المبلغ المعدود فعلياً بالريال اليمني قبل إغلاق الوردية الخادمية');
          const counted=node('input');counted.type='text';counted.inputMode='decimal';counted.autocomplete='off';
          counted.placeholder='اكتب النقد المعدود؛ لا تستخدم الرصيد المحلي';label.append(counted);row.append(label);
          row.append(bindButton(node('button','تأكيد إغلاق الوردية على الخادم','btn amber'),async()=>{
            const cents=amountCents(counted.value);
            const report=await state.api.rpc('rfq_pilot_close_shift',{p_shift:s.id,p_counted_cents:cents});
            message(`أُغلقت وردية الخادم. المتوقع ${formatCents(report.expected_cents)}، المعدود ${formatCents(report.counted_cents)}، الفارق ${formatCents(report.difference_cents)}. لا يشمل أرشيف هذا الهاتف.`);
            await refresh();}));body.append(row);}

        if(!requests.length&&!shifts.length&&!pendingDevices.length)body.append(node('p','لا طلبات أو ورديات خادمية ظاهرة.','muted'));
      }
    }finally{state.loading=false;
      if(onScreen()&&state.reloadRequested){state.reloadRequested=false;
        refresh().catch(e=>message(e.message||'تعذر تحديث حالة الخادم',true));}}
  }
  function mount() {
    const panel=$('serverShift');if(!panel)return;
    const uid=panel.dataset.localUid, role=panel.dataset.localRole;
    if(!uid||!['owner','worker'].includes(role))return;
    if(state.localUid!==uid){clear();state.localUid=uid;}
    const login=$('serverShiftLogin'),session=$('serverShiftSession');
    login.hidden=!!state.api;session.hidden=!state.api;
    $('serverShiftSignIn').onclick=()=>run(signIn);
    $('serverShiftRefresh').onclick=()=>run(refresh);
    $('serverShiftSignOut').onclick=()=>run(async()=>{
      const api=state.api;let serverConfirmed=true;
      try{await api?.signOut();}catch{serverConfirmed=false;}
      clear();if(!login.isConnected)return;
      login.hidden=false;session.hidden=true;$('serverShiftBody').replaceChildren();
      $('serverShiftPassword').value='';
      message(serverConfirmed?'خرجت من الحساب الخادمي على الهاتف والخادم.':
        'أُغلقت جلسة هذا الهاتف؛ تعذّر تأكيد خروجها من الخادم. لا تترك الهاتف بيد غيرك، وأعد تسجيل الدخول للتحقق من الجهاز.',!serverConfirmed);});
    try{cloudConfig();}catch(e){message(e.message,true);$('serverShiftSignIn').disabled=true;return;}
    if(state.api){message('هذه حالة الخادم، والأرقام المحلية أدناه محفوظة للعرض فقط.');run(refresh);}
    else message('سجّل دخول حساب المتجر هنا لطلب وردية خادمية؛ لا تُستخدم الوردية المحلية.');
    // engine.js cleans up page timers when leaving /cash; mounting again creates one new timer.
    root.setInterval(()=>{if(panel.isConnected&&state.api&&!state.busy)
      refresh().catch(e=>message(e.message,true));},30000);
  }
  root.RafiqCloudShift={mount,clear,localLogout,session,refresh,amountCents,formatCents,CloudApi};
})(window);
