import {PilotApi,projectUrl,publicKey,moneyCents,qtyMilli,cartTotal,LocalStore,deviceCodeFrom,verifyActivationCode,activationUntil,sha256Bytes,bytesHex,validatePurchaseDraft,parseOcrLine} from './lib.mjs';

const $=id=>document.getElementById(id);
const embedded=location.hostname==='appassets.androidplatform.net';
try{if(localStorage.getItem('rafiq-theme')==='dark')document.body.classList.add('dark');}catch{}
const state={api:null,user:null,store:null,role:null,device:null,approved:false,lease:false,sellerMode:false,
  shift:null,view:'home',cart:[],pending:null,saleSubmitting:false,msgPrefs:{},msgSettings:null,voiceApproved:false,smsPumping:false,products:[],customers:[],invoice:null,storeName:'متجر اختبار',offlineNow:false,readOnly:false,localShift:null,mode:null};
const cents=n=>`${new Intl.NumberFormat('ar-YE',{maximumFractionDigits:2}).format(Number(n||0)/100)} ريال`;
const stamp=iso=>iso?new Intl.DateTimeFormat('ar-YE',{dateStyle:'short',timeStyle:'short'}).format(new Date(iso)):'';

// ===== 6أ: محرك المزامنة دون اتصال (طابور خارج + مرآة داخل + مراس خادم) =====
function bridge(){return window.NativeApi||null;}
// ===== حزمة الإطلاق: التفعيل + وضع الدخول + العمل المحلي (بدون إنترنت) =====
// المفاتيح تحمل بادئة `rafiq-test-device:v2:android:` لأنها البادئة الوحيدة الناجية من تنظيف التحديث.
function kvGet(k){try{return localStorage.getItem(k);}catch{return null;}}
function kvSet(k,v){try{localStorage.setItem(k,String(v));}catch{}}
function netReady(){return state.mode==='offline'||navigator.onLine;}
function launchDeviceId(){
  let id=kvGet('rafiq-test-device:v2:android:launch-device');
  if(!/^[0-9a-f-]{8}-/i.test(id||'')){id=(globalThis.crypto&&crypto.randomUUID)?crypto.randomUUID():('l-'+Date.now()+'-'+Math.random().toString(16).slice(2));kvSet('rafiq-test-device:v2:android:launch-device',id);}
  return id;
}
function launchActivation(){try{return JSON.parse(kvGet('rafiq-test-device:v2:android:launch-act')||'null');}catch{return null;}}
function launchExpired(a){return !!(a&&a.until&&!(new Date(a.until)>new Date()));}
function launchActivated(){const a=launchActivation();return !!(a&&!launchExpired(a));}
function saveActivation(a){kvSet('rafiq-test-device:v2:android:launch-act',JSON.stringify(a));}
function localAccount(){try{return JSON.parse(kvGet('rafiq-test-device:v2:android:local-account')||'null');}catch{return null;}}
function pinHash(pin,salt){return bytesHex(sha256Bytes('rafiq-pin|'+salt+'|'+pin));}
function makeLocalApi(){
  const store=new LocalStore({get:kvGet,set:kvSet});
  return {signedIn:true,url:'',key:'',access:'local',refreshToken:'',expiresAt:0,sessionUser:{id:'local-owner'},
    lastServerDate:new Date().toISOString(),
    async rpc(name,args={}){return store.rpc(name,args);},
    async table(name,q={}){return store.table(name,q);},
    clear(){}};
}
// تحديث التطبيق نفسه فوق المثبّت: قبل أي مصادقة أو طلب شبكة، نظّف عمليات
// التجربة القديمة في Room ثم نيّات WebView. احتفظ بمعرّف الجهاز المعتمد
// وربط الخادم المشفّر؛ لا أرشيف ثانياً ولا نسخ صامت للعمليات الوهمية.
function prepareExistingAppUpgrade(){
  if(!embedded)return;
  try{
    const b=bridge();
    if(!b||typeof b.beginPilotDemoReset!=='function'||typeof b.finishPilotDemoReset!=='function')
      throw Error('native_reset_missing');
    const started=JSON.parse(b.beginPilotDemoReset()||'{}');
    if(!started.ok)throw Error('room_reset_failed');
    if(started.clear_web){
      sessionStorage.clear();
      const keys=Array.from({length:localStorage.length},(_,i)=>localStorage.key(i));
      for(const key of keys){
        if(key&&!key.startsWith('rafiq-test-device:v2:android:'))localStorage.removeItem(key);
      }
    }
    const finished=JSON.parse(b.finishPilotDemoReset()||'{}');
    if(!finished.ok)throw Error('reset_marker_not_saved');
  }catch(e){
    const message=$('message');
    if(message){message.hidden=false;message.className='flash error';
      message.textContent='تعذّر تنظيف بيانات التجربة على هذا الهاتف؛ البيع والمزامنة متوقفان حتى إصلاح التحديث.';}
    for(const button of document.querySelectorAll('button'))button.disabled=true;
    throw Error('pilot_reset_required_before_network'); // أوقف تشغيل الواجهة قبل أي RPC
  }
}
prepareExistingAppUpgrade();
function queuedOps(b){
  // قائمة المعلّقة الكاملة (بلا حد العرض 100) إن وفّرها الجسر، وإلا من قائمة العرض.
  try{if(b.ofxQueued)return JSON.parse(b.ofxQueued()||'[]');}catch{}
  return JSON.parse(b.ofxList()||'[]').filter(o=>o.status==='queued');
}
function ofxQueue(kind,payload,id){
  const b=bridge();if(!b)throw Error('الحفظ المحلي متاح داخل تطبيق الهاتف فقط');
  // لا سقف على عدد العمليات المعلقة قبل موافقة المالك — التخزين محلي وصغير، ولا تُفقد عملية.
  const opId=id||crypto.randomUUID();
  const stored={_store:state.store,...payload}; // وسم المتجر: لا خلط بين متجرين أبدًا
  const text=JSON.stringify(stored);
  b.ofxAdd(JSON.stringify({id:opId,kind,payload:text,queuedAt:new Date().toISOString(),anchor:state.api?.lastServerDate||''}));
  // لا يُعرض «حُفظ» إلا بعد التأكد أن العملية نفسها (بحمولتها وحالتها) كُتبت فعلًا في قاعدة الهاتف.
  const rec=queuedOps(b).find(x=>x.id===opId);
  if(!rec||rec.status!=='queued'||rec.payload!==text)throw Error('تعذر حفظ العملية على الهاتف — لم يكتمل التسجيل، أعد المحاولة');
  return opId;
}
// فواتير Pilot لا تُرسل لمسار البيع القديم: اللقطة المحفوظة تُحوَّل لطلب
// السعر المحمي نفسه في كل إعادة، ولا تُعتبر مدخلاً موثوقًا للسعر عند الخادم.
function guardedInvoiceArgs(p){
  if(!p||typeof p!=='object'||!Array.isArray(p.p_lines)||
     !Array.isArray(p._snapshot)||p.p_lines.length<1||
     p.p_lines.length!==p._snapshot.length)
    throw Error('فاتورة قديمة بلا لقطة أسعار محفوظة؛ لا تُرسل تلقائيًا، راجع المالك');
  const snapshot=new Map();
  for(const s of p._snapshot){
    if(!s||typeof s.product_id!=='string'||snapshot.has(s.product_id)||
       !Number.isSafeInteger(s.qty_milli)||s.qty_milli<1||s.qty_milli>1000000||
       !Number.isSafeInteger(s.price_cents)||s.price_cents<0||s.price_cents>1000000000||
       typeof s.name!=='string'||!s.name.trim()||s.name.length>120)
      throw Error('لقطة فاتورة غير صالحة؛ أوقف الإرسال وراجع المالك');
    snapshot.set(s.product_id,s);
  }
  const seen=new Set();
  const lines=p.p_lines.map(l=>{
    const s=snapshot.get(l?.product_id);
    if(!s||seen.has(l.product_id)||l.qty_milli!==s.qty_milli)
      throw Error('تختلف حمولة الفاتورة عن لقطة الهاتف؛ لا تُرسل تلقائيًا');
    seen.add(l.product_id);
    return {product_id:l.product_id,qty_milli:l.qty_milli,
      expected_price_cents:s.price_cents,expected_name:s.name};
  });
  const args=Object.fromEntries(Object.entries(p).filter(([key])=>!key.startsWith('_')));
  return {...args,p_lines:lines};
}
function invoiceLinesAgree(snapshot,lines,invoiceId){
  if(!Array.isArray(snapshot)||!Array.isArray(lines)||
     !snapshot.length||lines.length!==snapshot.length)return false;
  const byId=new Map(lines.map(x=>[x.product_id,x]));
  return byId.size===lines.length&&new Set(snapshot.map(x=>x.product_id)).size===lines.length&&
    snapshot.every(local=>{const remote=byId.get(local.product_id);
      return remote&&remote.invoice_id===invoiceId&&remote.name_snapshot===local.name&&
        Number.isSafeInteger(remote.price_cents)&&Number.isSafeInteger(remote.qty_milli)&&
        remote.price_cents===local.price_cents&&remote.qty_milli===local.qty_milli;
    });
}
function provisionalBadge(status){
  if(status==='queued')return 'بانتظار المزامنة — مستند مؤقت حتى إقرار الخادم';
  if(status==='sent_awaiting_owner')return 'وصل طلب الوردية للخادم — بانتظار موافقة المالك (ليست مفعّلة)';
  if(status==='conflict')return 'تعارض عند المزامنة — مراجعة المالك (لم يُعدَّل ولم يُحذف)';
  if(status==='cancelled_by_owner')return 'قرار مالك محلي بالإلغاء — بانتظار التوثيق على الخادم (لم يُوثَّق بعد)';
  return 'مؤكدة من الخادم';
}
state.suppliers=[];state.storeProfile=null;state.editingSupplier=null;state.supplierPhotoData='';state.storeLogoData='';
function storeTitle(){return state.storeProfile?.display_name||('رفيق — '+state.storeName);}
const OFX_RPC={shift_open:'rfq_pilot_request_shift',shift_close:'rfq_pilot_close_shift',invoice:'rfq_pilot_post_invoice_guarded',customer:'rfq_pilot_create_customer',owner_debt:'rfq_pilot_owner_add_debt',collection:'rfq_pilot_collect_debt_v2',owner_cash:'rfq_pilot_owner_cash_adjust',product:'rfq_pilot_save_product',stock_adjust:'rfq_pilot_adjust_stock'};
const readOnlyReplayMisses=new Set(); // في الذاكرة فقط؛ يُعاد الفحص بعد إعادة فتح التطبيق أو تجديد الترخيص
async function syncPush(){
  const b=bridge();if(!b||!state.api?.signedIn||!navigator.onLine)return;
  if(!state.readOnly)readOnlyReplayMisses.clear();
  const lsKey='local_shift:'+state.store;
  const mapKey=(id)=>'shift_map:'+state.store+':'+id;
  const listAll=JSON.parse(b.ofxList()||'[]');
  // أمر المالك (الجولة 7): الطلبات الأقدم من حد العرض 100 لا تتجمد — تُدمج قائمة المراجعة الكاملة
  // (ofxReview) في خريطة المحرك كما في الواجهة، مع عزل صارم لعمليات المتاجر في المصادر الثلاثة:
  // عملية بلا وسم متجر أو بمتجر آخر لا تُعالَج في هذه الجلسة إطلاقًا (لا ربط ولا رفض ولا استعلام).
  let reviewAll=[];try{if(b.ofxReview)reviewAll=JSON.parse(b.ofxReview()||'[]');}catch{}
  const queued=queuedOps(b);
  // مناعة عن ساعة الهاتف: ترتيب السلسلة (فتح ← عمليات ← إغلاق) أولًا، ثم التوقيت — انقلاب الساعة لا يقدم إغلاقًا على مبيعاته
  const RANK={shift_open:0,shift_close:2};
  queued.sort((x,y)=>(RANK[x.kind]??1)-(RANK[y.kind]??1)||String(x.queuedAt||'').localeCompare(String(y.queuedAt||'')));
  const byId=new Map([...listAll,...reviewAll,...queued].filter(sameStoreOp).map(x=>[x.id,x]));
  const opsAll=[...byId.values()];
  const isLocalShift=(id)=>opsAll.some(x=>x.kind==='shift_open'&&x.id==='shift_open:'+id);

  // 1) رفض المالك طلب الوردية المؤقتة: تعارض صريح للطلب ولكل عملياته — لا انتظار للأبد.
  for(const o of opsAll.filter(x=>x.kind==='shift_open'&&x.status==='sent_awaiting_owner'&&x.serverRef)){
    let st=null;
    try{const rr=await state.api.table('rfq_pilot_shift_requests',{id:`eq.${o.serverRef}`,select:'id,status',limit:'1'});st=rr&&rr[0]?rr[0].status:null;}catch{}
    if(st==='rejected'){
      b.ofxSettle(o.id,'conflict','','رفض المالك طلب الوردية — لم تُفعَّل؛ العمليات المرتبطة تحتاج قرار المالك');
      const localId=o.id.slice('shift_open:'.length);
      for(const x of queued){
        if(x.id===o.id)continue;
        try{const p=JSON.parse(x.payload);
          if(p.p_shift===localId)b.ofxSettle(x.id,'conflict','','وردية محلية رفض المالك طلبها — لم تُدفع؛ قرار المالك مطلوب (بديل موثق أو إلغاء بمستند)');
        }catch{}
      }
    }
  }

  // 2) ربط الوردية المحلية بوردية الخادم: بالدليل من طلبها نفسه (لا بأي وردية مفتوحة عرضًا).
  const ls=JSON.parse(b.metaGet(lsKey)||'null');
  if(ls&&!b.metaGet(mapKey(ls.id))){
    const so=byId.get('shift_open:'+ls.id);
    const reqRef=so?so.serverRef:'';
    let approved=null;let reqShift=''; // null = تعذر التحقق — لا ربط بلا دليل إطلاقًا
    if(reqRef){
      try{const rr=await state.api.table('rfq_pilot_shift_requests',{id:`eq.${reqRef}`,select:'id,status,shift_id',limit:'1'});
        if(rr&&rr[0]){approved=rr[0].status==='approved';reqShift=rr[0].shift_id!=null?String(rr[0].shift_id):'';}}
      catch(e){ // عمود shift_id قد لا يوجد بعد: قراءة ثنائية — دليل الموافقة يبقى من صف الطلب نفسه
        try{const rr=await state.api.table('rfq_pilot_shift_requests',{id:`eq.${reqRef}`,select:'id,status',limit:'1'});
          if(rr&&rr[0])approved=rr[0].status==='approved';}catch{}
      }
    }
    if(approved===true){
      // شرط المالك (الجولة 6): الربط فقط بدليل كامل من صف الطلب نفسه — عموده shift_id يطابق الوردية المفتوحة.
      // غياب shift_id (عمودًا أو قيمةً) = لا ربط بالموافقة وحدها أبدًا؛ يبقى البند معلّقًا ويُعاد التحقق كل مزامنة.
      try{
        const srv=await state.api.rpc('rfq_pilot_my_open_shift',{p_store:state.store,p_device:state.device});
        const sid=srv?(srv.id!=null?srv.id:srv):null; // تطبيع: الخادم قد يرجع كائنًا أو المعرف نصًا مباشرة
        if(sid&&reqRef&&reqShift&&reqShift===String(sid)){ // دليل الارتباط بالطلب نفسه: ورديته المسجلة في صفه
          b.metaSet(mapKey(ls.id),String(sid));
          b.metaSet('shift_req:'+state.store+':'+ls.id,String(reqRef));
          if(so&&so.status==='sent_awaiting_owner')b.ofxSettle(so.id,'confirmed',String(sid),`وافق المالك — مطابقة للطلب ${reqRef} ووردية الخادم`);
          state.shift=String(sid);state.localShift=null;
        }else if(sid&&reqRef&&so&&so.status==='sent_awaiting_owner'){
          // معلّقة بسبب صريح والمعرفات كاملة للمراجعة — لا تخمين ولا ربط بأي وردية مفتوحة أخرى
          const reason=!reqShift
            ?`وافق المالك الطلب ${reqRef} — الربط معلّق حتى يثبت الخادم ارتباط الوردية بالطلب نفسه (عمود shift_id غير متاح بعد في صف الطلب)؛ لا ربط بالموافقة وحدها`
            :`وافق المالك الطلب ${reqRef} — الوردية المفتوحة ${String(sid)} ليست وردية الطلب ${reqShift}؛ الربط معلّق حتى التطابق`;
          if(so.note!==reason)b.ofxSettle(so.id,'sent_awaiting_owner',String(so.serverRef||''),reason);
        }
      }catch{}
    } // approved===null: تبقى «وصل الطلب» ويُعاد التحقق — بلا ربط بلا دليل
  }

  // 3) الدفع بالترتيب الزمني مع عزل المتاجر وتجريد الوسوم الداخلية.
  let ownerReplayReady=null;
  for(const o of queued){
    if(state.readOnly&&(o.kind!=='invoice'||readOnlyReplayMisses.has(o.id)))continue; // دون كتابة أو تكرار بحث فارغ
    let name=OFX_RPC[o.kind];
    if(!name){b.ofxSettle(o.id,'conflict','','نوع عملية غير معروف للمزامنة');continue;}
    let payload;try{payload=JSON.parse(o.payload);}catch{b.ofxSettle(o.id,'conflict','','حمولة تالفة — راجع المالك');continue;}
    if(payload._store==null){b.ofxSettle(o.id,'conflict','','معزولة: عملية قديمة بلا وسم متجر — لا تُدفع تلقائيًا أبدًا؛ محفوظة لمراجعة المالك');continue;}
      if(payload._store!==state.store)continue; // صارم: عملية بلا وسم متجر أو بمتجر آخر لا تُدفع من هذه الجلسة
    if(o.kind==='invoice'&&state.role==='owner'&&state.sellerMode&&!state.readOnly){
      if(ownerReplayReady===null)try{await ensureOwnerSellerSession();ownerReplayReady=true;}catch{ownerReplayReady=false;}
      if(!ownerReplayReady)continue; // remain queued with the SAME id; never a false conflict or duplicate.
    }
    let args;
    try{args=o.kind==='invoice'?guardedInvoiceArgs(payload):
      Object.fromEntries(Object.entries(payload).filter(([k])=>!k.startsWith('_')));}
    catch(e){b.ofxSettle(o.id,'conflict','',String(e.message||e).slice(0,160));continue;}
    if(o.kind==='invoice'&&payload._v3)name='rfq_pilot_post_invoice_v3';
    if(args.p_shift&&isLocalShift(args.p_shift)){
      const mapped=b.metaGet(mapKey(args.p_shift));
      if(mapped)args.p_shift=mapped;
      else continue; // وردية محلية لم يعتمدها المالك بعد: تبقى في الطابور — لا فقدان ولا تأكيد صامت
    }
    // انتهاء الترخيص يسمح باسترجاع الإقرار السابق فقط. هذا العلم الخادمي
    // يضمن ألا تنشئ عملية معلقة غير معتمدة بيعًا جديدًا أثناء وضع القراءة.
    if(o.kind==='invoice'&&state.readOnly)args.p_replay_only=true;
    try{
      let r;let openingDegraded=false;
      if(o.kind==='shift_open'&&payload._local&&payload._local.opening_cents!=null){
        try{r=await state.api.rpc(name,{...args,p_opening_cents:payload._local.opening_cents});}
        catch(e0){
          const m0=String(e0&&e0.message||e0);
          const st0=Number(e0&&e0.status)||0;
          // أمر المالك (الجولة 8+9): إسقاط العهدة لا يجوز إلا برفض خادمي صريح لتوقيع دالة الطلب
          // نفسه يسمّي الدالة ومعامل العهدة p_opening_cents معًا (400/404). ذكر اسم الدالة وحده
          // لا يكفي، ورسالة أعمال تحتوي «does not exist» (مثل «device does not exist») ليست
          // ترخيصًا — تُعاد للمسار الخارجي (عابر → طابور؛ صريح → تعارض).
          const sigRejected=(st0===400||st0===404)
            &&/could not find the function|function .*does not exist|unknown argument|unknown parameter|signature/i.test(m0)
            &&/rfq_pilot_request_shift/i.test(m0)
            &&/p_opening_cents/i.test(m0);
          if(!sigRejected)throw e0;
          openingDegraded=true; // خادم أقدم لا يقبل العهدة في الطلب: يُرسل بدونها وتُعلن للمالك يدويًا عند الاعتماد
          r=await state.api.rpc(name,args);
        }
      }else r=await state.api.rpc(name,args);
      if(o.kind==='product'&&r==null){b.ofxSettle(o.id,'conflict','','الخادم لم يؤكد الصنف — يلزم ترقية الخادم لقبول معرف الصنف المحلي');continue;}
      if(o.kind==='shift_open'){ // «وصل الطلب» ≠ «وافق المالك»
        b.ofxSettle(o.id,'sent_awaiting_owner',r&&typeof r==='object'?JSON.stringify(r).slice(0,80):String(r??''),'وصل طلب الوردية للخادم — بانتظار موافقة المالك (ليست مفعّلة)'+(openingDegraded?' — العهدة لم تُضمَّن في الطلب (خادم لا يقبلها)؛ تُعلن للمالك يدويًا عند الاعتماد':''));
        continue;
      }
      if(o.kind==='invoice'){
        if(!r||!Number.isSafeInteger(r.number)||r.number<1||
           r.invoice_id!==args.p_invoice){
          showMessage('رد البيع غير مطابق أو غير مكتمل؛ بقي في الطابور بنفس المعرف دون تأكيد من الخادم');
          continue;
        }
        // الإقرار لا يبدّل مبلغ مستند مؤقت سبق عرضه للزبون صامتًا.
        // اللقطة الخام تبقى على الهاتف؛ تُرسل فقط قيم المقارنة المشتقة لكل سطر.
        if('_snapshot' in payload){
          if(!Array.isArray(payload._snapshot)||!payload._snapshot.length){
            b.ofxSettle(o.id,'conflict',String(r.number),'أقر الخادم فاتورة بلا لقطة أسعار محلية صالحة؛ راجع المالك قبل التسليم');
            continue;
          }
          if(!Number.isSafeInteger(r.total_cents)||r.total_cents<0||
             !Number.isSafeInteger(r.due_cents)||r.due_cents<0){
            showMessage('إقرار البيع لا يوضح المبالغ؛ بقي في الطابور بنفس المعرف دون تأكيد');
            continue;
          }
          const expected=cartTotal(payload._snapshot),due=expected-Number(args.p_cash_cents)-Number(args.p_other_cents||0);
          if(Number(r.total_cents)!==expected||Number(r.due_cents)!==due){
            const note=`أقر الخادم الفاتورة رقم ${r.number} بمبلغ ${cents(r.total_cents)} يختلف عن المستند المؤقت ${cents(expected)}؛ لا تُسلّم نسخة مؤكدة وراجع المالك (معرّف ${o.id})`;
            b.ofxSettle(o.id,'conflict',String(r.number),note);showMessage(note);
            continue; // قد التزم الخادم بالفعل؛ لا تُعد إرسالها آليًا ولا تُظهر إقرارًا مطابقًا كاذبًا
          }
          // تساوي الإجمالي لا يثبت تطابق السطور. الـRPC المحمي يعيد سطور
          // الفاتورة نفسها حتى بعد انقضاء إيجار العامل/الترخيص وإغلاق الوردية؛
          // لا نعتمد على RLS قراءة الجدول العام لاسترجاع إقرار سبق اعتماده.
          const lines=Array.isArray(r.lines)?r.lines:
            await state.api.table('rfq_pilot_invoice_lines',{
              store_id:`eq.${state.store}`,invoice_id:`eq.${args.p_invoice}`,
              select:'invoice_id,product_id,name_snapshot,price_cents,qty_milli',limit:'1000'});
          if(!Array.isArray(lines)||lines.length!==payload._snapshot.length){
            showMessage('أقر الخادم البيع لكن سطور الفاتورة غير متاحة للتحقق؛ بقي المستند مؤقتًا بنفس المعرّف');
            continue;
          }
          if(!invoiceLinesAgree(payload._snapshot,lines,args.p_invoice)){
            const note=`أقر الخادم الفاتورة رقم ${r.number} لكن أسعار/أسماء/كميات سطور الأصناف تختلف عن المستند المؤقت؛ لا تُسلّم نسخة مؤكدة وراجع المالك (معرّف ${o.id})`;
            b.ofxSettle(o.id,'conflict',String(r.number),note);showMessage(note);
            continue;
          }
        }
      }
      const ref=o.kind==='invoice'&&r&&r.number!=null?String(r.number):(r&&typeof r==='object'?JSON.stringify(r).slice(0,80):String(r??''));
      const settled=b.ofxSettle(o.id,'confirmed',ref,r&&r.already_committed?'مؤكدة (مطابقة سابقة — بلا تكرار)':'');
      if(o.kind==='invoice'&&state.invoice?.localId===o.id){
        try{
          if(!JSON.parse(settled||'{}').ok)throw Error('settle failed');
          const saved=JSON.parse(b.ofxGet?.(o.id)||'null');
          if(saved?.status!=='confirmed'||saved.id!==o.id)throw Error('status not persisted');
        }catch{showMessage('وصل إقرار الخادم لكن تعذّر تثبيته على الهاتف؛ احتفظ بالمستند المؤقت للمراجعة');continue;}
        renderInvoice({...r,localId:o.id},payload._snapshot||state.invoiceLines);
        showMessage(r.already_committed?'أُعيد إقرار نفس الفاتورة دون خصم جديد.':'أُقرت الفاتورة على الخادم.','ok');
      }
      if(o.kind==='shift_close'){b.metaSet(lsKey,'');state.localShift=null;}
    }catch(e){
      const msg=String(e&&e.message||e);
      // الجولة 8+9: رمز الاستجابة أولًا — كل 5xx و429 عابر (يبقى في الطابور) ولو حمل جسمًا نصيًا
      // غير معروف؛ النص (unavailable وغيرها) يُعتبر فقط عند غياب الرمز (عطل شبكة محض). رد أعمال
      // 400/4xx = تعارض صريح للمالك، لا صمت عابر في الطابور.
      const stq=(e&&Number(e.status))||0;
      if(o.kind==='invoice'&&state.readOnly&&/invoice_replay_not_found/.test(msg)){
        readOnlyReplayMisses.add(o.id);continue; // باقية في Room دون قيد جديد أو سبام طلبات
      }
      if(stq>=500||stq===429||(!stq&&/aborted|Failed to fetch|fetch failed|network|timeout|HTTP 5|503|502|504|unavailable/i.test(msg)))continue; // خطأ عابر (شبكة أو حد معدل أو خادم مؤقت) = يبقى في الطابور، لا تعارض
      if(/approved_open_shift_required|worker_session|live_session_required|session/i.test(msg))continue; // جلسة/وردية عابرة: تبقى في الطابور وتنجح بعد استعادة الجلسة — لا تعارض نهائي
      b.ofxSettle(o.id,'conflict','',msg.slice(0,160)); // صريح للمالك؛ لا حذف ولا تعديل
    }
  }
}
async function syncPull(){
  const b=bridge();if(!b||!state.api?.signedIn||!navigator.onLine)return;
  // عمود التتبع المفضل updated_at إن وُجد (يلتقط التعديلات والإغلاقات) وإلا البديل.
  const specs=[['products',['updated_at','created_at'],'500'],['customers',['updated_at','created_at'],'500'],
    ['invoices',['created_at'],'100'],['debt_entries',['created_at'],'500'],['shifts',['updated_at','opened_at'],'100']];
  for(const [tbl,cols,lim] of specs){
    const wmKey='pull_wm:'+state.store+':'+tbl, colKey='pull_col:'+state.store+':'+tbl;
    let wm=b.metaGet(wmKey)||'';           // صيغة المراس المركب: ts|id — لا تفويت لصفوف بنفس التوقيت
    let col=b.metaGet(colKey)||cols[0];
    let pages=0;
    while(pages<20){
      pages++;
      const q={store_id:`eq.${state.store}`,select:tbl==='products'?CATALOG_PUBLIC_COLUMNS:'*',order:`${col}.asc,id.asc`,limit:lim};
      if(wm){
        const sep=wm.indexOf('|');const ts=sep<0?wm:wm.slice(0,sep),idp=sep<0?'':wm.slice(sep+1);
        q.or=idp?`(${col}.gt.${ts},and(${col}.eq.${ts},id.gt.${idp}))`:`(${col}.gt.${ts})`;
      }
      let rows;
      try{rows=await state.api.table(`rfq_pilot_${tbl}`,q);}
      catch(e){
        const msg=String(e&&e.message||e);
        if(col===cols[0]&&cols.length>1&&/column|order|sort|PGRST|400/i.test(msg)){
          col=cols[1];b.metaSet(colKey,col);wm='';b.metaSet(wmKey,'');continue; // جدول بلا updated_at: أعد من البداية بالبديل
        }
        break; // خطأ آخر (شبكة/صلاحية): لا يُمس مراس هذا الجدول — لا تفويت
      }
      if(!Array.isArray(rows)||!rows.length)break;
      b.mirrorPut(JSON.stringify(rows.map(r=>({tbl:state.store+':'+tbl,id:String(r.id),json:JSON.stringify(r),updatedAt:String(r[col]||'')}))));
      const savedJson=new Map(JSON.parse(b.mirrorGet(state.store+':'+tbl)||'[]').map(r=>[r.id,r.json]));
      if(!rows.every(r=>savedJson.get(String(r.id))===JSON.stringify(r)))break; // المراس لا يتقدم قبل ثبوت حفظ الصفحة بمحتواها المحدّث (يشمل صفوفًا موجودة تغيّرت)
      const lastRow=rows[rows.length-1];
      wm=String(lastRow[col]||'')+'|'+String(lastRow.id||'');
      b.metaSet(wmKey,wm);
      if(rows.length<Number(lim))break; // صفحة ناقصة = النهاية
    }
  }
  renderFromMirror();
}
function mirrorRows(tbl){const b=bridge();if(!b)return [];return JSON.parse(b.mirrorGet(tbl)||'[]').map(r=>{try{return JSON.parse(r.json);}catch{return null;}}).filter(Boolean);}
function renderFromMirror(){
  // أمر المالك (الجولة 7): «الجهاز متصل والخادم ساقط» يعرض النسخة المحلية المحفوظة فعلًا —
  // القول (رسالة الأمان الصادقة) يجب أن يطابق الفعل (العرض من المرآة).
  if(navigator.onLine&&!state.serverDown)return;
  const prods=mirrorRows(state.store+':products'),custs=mirrorRows(state.store+':customers');
  if(prods.length)state.products=prods;
  if(custs.length)state.customers=custs;
  renderProducts();renderCustomers();renderCart();
}
let syncInFlight=null;
function syncAll(){
  if(state.mode==='offline')return Promise.resolve(); // وضع محلي: لا مزامنة خارجية
  if(syncInFlight)return syncInFlight; // حارس تنفيذ واحد: لا مزامنتان متزامنتان أبدًا
  syncInFlight=(async()=>{try{await syncPush();await syncPull();}finally{syncInFlight=null;}})();
  return syncInFlight;
}
function sameStoreOp(o){try{const p=JSON.parse(o.payload);return p._store===state.store;}catch{return false;}} // صارم: بلا وسم متجر = لا تُعرض ولا تُدفع هنا
function syncCenterCard(){
  const b=bridge();if(!b)return null;
  // قائمة المراجعة الكاملة (بلا حد 100) إن توفر الجسر؛ وإلا قوائم العرض القديمة
  const centerRaw=b.ofxReview?[...JSON.parse(b.ofxReview()),...queuedOps(b)]:JSON.parse(b.ofxList()||'[]');
  const ops=centerRaw.filter((o,i,arr)=>arr.findIndex(x=>x.id===o.id)===i).filter(sameStoreOp);
  const conf=el('div',null,'card mt');conf.append(el('h2','مركز المزامنة والتعارضات','h2'));
  if(!ops.length)conf.append(el('p','لا عمليات محلية معلّقة.','muted'));
  for(const o of ops){
    const storageOk=decisionsStorageOk();
    if(o.status==='conflict'&&state.role==='owner'&&!storageOk){
      conf.append(row(`عملية ${o.kind} · ${provisionalBadge(o.status)}`,`تعذر حفظ سجل القرارات على هذا الهاتف — الحسم معطل حتى اعتماد مسار التوثيق الخادمي 000503 · معرف ${o.id.slice(0,8)} · المعرّف الكامل ${o.id}`));
      continue;
    }
    if(o.status==='conflict'&&state.role==='owner'){
      // أمر المالك (الجولة 7): زرا الحسم المحلي («اعتماد كبديل جديد» و«تسجيل الإلغاء محليًا») معطلان
      // مؤقتًا — التعارض يبقى محفوظًا وظاهرًا للمالك كما هو، بلا حذف أو تعديل أو سجل قرار جديد،
      // حتى يُعتمد مسار التوثيق الخادمي 000503. لا حسم محلي غير قابل للتوثيق الآمن.
      conf.append(row(`عملية ${o.kind} · ${provisionalBadge(o.status)}`,
        `${o.note||'تعارض محفوظ — لم يُحذف ولم يُعدّل'} · معرف ${o.id.slice(0,8)} · المعرّف الكامل ${o.id} · محاولات ${o.attempts}`));
      conf.append(row('الحسم معطل مؤقتًا حتى اعتماد مسار التوثيق الخادمي 000503','التعارض محفوظ وظاهر للمالك كما هو — لا «اعتماد كبديل جديد» ولا «إلغاء محلي» الآن؛ أي قرار حسم يحتاج توثيقًا خادميًا آمنًا أولًا'));
      const rq=el('button','↩ إعادة إلى قائمة المزامنة (محاولة جديدة بنفس المعرّف)','btn sm amber');rq.type='button';
      rq.onclick=()=>handle(async()=>{b.ofxSettle(o.id,'queued','','أعادها المالك إلى قائمة المزامنة — ستُعاد المحاولة بنفس المعرّف');showMessage('أُعيدت العملية إلى قائمة المزامنة بنفس معرّفها — لا تكرار ولا حذف.','ok');renderOfflineCenter===null;await syncAll().catch(()=>{});await refresh().catch(()=>{});});
      conf.append(rq);
      continue;
    }
    conf.append(row(`عملية ${o.kind} · ${provisionalBadge(o.status)}`,
      `${o.note||''} · معرف ${o.id.slice(0,8)} · المعرّف الكامل ${o.id} · محاولات ${o.attempts}`));
  }
  // العمليات القديمة بلا وسم متجر: لا تُخفى — تُعرض للمالك معزولةً دون دفع تلقائي
  const iso=centerRaw.filter((o,i,arr)=>arr.findIndex(x=>x.id===o.id)===i).filter(o=>{try{return JSON.parse(o.payload)._store==null;}catch{return true;}});
  if(iso.length){
    conf.append(el('h2','عمليات معزولة — لا تُدفع تلقائيًا','h2'));
    conf.append(el('p','عمليات قديمة بلا وسم متجر: معزولة ومحفوظة كما هي؛ الاطلاع الكامل والقرار للمالك وحده.','muted'));
    if(state.role==='owner')for(const o of iso)conf.append(row(`عملية ${o.kind} · ${provisionalBadge(o.status)}`,`معرف ${o.id.slice(0,8)} · المعرّف الكامل ${o.id} · ${o.note||'بلا وسم متجر — لم تُدفع'}`));
    else conf.append(el('p','هذه العمليات خارج بيعك الحالي وقرارها للمالك.','muted'));
  }
  let dj=[];try{dj=JSON.parse(b.metaGet('owner_local_decisions:'+state.store)||'[]');}catch{}
  if(state.role==='owner'&&dj.length){
    conf.append(el('h2','قرارات مالك محلية — بانتظار التوثيق على الخادم','h2'));
    conf.append(el('p','مسجلة على هذا الهاتف فقط حتى تُفعَّل ترقية التوثيق 000503 وتصل الخادم — لا تُعرض كموثقة.','muted'));
    for(const d of dj.slice(-10).reverse())conf.append(row(`قرار ${d.decision==='cancelled'?'إلغاء':'اعتماد بديل'} — لم يُوثَّق بعد`,`${d.kind} · عملية ${String(d.op).slice(0,8)} · المعرّف الكامل ${d.op} · ${d.note} · ${d.at}`));
  }
  return conf;
}
function renderOfflineCenter(){
  const home=$('homeView');if(!home)return;home.replaceChildren();
  home.append(el('div',navigator.onLine&&state.serverDown
    ?'الجهاز متصل بالشبكة لكن الخادم غير متاح — المعروض نسخة محلية محفوظة، وكل عملية جديدة «بانتظار المزامنة» بمستند مؤقت.'
    :'لا يوجد اتصال بالخادم — المعروض نسخة محلية محفوظة، وكل عملية جديدة «بانتظار المزامنة» بمستند مؤقت.','flash error'));
  const b=bridge();
  if(b&&state.role==='worker'){
    const ls=JSON.parse(b.metaGet('local_shift:'+state.store)||'null');
    if(ls)state.localShift=ls;
    const card=el('div',null,'card mt');card.append(el('h2','الوردية دون اتصال','h2'));
    if(!ls){
      card.append(el('p','إن كان جهازك وجلسك معتمدين من آخر اتصال، يمكنك فتح وردية مؤقتة دون نت. تبقى مؤقتة — ومستنداتها مؤقتة — حتى يُرسل الطلب للخادم ويعتمده المالك.','muted'));
      const openingField=inlineMoneyInput('عهدة افتتاح الدرج بالريال اليمني (تُعلن للمالك عند الاعتماد):');
      const btn=el('button','فتح وردية مؤقتة (مستند مؤقت)','btn p');
      btn.disabled=!(state.approved&&state.lease&&!state.readOnly);
      btn.onclick=()=>handle(async()=>{
        const id=crypto.randomUUID();
        const localShift={id,opening_cents:moneyCents(openingField.input.value),opened_at:new Date().toISOString(),anchor:state.api?.lastServerDate||''};
        // حفظ ذري: العملية الكاملة (ببيانات الوردية) تُكتب وتُتحقق في الطابور أولًا — انقطاع بعدها لا يترك حالة جزئية.
        ofxQueue('shift_open',{p_store:state.store,p_device:state.device,_local:localShift},'shift_open:'+id);
        try{b.metaSet('local_shift:'+state.store,JSON.stringify(localShift));}catch{} // تخزين مساعد فقط
        state.localShift=localShift;
        showMessage('فُتحت وردية محلية مؤقتة — كل مبيعاتها مستندات مؤقتة حتى تأكيد الخادم واعتماد المالك.','ok');
        renderOfflineCenter();updateSaleButtons();
      });
      card.append(openingField.wrap,btn);
    }else{
      const mapped=b.metaGet('shift_map:'+state.store+':'+ls.id);
      card.append(el('p',mapped?'الوردية المؤقتة ارتبطت بوردية الخادم — المزامنة جارية بالترتيب.':'وردية محلية مؤقتة مفتوحة — بانتظار عودة الاتصال لإرسال الطلب، ثم اعتماد المالك. العهدة المعلنة: '+cents(ls.opening_cents),'muted'));
      if(!ls.closing){
        const countedField=inlineMoneyInput('كم النقد الموجود فعلاً بالدرج؟ (ريال يمني)');
        const closeBtn=el('button','إغلاق الوردية المؤقتة (مستند مؤقت)','btn amber');
        closeBtn.onclick=()=>handle(async()=>{
          ofxQueue('shift_close',{p_shift:ls.id,p_counted_cents:moneyCents(countedField.input.value),p_event:crypto.randomUUID()},'shift_close:'+ls.id);
          try{b.metaSet('local_shift:'+state.store,JSON.stringify({...ls,closing:true}));}catch{} // تخزين مساعد
          state.localShift={...ls,closing:true};
          showMessage('سُجل إغلاق الوردية محليًا — مستند مؤقت حتى إقرار الخادم.','ok');
          renderOfflineCenter();updateSaleButtons();
        });
        card.append(countedField.wrap,closeBtn);
      }else card.append(el('p','الإغلاق المؤقت مسجل وفي الطابور — لا عمليات بيع جديدة على هذه الوردية.','muted'));
    }
    home.append(card);
  }
  const sc=syncCenterCard();if(sc)home.append(sc);
  const box=$('shiftList');
  if(box){box.replaceChildren();
    if(b)box.append(el('p',`عمليات بانتظار المزامنة: ${JSON.parse(b.ofxList()||'[]').filter(o=>o.status==='queued'&&sameStoreOp(o)).length}`,'muted'));
    else box.append(el('p','الطابور المحلي متاح داخل تطبيق الهاتف فقط.','muted'));}
}
async function exportAllPages(tbl,col){
  // جلب كامل بصفحات 500 ومراس مركب (الوقت+المعرف) — مثل السحب، لا سقف 1000
  const rows=[];let wm='';
  for(let pages=0;;pages++){
    const q={store_id:`eq.${state.store}`,select:'*',order:col==='id'?'id.asc':`${col}.asc,id.asc`,limit:'500'};
    if(wm){const i=wm.lastIndexOf('|');const ts=wm.slice(0,i),idp=wm.slice(i+1);
      q.or=col==='id'?`(id.gt.${idp})`:`(${col}.gt.${ts},and(${col}.eq.${ts},id.gt.${idp}))`;}
    const page=await state.api.table(`rfq_pilot_${tbl}`,q);
    rows.push(...page);
    if(page.length<500)return {rows,capped:false};
    const last=page[page.length-1];wm=col==='id'?`x|${last.id}`:`${last[col]}|${last.id}`;
    if(pages>=199)return {rows,capped:true};
  }
}
async function exportCsv(kind){
  const headers={invoices:['number','total_cents','due_cents','created_at'],customers:['name','phone','created_at'],debts:['customer_id','amount_cents','created_at']};
  const tbl={invoices:'invoices',customers:'customers',debts:'debt_entries'}[kind];
  let rows=[];let mode='server';let warn='';
  if(navigator.onLine&&state.api?.signedIn){
    try{
      let r;
      try{r=await exportAllPages(tbl,'created_at');}
      catch(e){
        const msg=String((e&&(e.message||e))||'');
        if(!/column|order|sort|PGRST|400/.test(msg))throw e;
        r=await exportAllPages(tbl,'id'); // عمود بديل آمن عند اختلاف المخطط
        warn=' — تنبيه: رُتب التصدير بالمعرف لعدم توفر عمود الوقت';
      }
      rows=r.rows;if(r.capped)warn+=' — تنبيه: بلغ التصدير حد الأمان (100 ألف صف) وتحقق من اكتماله';
    }catch(e){
      rows=mirrorRows(state.store+':'+tbl);mode='local';
      warn=' — تنبيه: تعذر إكمال الجلب من الخادم؛ التصدير من النسخة المحلية وقد يكون ناقصًا';
    }
  }else{
    rows=mirrorRows(state.store+':'+tbl);mode='local';
    warn=' — تصدير محلي مؤقت من النسخة المحفوظة (لا اتصال) — ليس تصدير خادم كامل';
  }
  // تصدير محاسبي: عناوين عربية، والمبالغ بالريال بمنزلتين عشريتين بدل الهللات، والتواريخ بصيغة واضحة
  const LABELS={number:'رقم الفاتورة',total_cents:'الإجمالي (ريال)',due_cents:'المستحق (ريال)',created_at:'التاريخ',name:'الاسم',phone:'الهاتف',customer_id:'رقم الزبون',amount_cents:'المبلغ (ريال)'};
  const money=(v)=>(Number(v||0)/100).toFixed(2);
  const fmtVal=(c,v)=>{ if(v==null)return ''; if(/_cents$/.test(c))return money(v); if(c==='created_at'){const d=new Date(v);return isNaN(d)?String(v):d.toISOString().slice(0,16).replace('T',' ');} return String(v); };
  const lines=[headers[kind].map(c=>LABELS[c]||c)].concat(rows.map(j=>headers[kind].map(c=>fmtVal(c,j[c]))));
  const csv='\uFEFF'+lines.map(r=>r.map(c=>`"${String(c??'').replace(/"/g,'""')}"`).join(',')).join('\n');
  const tag=`(${rows.length} صف${mode==='local'?' — نسخة محلية':' — من الخادم'})`;
  const b=bridge();
  if(b&&b.saveExport){const r=JSON.parse(b.saveExport(`${kind}.csv`,csv)||'{}');return r.path?`حُفظ التصدير داخل الهاتف ${tag}: ${r.path}${warn}`:'تعذر الحفظ المحلي';}
  const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'}));a.download=`${kind}.csv`;a.click();return `نُزل ملف التصدير ${tag}${warn}`;
}
function assertWritable(){
  if(state.readOnly)throw Error('الترخيص منتهٍ على الخادم: القراءة والتصدير فقط — جدّد الاشتراك لمتابعة العمليات');
}
function enterSession(user,membership){
  ownerSessionEpoch++;state.sellerMode=false;state.ownerSessionState=null;state.shift=null;
  state.user=user;state.store=membership.store_id;state.role=membership.role;state.device=loadDeviceId(user.id);
  state.invoice=null;state.invoiceLines=[];$('latestInvoice').textContent='لم تُحفظ أي فاتورة في هذه الجلسة بعد.';$('printInvoice').hidden=true;$('printArea').replaceChildren();
  try{localStorage.setItem('rafiq-cloud-membership-v1',JSON.stringify({userId:user.id,store:membership.store_id,role:membership.role}));}catch{}
  try{
    const b=bridge();
    if(b){
      let ls=JSON.parse(b.metaGet('local_shift:'+state.store)||'null');
      const list=JSON.parse(b.ofxList()||'[]');
      if(!ls||!ls.id){ // التخزين المساعد مفقود (انقطاع بين الخطوتين): الطابور هو مصدر الحقيقة
        for(const x of list){
          if(x.kind!=='shift_open')continue;
          if(!(x.status==='queued'||x.status==='sent_awaiting_owner'))continue;
          try{const p=JSON.parse(x.payload);
            if(p._store===state.store&&p._local&&p._local.id){ls=p._local;break;}
          }catch{}
        }
      }
      if(ls&&ls.id){
        const closed=list.some(x=>x.kind==='shift_close'&&x.id==='shift_close:'+ls.id&&x.status!=='confirmed');
        state.localShift=closed?{...ls,closing:true}:ls;
        if(!b.metaGet('local_shift:'+state.store))try{b.metaSet('local_shift:'+state.store,JSON.stringify(state.localShift));}catch{}
      }
    }
  }catch{}
  state.pending=getPending();
  // حمولة قديمة من WebView أو نية توقفت بين الكتابتين: تُرحَّل للطابور بنفس المعرف
  // قبل تشغيل المزامنة. لا مسار RPC ثانٍ للفاتورة داخل APK.
  if(embedded&&state.pending)try{stageSaleIntent(state.pending);}catch(e){showMessage(e.message);}
  state.lease=false;state.approved=false;updatePendingOpButtons();
  // Rafiq's old top bar showed the role, not a full e-mail squeezed over the logo.
  // Keep the full account visible in Settings and in the accessible title.
  document.body.dataset.role=state.role;
  $('who').textContent=state.role==='owner'?'صاحب المتجر':'عامل';$('who').title=user.email||'حساب المتجر';
  $('who').hidden=false;$('logout').hidden=false;$('menuToggle').hidden=false;
  for(const item of document.querySelectorAll('.owner-only'))item.classList.toggle('hide',state.role!=='owner');
  for(const item of document.querySelectorAll('.worker-only'))item.classList.toggle('hide',state.role!=='worker');
  $('tabs').querySelector('[data-view="products"]').lastChild.textContent=
    state.role==='owner'?'الأصناف والمخزون':'أين الصنف؟';
  $('accountDetails').textContent=`${user.email||'حساب المتجر'} • ${state.role==='owner'?'مالك':'عامل'} • متجر ${state.store.slice(-8)}`;
  $('storeLine').textContent=`متجر رفيق • ${state.store.slice(-8)}`;
  screen('app');setView(state.role==='owner'?'home':'pos');
  restoreQueuedSale(); // بعد إعادة الفتح: المستند غير المقرّ من سجل الطابور نفسه
  return (async()=>{
    // إذا انتهى الترخيص، دالة تسجيل الجهاز ترفض الدخول. استعد إقرارات
    // الفواتير الملتزمة سابقًا في وضع قراءة فقط، دون فتح إيجار أو بيع جديد.
    let recoveryOnly=false;
    if(navigator.onLine&&state.mode!=='offline'&&state.role==='worker'){
      const licensed=await state.api.rpc('rfq_pilot_license_current',{p_store:state.store});
      if(licensed===false){state.readOnly=true;state.lease=false;recoveryOnly=true;updateSaleButtons();}
    }
    if(!recoveryOnly)try{await requestDevice();}catch(e){if(netReady())throw e;} // دون نت: ندخل بالوضع المؤقت
    if(recoveryOnly)await syncPush(); // الخادم يسمح بالإقرار السابق فقط؛ غير الموجود يبقى في الطابور
    try{await refresh();}catch(e){if(netReady())throw e;}
    if(state.deviceLimit)showMessage('device_limit_reached');
    else showMessage(recoveryOnly?'انتهى الترخيص: قراءة واسترجاع إقرارات سابقة فقط؛ لا بيع جديد.':'تم تحميل بيانات متجرك من الخادم.','ok');
  })();
}
async function tryRestoreSession(){
  let raw=null;try{raw=JSON.parse(localStorage.getItem('rafiq-cloud-session-v1')||'null');}catch{}
  if(!raw||!raw.url||!raw.key||!raw.access||!raw.user||!raw.user.id)return;
  const api=new PilotApi(raw.url,raw.key);
  api.access=raw.access;api.refreshToken=raw.refreshToken||'';api.expiresAt=Number(raw.expiresAt)||0;api.sessionUser=raw.user;
  try{
    state.api=api;
    const membership=await api.table('rfq_pilot_members',{user_id:`eq.${raw.user.id}`,active:'eq.true',select:'store_id,role',limit:'2'});
    if(membership.length!==1){api.clear();state.api=null;return;}
    await enterSession(raw.user,membership[0]);
    showMessage('استُعيدت الجلسة المحفوظة — لا حاجة لدخول ثانٍ.','ok');
  }catch(e){
    const msg=String(e&&e.message||e);
    // شرط المالك (الجولة 10): إن وُجد رمز استجابة فالخادم رد فعلًا — نص الشبكة داخل رد أعمال
    // (مثل 400 «Network unavailable») لا يُعامل كانقطاع؛ النص يُعتبر فقط بلا رمز إطلاقًا.
    const stt=(e&&Number(e.status))||0;
    const net=!stt&&(!navigator.onLine||/aborted|Failed to fetch|fetch failed|network|timeout/i.test(msg));
    let cm=null;try{cm=JSON.parse(localStorage.getItem('rafiq-cloud-membership-v1')||'null');}catch{}
    if(net&&cm&&cm.userId===raw.user.id&&cm.store){
      // إغلاق وفتح دون نت: دخول من الجلسة المحفوظة بوضع مؤقت — لا يُعرض أي شيء كمؤكد من الخادم.
      state.api=api;state.offlineNow=true;
      await enterSession(raw.user,{store_id:cm.store,role:cm.role});
      try{
        const ws=JSON.parse(localStorage.getItem('rafiq-worker-state-v1')||'null');
        if(ws&&ws.userId===raw.user.id&&ws.store===cm.store){
          state.approved=!!ws.approved;state.lease=!!ws.lease;state.shift=ws.shift||null;
          updateSaleButtons();renderOfflineCenter();
        }
      }catch{}
      showMessage('لا يوجد اتصال: التطبيق مفتوح بوضع مؤقت من جلستك المحفوظة — كل عملية «بانتظار المزامنة».','ok');
      return;
    }
    // الجولة 8+9: رمز الاستجابة يحسم — كل 5xx و429 خطأ خادم مؤقت: الجلسة محفوظة وتُعاد المحاولة،
    // لا هبوط للدخول؛ النص يُعتبر فقط بلا رمز (شبكة). رد أعمال 400 يهبط للدخول دون مسح الجلسة المحفوظة.
    if(stt>=500||stt===429||(!stt&&/HTTP 5|too many requests|temporarily unavailable/i.test(msg))){
      state.api=api;showMessage('تعذر التحقق من العضوية الآن (خطأ خادم مؤقت) — جلستك محفوظة وستُعاد المحاولة.','ok');return;
    }
    state.api=null;
  }
}
// ===== نهاية محرك المزامنة =====
function el(tag,text,cls=''){const node=document.createElement(tag);if(text!=null)node.textContent=String(text);if(cls)node.className=cls;return node;}
function showMessage(message,kind='error'){
  const raw=String(message),box=$('message');box.textContent=friendlyError(raw);box.className=`flash ${kind}`;box.hidden=false;
  box.dataset.rawMessage=raw;box.setAttribute('role',kind==='error'?'alert':'status');
  clearTimeout(showMessage.timer);if(kind!=='error')showMessage.timer=setTimeout(()=>{box.hidden=true;},9000);
  else{const dismiss=el('button','×','message-dismiss');dismiss.type='button';dismiss.setAttribute('aria-label','إغلاق التنبيه');dismiss.onclick=()=>{box.hidden=true;};box.append(dismiss);}
}
function friendlyError(raw){
  const messages={device_limit_reached:'اكتمل عدد الأجهزة المعتمدة. افتح الإعدادات ← أجهزة المالك لنقل اعتماد جهاز قديم إلى هذا الهاتف.',
    owner_seller_device_or_session_denied:'هذا الجهاز غير معتمد للبيع بعد. أكمل اعتماده من الإعدادات؛ لم تُفتح وردية جديدة ولم يُحفظ أي بيع.',
    seller_session_already_active:'جلسة بيع المالك مفتوحة على جهاز آخر. أغلقها هناك قبل بدء جلسة جديدة.',
    old_device_has_active_shift_or_session:'الجهاز القديم لديه وردية أو جلسة بيع نشطة. أغلقها أولاً قبل نقل اعتماده.',
    device_transfer_state_changed:'تغيّرت حالة أحد الجهازين. حدّث قائمة الأجهزة قبل النقل.',
    worker_session_already_active:'جلسة العامل نشطة على جهاز آخر؛ يراجعها المالك قبل فتح جلسة جديدة.'};
  for(const [code,text] of Object.entries(messages))if(raw.includes(code))return text;
  if(raw.includes('permission denied for table rfq_pilot_products'))return 'تعذّرت قراءة الأصناف بسبب صلاحية الخادم. لم تُغيّر بياناتك؛ حدّث الشاشة أو راجع إعداد الصلاحيات.';
  return raw;
}
function workspaceFeedback(text,failed=false){
  const box=$('workspaceStatus');if(!box)return;
  box.replaceChildren();box.hidden=!text;if(!text)return;
  box.className='workspace-status'+(failed?' failed':'');box.setAttribute('role',failed?'alert':'status');
  box.append(el('strong',failed?'تعذّر تحديث البيانات':'جارٍ تحميل بيانات متجرك'),el('p',text,'muted small'));
  if(failed){const b=el('button','إعادة المحاولة','btn sm p');b.type='button';b.onclick=()=>handle(safeRefresh);box.append(b);}
}
function inlineMoneyInput(labelText){
  const wrap=el('div',null,'mt'),label=el('label',labelText),input=el('input');
  input.type='number';input.min='0';input.step='0.01';input.value='0';input.inputMode='decimal';
  wrap.append(label,input);return {wrap,input};
}
function reducedMotion(){try{return !!(window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches);}catch{return false;}}
function haptic(){try{if(navigator.vibrate)navigator.vibrate(12);}catch{}} // خفيف عند الضغط
let _uiTap=null;
function uiTapSound(){ // صوت قصير مضمّن محليًا — بلا شبكة
  try{_uiTap=_uiTap||new Audio('assets/ui/tap.wav');_uiTap.currentTime=0;_uiTap.volume=0.35;
    const p=_uiTap.play();if(p&&p.catch)p.catch(()=>{});}catch{}
}
function spinRefresh(btn,on){ // حركة دائرية داخل زر التحديث طوال مدة التحديث
  if(!btn)return;const ico=btn.querySelector('.refresh-ico');
  if(ico)ico.classList.toggle('spin',!!on&&!reducedMotion());
}
function screen(name){for(const item of ['setup','activation','mode','localSetup','pin','login','app']){
  const s=$(`${item}Screen`);const show=item===name;s.classList.toggle('hide',!show);
  if(show&&!reducedMotion()){s.classList.remove('fade-in');void s.offsetWidth;s.classList.add('fade-in');}}}
// ===== 130: إدارة لوحة المفاتيح — لا تعوق الكتابة والاختيار في أي شاشة =====
function blurActive(){try{const a=document.activeElement;if(a&&a.tagName&&a.tagName!=='BODY'&&typeof a.blur==='function')a.blur();}catch{}}
function isField(t){return !!t&&/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName||'');}
function setKeyboardOpen(on){document.body.classList.toggle('kb-open',!!on);}
document.addEventListener('focusin',e=>{
  if(!isField(e.target))return;
  setKeyboardOpen(true);
  const t=e.target;
  setTimeout(()=>{try{t.scrollIntoView({block:'center',behavior:'smooth'});}catch{}},280);
});
document.addEventListener('focusout',()=>{setTimeout(()=>{if(!isField(document.activeElement))setKeyboardOpen(false);},90);});
if(window.visualViewport)window.visualViewport.addEventListener('resize',()=>{
  const a=document.activeElement;
  if(isField(a)){setKeyboardOpen(true);setTimeout(()=>{try{a.scrollIntoView({block:'center'});}catch{}},60);}
});
// ضغطة أي زر/عنصر اختيار = إغلاق اللوحة (بلا تعطيل الكتابة داخل الحقول)
document.addEventListener('click',e=>{
  try{
    const t=e.target;
    const btn=t&&t.closest?t.closest('button,summary,[role=option],[role=button]'):null;
    if(!btn)return;
    const a=document.activeElement;
    if(a&&/^(INPUT|TEXTAREA)$/.test(a.tagName||'')&&!btn.contains(a))blurActive();
  }catch{}
},true);
// ===== 130: فراغ نموذج البيع بعد الحفظ — لا تبقى أسماء ولا مدفوعات ولا بحث =====
function resetSaleFields(){
  for(const id of ['saleCustomer','cashPaid','otherPaid','otherReference']){
    const elm=$(id);if(elm)elm.value='';
  }
  const om=$('otherMethod');if(om)om.value='wallet';
  const ps=$('productSearch');if(ps){ps.value='';ps.blur();}
  const m=$('productMatches');if(m){m.replaceChildren();m.classList.add('hide');}
  const sq=$('saleQty');if(sq)sq.value='1';
  blurActive();
}
  try{closeSaleReview();}catch(e){}
function closeDrawer(){
  $('tabs').classList.remove('open');$('drawerScrim').classList.add('hide');
  $('menuToggle').setAttribute('aria-expanded','false');document.body.classList.remove('drawer-open');
}
function openDrawer(){
  $('tabs').classList.add('open');$('drawerScrim').classList.remove('hide');
  $('menuToggle').setAttribute('aria-expanded','true');document.body.classList.add('drawer-open');
}
function goTo(view,focusId){
  setView(view);
  if(focusId){const field=$(focusId);if(field){for(let d=field.closest('details');d;d=d.parentElement?.closest('details'))d.open=true;field.focus();if(field.scrollIntoView)
    field.scrollIntoView({behavior:'smooth',block:'center'});}}
}
const APP_VIEWS=['home','monitor','pos','customers','suppliers','products','shifts','reports','settings'];
function setView(view){
  closeDrawer();
  if(!APP_VIEWS.includes(view))return;
  if(state.role==='worker' && (view==='reports'||view==='monitor'))return;
  if(state.role==='owner' && view==='pos' && !state.sellerMode)return; // بيع المالك فقط عبر «وضع بيع المالك» بهويته
  if(state.view!==view)$('message').hidden=true;
  state.view=view;
  document.body.dataset.view=view;
  for(const v of APP_VIEWS)
    $(`${v}View`).classList.toggle('hide',v!==view);
  for(const b of document.querySelectorAll('[data-view]')){
    b.classList.toggle('on',b.dataset.view===view);
    if(b.dataset.view===view)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current');
  }
  closeDrawer();
  if(view==='settings')loadSettingsPanels().catch(()=>{});
  if(view==='monitor')renderMonitor().catch(e=>showMessage(e.message));
  if(view==='suppliers')loadSuppliers().catch(e=>showMessage(e.message));
  if(view==='suppliers')loadSupplierRequests().catch(()=>{});
  if(view==='products'){renderDemands().catch(()=>{});if(state.role==='owner')loadStocktake().catch(()=>{});}
  $('pageTitle').textContent=({home:state.role==='owner'?'لوحة صاحب المتجر':'حالة جلسة البيع',
    pos:'نقطة البيع',customers:'الديون والزبائن',products:state.role==='owner'?'الأصناف والمخزون':'أين الصنف؟',
    shifts:'الصندوق والورديات',reports:'التقارير',settings:'الإعدادات',suppliers:'الموردون والمشتريات',monitor:'متابعة المتجر'})[view];
  $('ownerSellerNav')?.classList.toggle('on',view==='pos'&&state.sellerMode);
  $('tabSale')?.classList.toggle('on',view==='pos');
  // حركة المرجع: ظهور المحتوى بالتدريج (fade-in) عند كل انتقال شاشة
  const vnow=$(`${view}View`);
  if(vnow){vnow.classList.remove('anim-stagger');void vnow.offsetWidth;vnow.classList.add('anim-stagger');}
  if(typeof window.scrollTo==='function'&&!/jsdom/i.test(navigator.userAgent))window.scrollTo({top:0,behavior:'instant'});
}
function loadDeviceId(userId){
  // Device approval is per Auth user, not per shared browser or handset. Never
  // reassign an approved owner device UUID to a worker account on the same UI.
  const key=`rafiq-test-device:v2:${embedded?'android':'browser'}:${userId}`;
  try{let id=localStorage.getItem(key);
    if(!/^[0-9a-f-]{36}$/i.test(id||'')){id=crypto.randomUUID();localStorage.setItem(key,id);}return id;
  }catch{return crypto.randomUUID();}
}
function pendingKey(kind){return `rafiq-test-pending-${kind}:${state.store}:${state.user?.id}`;}
// مرحلة البيع الأولى: تثبيت نية البيع بمعرّفها وحمولتها ولقطة الأسعار في Room
// قبل أي طلب. sessionStorage يظل للمعاينة فقط/لترحيل جلسة حيّة قديمة.
function saleStore(){
  const b=bridge();
  if(!b||typeof b.metaGet!=='function'||typeof b.metaSet!=='function')
    throw Error('تخزين الهاتف غير متاح؛ أوقف البيع حتى لا يتكرر');
  return b;
}
function validSaleIntent(value){
  return value&&typeof value.id==='string'&&value.id&&value.payload&&
    value.payload.p_invoice===value.id&&Array.isArray(value.snapshot);
}
function readPending(kind){
  const key=pendingKey(kind);
  if(kind!=='sale'||!embedded){try{return JSON.parse(sessionStorage.getItem(key)||'null');}catch{return null;}}
  const b=saleStore();let raw;
  try{raw=b.metaGet(key);}catch{throw Error('تعذّرت قراءة البيع المعلّق من الهاتف؛ لا تنشئ بيعاً آخر');}
  if(raw){
    try{const intent=JSON.parse(raw);if(!validSaleIntent(intent))throw Error('invalid');return intent;}
    catch{throw Error('سجل البيع المعلّق تالف على الهاتف؛ أوقف البيع ولا تنشئ بديلاً');}
  }
  // النسخة السابقة خزنت البيع في جلسة WebView؛ انقل السجل الحي بعد إثبات كتابته في Room.
  let legacy;
  try{legacy=sessionStorage.getItem(key);}catch{throw Error('تعذّرت قراءة سجل البيع القديم؛ أوقف البيع ولا تنشئ بديلاً');}
  if(legacy){
    let intent;
    try{intent=JSON.parse(legacy);if(!validSaleIntent(intent))throw Error('invalid');}
    catch{throw Error('سجل البيع القديم تالف؛ أوقف البيع ولا تنشئ بديلاً');}
    writePending(kind,intent);
    return intent;
  }
  return null;
}
function writePending(kind,value){
  const key=pendingKey(kind);
  if(kind==='sale'&&embedded){
    if(value!=null&&!validSaleIntent(value))throw Error('بيانات البيع ناقصة؛ أوقف القيد لحماية التكرار');
    const b=saleStore(),raw=value==null?'':JSON.stringify(value);
    try{
      const result=JSON.parse(b.metaSet(key,raw)||'{}');
      if(!result.ok||b.metaGet(key)!==raw)throw Error('not persisted');
    }catch{throw Error('تعذّر حفظ معرّف البيع في قاعدة الهاتف؛ أوقف القيد لحماية التكرار');}
    try{sessionStorage.removeItem(key);}catch{} // إزالة اختيارية بعد تأكيد Room
    return;
  }
  try{if(value)sessionStorage.setItem(key,JSON.stringify(value));
    else sessionStorage.removeItem(key);}catch{throw Error('تعذر حفظ معرف العملية مؤقتاً؛ أوقف القيد لحماية التكرار');}
}
function getPending(){return readPending('sale');}
function setPending(value){if(value)writePending('sale',value);else writePending('sale',null);
  state.pending=value;updateSaleButtons();}
function pendingOperation(kind,name,payload){
  const previous=readPending(kind);
  if(previous)throw Error('توجد عملية مالية غير مؤكدة؛ أعد نفس العملية المعلقة أولاً');
  writePending(kind,{name,payload});updatePendingOpButtons();
  return retryOperation(kind);
}
async function retryOperation(kind){
  const pending=readPending(kind);if(!pending)throw Error('لا توجد عملية معلقة');
  if(!state.api?.signedIn)throw Error('يلزم تسجيل الدخول');
  let response;
  try{response=await state.api.rpc(pending.name,pending.payload);}
  catch(e){
    const msg=String(e&&e.message||e);
    // شرط المالك (الجولة 10): رد أعمال (برمز) ليس انقطاع شبكة — ولو قال نصه «Network unavailable».
    const sto=(e&&Number(e.status))||0;
    const net=!sto&&(/aborted|Failed to fetch|fetch failed|network|timeout/i.test(msg)||!netReady());
    if(net&&OFX_RPC[kind]){
      ofxQueue(kind,pending.payload,pending.payload?.p_event||crypto.randomUUID());
      writePending(kind,null);updatePendingOpButtons();
      showMessage('حُفظت العملية محليًا «بانتظار المزامنة» — مستند مؤقت حتى إقرار الخادم.','ok');
      return {provisional:true};
    }
    throw e;
  }
  writePending(kind,null);updatePendingOpButtons();return response;
}
function updatePendingOpButtons(){
  for(const [kind,submit,retry] of [['collection','collectButton','retryCollection'],
    ['owner_debt','ownerDebtButton','retryOwnerDebt'],['owner_cash','ownerCashButton','retryOwnerCash']]){
    const has=!!readPending(kind);$(submit).disabled=has;$(retry).classList.toggle('hide',!has);
  }
}
function updateSaleButtons(){
  // 6أ/6ب: البيع دون اتصال مسموح فقط ضمن وردية مفتوحة مقرّة من الخادم وبلا انتهاء ترخيص معروف.
  const ownerReady=!(netReady()&&['checking','unverified','denied'].includes(state.ownerSessionState));
  const localPossible=(state.mode==='offline'&&!!localAccount()&&!!state.localShift&&!state.localShift.closing);
  const possible=(localPossible||(state.role==='worker'&&state.approved&&state.lease&&(!!state.shift||(!!state.localShift&&!state.localShift.closing)))||(state.role==='owner'&&state.sellerMode&&ownerReady&&state.approved&&state.lease&&!!state.shift))&&!state.readOnly;
  $('postSale').disabled=!possible||!!state.pending||state.saleSubmitting;
  const stickySale=$('postSaleSticky');if(stickySale){const off=!possible||!!state.pending||state.saleSubmitting;state.saleOff=off;state.saleOffReason=(state.mode==='offline'&&!state.localShift)?'افتح الوردية أولاً من شاشة الصندوق':(!possible?'البيع غير متاح الآن — تحقق من الوردية أو وضع بيع المالك':'');stickySale.disabled=false;stickySale.setAttribute('aria-disabled',String(off));stickySale.classList.toggle('is-off',off);}
  $('retryPending').classList.toggle('hide',!state.pending);
  $('retryPending').disabled=!((state.role==='worker'||state.sellerMode)&&state.approved&&state.lease);
  $('addItem').disabled=!possible;
  const gate=$('posGate');
  if(gate){
    const warning=state.sellerMode?(state.readOnly?'انتهى الترخيص؛ القراءة والتصدير فقط':!ownerReady||!state.lease?'يلزم استعادة جلسة بيع المالك؛ لم تُغلق ورديتك بسبب انتهاء الجلسة':!state.shift?'افتح وردية المالك من الشريط بالأعلى أولاً':state.pending?'توجد فاتورة معلّقة بنفس المعرّف؛ أعدها قبل بيع آخر':''):
      state.role!=='worker'?'البيع من حساب العامل المعتمد فقط':
      !state.approved?'اعتماد هذا الجهاز من المالك مطلوب قبل البيع':
      !state.lease?'جلسة العامل متوقفة؛ اطلب إعادة فتحها من المالك':
      state.readOnly?'انتهى الترخيص؛ القراءة والتصدير فقط':
      !state.shift&&!state.localShift?'الصندوق مغلق؛ افتح وردية واعتمدها المالك أولاً':
      state.localShift?.closing?'الوردية المحلية أُغلقت مؤقتاً؛ لا بيع جديد':
      state.pending?'توجد فاتورة معلّقة بنفس المعرّف؛ أعدها قبل بيع آخر':'';
    gate.textContent=warning;gate.classList.toggle('hide',!warning);
  }
  try{updateSaleFab();renderSaleGrid();}catch(e){}
}
function amount(stat,title,value){const box=el('div',null,'stat');box.append(el('div',title,'lbl'),el('div',value,'val'));stat.append(box);}
function row(main,detail='',action=null,label=''){
  const item=el('div',null,'list-row'),text=el('span');text.append(el('strong',main));
  if(detail)text.append(el('small',detail));item.append(text);
  if(action){const b=el('button',label,'btn sm ghost');b.type='button';b.onclick=action;item.append(b);}return item;
}
function opts(select,items,placeholder,label){
  const old=select.value;select.replaceChildren();const empty=el('option',placeholder);empty.value='';select.append(empty);
  for(const item of items){const option=el('option',label(item));option.value=item.id;select.append(option);}
  if(items.some(item=>item.id===old))select.value=old;
}
function renderCart(){
  const box=$('cart');box.replaceChildren();
  if(!state.cart.length)box.append(el('p','السلة فارغة','muted small'));
  state.cart.forEach((line,i)=>{
    const item=el('div',null,'list-row'),text=el('span');
    text.append(el('strong',`${line.name} × ${line.qty_milli/1000}`),
      el('small',cents(Math.round(line.price_cents*line.qty_milli/1000))));
    const controls=el('span');controls.style.display='flex';controls.style.gap='6px';controls.style.alignItems='center';
    const step=line.qty_milli%1000===0?1000:250;
    const minus=el('button','−','btn sm ghost'),plus=el('button','+','btn sm ghost'),del=el('button','إزالة','btn sm ghost');
    minus.type=plus.type=del.type='button';
    minus.onclick=()=>{line.qty_milli-=step;if(line.qty_milli<=0)state.cart.splice(i,1);renderCart();};
    plus.onclick=()=>handle(async()=>{
      const prod=state.products.find(x=>x.id===line.product_id);
      if(prod&&Number(prod.stock_milli||0)<line.qty_milli+step)throw Error('الكمية تتجاوز المخزون المتاح من الخادم');
      line.qty_milli+=step;renderCart();});
    del.onclick=()=>{state.cart.splice(i,1);renderCart();};
    controls.append(minus,plus,del);item.append(text,controls);box.append(item);});
  const total=cartTotal(state.cart);
  let paid=0;try{paid=moneyCents($('cashPaid').value);}catch{}
  $('saleTotals').textContent=`الإجمالي: ${cents(total)} • النقد: ${cents(paid)} • الدين: ${cents(Math.max(0,total-paid))}`;
  const sst=$('saleStickyTotal');if(sst)sst.textContent=cents(total);
  updateSaleButtons();
  updateSaleFab();renderSaleGrid();
}
// ===== شاشة البيع وفق النموذج المعتمد (شبكة أصناف + سلة عائمة + نافذة مراجعة) =====
function renderSaleGrid(){
  const out=$('saleGrid');if(!out)return;
  const sig=state.products.map(p=>p&&p.id).join(',')+'|'+(state.saleCat||'')+'|'+(($('saleSearch')||{}).value||'');
  if(out.dataset.sig===sig)return;
  out.dataset.sig=sig;
  out.replaceChildren();
  const term=String(($('saleSearch')||{}).value||'').trim().toLocaleLowerCase();
  const cat=state.saleCat||'';
  const list=state.products.filter(p=>p&&p.active!==false&&
    (!term||String(p.name||'').toLocaleLowerCase().includes(term)||String(p.barcode||'').toLocaleLowerCase().includes(term)||String(p.category||'').toLocaleLowerCase().includes(term))&&
    (!cat||p.category===cat));
  if(!list.length)out.append(el('p','لا أصناف مطابقة — جرّب كلمة أخرى','muted small'));
  const lowL=Number(state.msgSettings?.low_stock_milli||1000);
  for(const p of list.slice(0,90)){
    const row=el('div',null,'list-item');row.setAttribute('role','button');row.tabIndex=0;
    const stockN=Number(p.stock_milli||0);
    const low=stockN<=lowL;
    const inCart=state.cart.find(x=>x.product_id===p.id);
    const ico=el('div','📦','li-ico');ico.style.background='#e8eef6';
    const main=el('div',null,'li-main');
    main.append(el('div',String(p.name||'—'),'li-title'));
    const sub=el('div',null,'li-sub');
    sub.textContent=(p.category||'بقالة')+' · المتوفر: '+(stockN/1000)+' ';
    if(low)sub.append(el('span',stockN<=lowL/2?'نفد تقريبًا':'قارب النفاد',stockN<=lowL/2?'badge r':'badge a'));
    else sub.append(el('span','متوفر','badge g'));
    main.append(sub);
    const end=el('div',null,'li-end');
    end.append(el('div',fmtRy(Number(p.price_cents||0)/100)+' ر.ي','li-value'));
    const add=el('button',inCart?('✓ في السلة ('+(inCart.qty_milli/1000)+')'):'＋ أضف','mini-btn '+(inCart?'gold':'ghost'));
    add.type='button';add.style.marginTop='5px';
    end.append(add);
    row.append(ico,main,end);
    const doAdd=()=>{
      const step=1000;
      const line=state.cart.find(x=>x.product_id===p.id);
      const want=(line?line.qty_milli:0)+step;
      if(Number(p.stock_milli||0)<want){showMessage('الكمية تتجاوز المخزون المتاح','warn');return;}
      if(line)line.qty_milli+=step;
      else state.cart.push({product_id:p.id,name:p.name,price_cents:Number(p.price_cents||0),qty_milli:step});
      renderCart();renderSaleGrid();
      try{navigator.vibrate&&navigator.vibrate(10)}catch{}
    };
    add.onclick=(e)=>{e.stopPropagation();doAdd();};
    row.onclick=doAdd;
    row.onkeydown=(e)=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();doAdd();}};
    out.append(row);
  }
  const bar=$('saleCatsBar');
  if(bar){
    const cats=['',...new Set(state.products.map(x=>x.category).filter(Boolean).sort())];
    const sigC=cats.join('|')+'|'+(state.saleCat||'');
    if(bar.dataset.sig!==sigC){
      bar.dataset.sig=sigC;
      bar.replaceChildren();
      for(const c of cats){
        const b=el('button',c||'الكل','chip'+((state.saleCat||'')===c?' on':''));
        b.type='button';
        b.onclick=()=>{state.saleCat=c;renderSaleGrid();
          for(const x of bar.querySelectorAll('.chip'))x.classList.remove('on');
          b.classList.add('on');};
        bar.append(b);
      }
    }
  }
}
function fmtRy(n){return Math.round(Number(n)||0).toLocaleString('en-US');}
function updateSaleFab(){
  const lbl=$('saleFabLabel');
  if(lbl)lbl.textContent=state.cart.length?`السلة (${state.cart.length})`:'السلة فارغة';
  const cc=$('cartCount');
  if(cc)cc.textContent=String(state.cart.reduce((a,x)=>a+Math.round(x.qty_milli/1000),0));
  const fab=$('postSaleSticky');
  if(fab)fab.classList.toggle('hide',!state.cart.length);
}
function openSaleReview(){
  if(!state.cart.length){showMessage('السلة فارغة — اضغط على الأصناف لإضافتها','ok');return;}
  const sh=$('saleReview');if(!sh)return;
  sh.classList.remove('hide');
  renderReviewLines();
  const cash=$('cashPaid');
  if(modeIsCredit())setSaleMode('credit');else setSaleMode('cash');
}
function closeSaleReview(){const sh=$('saleReview');if(sh)sh.classList.add('hide');}
{const cs=$('cancelSale');if(cs)cs.onclick=()=>closeSaleReview();}
function modeIsCredit(){return !!($('modeCredit')&&$('modeCredit').classList.contains('on'));}
function setSaleMode(mode){
  const cashBtn=$('modeCash'),credBtn=$('modeCredit');
  if(cashBtn)cashBtn.classList.toggle('on',mode==='cash');
  if(credBtn)credBtn.classList.toggle('on',mode==='credit');
  const wrap=$('rsCustomerWrap'),cust=$('saleCustomer'),cash=$('cashPaid');
  if(wrap)wrap.classList.toggle('hide',mode!=='credit');
  if(mode==='cash'){
    if(cust)cust.value='';
    if(cash)cash.value=(cartTotal(state.cart)/100).toFixed(2);
  }else{
    if(cash)cash.value='0';
    if(cust&&cust.options.length>1&&!cust.value)cust.focus();
  }
  renderCart();
}
function renderReviewLines(){
  const out=$('reviewLines');if(!out)return;
  out.replaceChildren();
  if(!state.cart.length){out.append(el('p','السلة فارغة','muted small'));return;}
  state.cart.forEach((line,i)=>{
    const row=el('div',null,'total-row');
    const left=el('div',null,'');left.style.flex='1';
    left.append(el('div',String(line.name||'—'),''),'');
    left.children[0].style.fontWeight='800';
    const qn=line.qty_milli/1000;
    left.append(el('div',fmtRy(Number(line.price_cents||0)/100)+' × '+(Number.isInteger(qn)?qn:qn.toFixed(2)),'li-sub'));
    const ctr=el('div',null,'qty');
    const step=line.qty_milli%1000===0?1000:250;
    const minus=el('button','−',''),plus=el('button','＋',''),b=el('b',String(Number.isInteger(qn)?qn:qn.toFixed(2)),'');
    minus.type=plus.type='button';
    minus.onclick=()=>{line.qty_milli-=step;if(line.qty_milli<=0)state.cart.splice(i,1);renderCart();renderReviewLines();};
    plus.onclick=()=>handle(async()=>{
      const prod=state.products.find(x=>x.id===line.product_id);
      if(prod&&Number(prod.stock_milli||0)<line.qty_milli+step)throw Error('الكمية تتجاوز المخزون المتاح');
      line.qty_milli+=step;renderCart();renderReviewLines();});
    ctr.append(minus,b,plus);
    const val=el('div',fmtRy(Math.round(line.price_cents*line.qty_milli/1000)/100),'');
    val.style.cssText='width:86px;text-align:left;font-weight:900';
    row.append(left,ctr,val);
    out.append(row);
  });
  const t=el('div',null,'total-row grand');
  t.append(el('span','الإجمالي',''),el('span',fmtRy(cartTotal(state.cart)/100)+' ريال',''));
  out.append(t);
  const ps=$('postSale');if(ps&&ps.tagName==='BUTTON')ps.textContent='تأكيد البيع — '+fmtRy(cartTotal(state.cart)/100)+' ريال';
}
function searchCatalog(query){
  const term=String(query||'').trim().toLocaleLowerCase();
  return state.products.filter(p=>p&&p.active!==false&&(
    !term||String(p.name||'').toLocaleLowerCase().includes(term)||String(p.category||'').toLocaleLowerCase().includes(term)||
    String(p.barcode||'').toLocaleLowerCase().includes(term)));
}
function renderCatalog(){
  const out=$('catalogList');out.replaceChildren();
  const IF=state.catalogFilter||'all';
  const dl=$('categoryList');if(dl){dl.replaceChildren();for(const c of [...new Set(state.products.map(x=>x.category).filter(Boolean))].sort()){const o=el('option');o.value=c;dl.append(o);}}
  let matches=searchCatalog($('catalogSearch').value);
  if(IF==='low')matches=matches.filter(p=>Number(p.stock_milli||0)<=Number(state.msgSettings?.low_stock_milli||1000));
  if(IF==='exp')matches=matches.filter(p=>{if(!p.expiry_date)return false;return (new Date(p.expiry_date)-Date.now())/864e5<=30;});
  let pending=0;try{const b=bridge();if(b)pending=queuedOps(b).filter(o=>sameStoreOp(o)&&
    ['product','stock_adjust'].includes(o.kind)).length;}catch{}
  const uncertain=state.offlineNow||state.serverDown;
  $('catalogStatus').textContent=`${state.products.length} صنف • ${uncertain?'آخر نسخة على الهاتف؛ الرصيد يحتاج إقرار الخادم':'بيانات الخادم'}${pending?` • ${pending} عملية مخزون بانتظار المزامنة`:''}`;
  if(!matches.length){const empty=el('div',null,'empty-state');empty.append(el('span',state.products.length?'⌕':'▦','empty-icon'),el('strong',state.products.length?'لا توجد نتيجة للبحث':'قائمة الأصناف فارغة'),el('p',state.products.length?'جرّب الاسم أو الباركود أو التصنيف.':'أضف أول صنف لتبدأ تنظيم المخزون.','muted small'));if(!state.products.length&&state.role==='owner'){const add=el('button','＋ إضافة أول صنف','btn p');add.type='button';add.onclick=()=>goTo('products','productName');empty.append(add);}out.append(empty);}
  for(const p of matches.slice(0,300)){
    const line=el('div',null,'rowline'),info=el('div',null,'who'),stock=el('div',null,'stock-info');
    info.append(el('div',p.name,'nm'),el('div',p.barcode?`باركود: ${p.barcode}`:`الوحدة: ${p.unit||'حبة'}`,'sub'));
    if(p.category)info.append(el('div',`النوع: ${p.category}`,'sub'));
    const expM=(state.expiring||[]).filter(x=>x.product_id===p.id&&x.expired).reduce((t,x)=>t+Number(x.qty_milli||0),0);
    stock.append(el('strong',cents(p.price_cents)),el('small',`الرصيد ${Number(p.stock_milli||0)/1000}${expM>0?` • منه ${expM/1000} منتهٍ`:''}${uncertain?' • غير مؤكد':''}`));
    if(p.expiry_date){const ex=el('small',`الصلاحية: ${p.expiry_date}`,'sub');if(p.expiry_date<new Date().toISOString().slice(0,10))ex.style.color='#b91c1c';stock.append(ex);}
    {const stockN=Number(p.stock_milli||0),lowL=Number(state.msgSettings?.low_stock_milli||1000);
      if(stockN<=lowL)stock.append(el('span',stockN<=lowL/2?'شبه منتهٍ':'قارب النفاد',stockN<=lowL/2?'m-badge r':'m-badge a'));
      if(p.expiry_date){const dd=(new Date(p.expiry_date)-Date.now())/864e5;
        if(dd<=30)stock.append(el('span',dd<=0?'انتهت الصلاحية':'صلاحية قريبة',dd<=0?'m-badge r':'m-badge a'));}}
    if(p.barcode){const lb=el('button','🏷 ملصق','btn sm ghost');lb.type='button';lb.onclick=()=>printLabels([p]);line.append(lb);}
    line.append(info,stock);out.append(line);
  }
}
function renderProductMatches(){
  const box=$('productMatches');box.replaceChildren();
  const text=$('productSearch').value.trim();
  if(!text){box.classList.add('hide');return;}
  const matches=searchCatalog(text).slice(0,12);
  for(const p of matches){
    const b=el('button',`${p.name} • ${cents(p.price_cents)}${p.barcode?' • '+p.barcode:''}`);
    b.type='button';b.onclick=()=>{$('saleProduct').value=p.id;$('productSearch').value='';$('productMatches').classList.add('hide');blurActive();
    showMessage(`${p.name} — اختر الكمية ثم «+ أضف إلى السلة»`,'ok');
      box.classList.add('hide');$('productSearch').blur();};box.append(b);
  }
  if(!matches.length){box.append(el('div','الصنف غير موجود في متجر رفيق','muted small'));
    const db=el('button',`📝 سجّل «${text}» كطلب احتياج لتوفيره`,'btn sm ghost');db.type='button';
    db.onclick=()=>{box.classList.add('hide');goTo('products');const dn=$('demandName');
      if(dn){dn.value=text;dn.focus();if(dn.scrollIntoView)dn.scrollIntoView({behavior:'smooth',block:'center'});}};
    box.append(db);}
  box.classList.remove('hide');
}

async function loadExpiring(){
  if(!state.api?.signedIn||!state.store)return;
  try{
    const rows=await state.api.rpc('rfq_pilot_expiring_batches',{p_store:state.store,p_days:30});
    state.expiring=Array.isArray(rows)?rows:[];
  }catch{state.expiring=state.expiring||[];}
  renderExpiringCard();
}
function renderExpiringCard(){
  const box=$('expiringTable');if(!box)return;
  const rows=state.expiring||[];
  box.replaceChildren();
  if(!rows.length){box.append(el('p','لا دفعات تقارب الانتهاء خلال 30 يومًا.','muted small'));return;}
  const t=el('table',null,'log');const hr=el('tr');
  for(const h of ['الصنف','الكمية','تاريخ الصلاحية','الحالة'])hr.append(el('th',h));
  t.append(hr);
  for(const r of rows.slice(0,30)){
    const tr=el('tr');
    tr.append(el('td',r.name),el('td',String(Number(r.qty_milli||0)/1000)),
      el('td',(r.expiry_date||'').slice(0,10)),el('td',r.expired?'منتهية':'تقارب الانتهاء'));
    if(r.expired)tr.style.color='#b91c1c';
    t.append(tr);
  }
  box.append(t);
}

function renderProducts(){
  if(state.offlineNow&&bridge()){const rows=mirrorRows(state.store+':products');if(rows.length)state.products=rows;}
  const active=state.products.filter(p=>p.active!==false);
  opts($('saleProduct'),active,'اختر صنفاً',p=>`${p.name} — ${cents(p.price_cents)} (متاح: ${Number(p.stock_milli||0)/1000})`);
  opts($('adjustProduct'),active,'اختر صنفاً',p=>`${p.name} — الرصيد ${Number(p.stock_milli||0)/1000}`);
  renderCatalog();renderProductMatches();
}
async function showCustomerBalance(item){
  const panel=$('customerBalancePanel');panel.classList.remove('hide');
  if(!navigator.onLine||state.serverDown){
    panel.textContent=`${item.name}: لا يمكن تأكيد رصيد الدين دون اتصال بالخادم؛ لا نعرض رقماً قديماً كأنه مؤكد.`;
    return;
  }
  panel.textContent=`${item.name}: جارٍ قراءة رصيد الدين من الخادم…`;
  const id=item.id;
  try{
    const raw=await state.api.rpc('rfq_pilot_customer_balance',{
      p_store:state.store,p_device:state.device,p_customer:id});
    const amount=Number(raw);
    if(!Number.isSafeInteger(amount))throw Error('رصيد غير صالح من الخادم');
    if(state.store&&state.customers.some(c=>c.id===id)){
      panel.textContent=`${item.name} • الرصيد المؤكد من الخادم: ${cents(amount)}`;
      panel.append(customerPhotoSection(item,id));
    }
  }catch(e){panel.textContent=`${item.name}: لم يُتحقق من رصيد الدين؛ ${e.message||'حاول مرة أخرى'}`;}
}
// أمر المالك (129): قسم الصورة مطوي دائمًا — لا حقل ملف ظاهر مع كل عرض دين،
// والاختيار يعرض معاينة فقط ولا يُكتب شيء قبل ضغط «حفظ الصورة».
function customerPhotoSection(item,id){
  const wrap=el('div',null,'mt');
  const toggle=el('button','📷 صورة الزبون (اختياري)','btn sm ghost');toggle.type='button';
  const box=el('div',null,'hide mt');
  const preview=el('img');preview.className='avatar hide';preview.alt='صورة الزبون';
  const pf=el('input');pf.type='file';pf.accept='image/*';pf.className='hide';
  const choose=el('button','اختر صورة من الهاتف','btn sm ghost');choose.type='button';
  const save=el('button','حفظ الصورة','btn sm p');save.type='button';save.disabled=true;
  const cancel=el('button','إغلاق','btn sm ghost');cancel.type='button';
  let pending='';
  // 130: الصورة المحفوظة تظهر فورًا — لا انتظار فتح الصندوق ولا إعادة تشغيل.
  if(item.photo){preview.src=item.photo;preview.classList.remove('hide');}
  toggle.onclick=()=>{
    const opening=box.classList.contains('hide');
    box.classList.toggle('hide');
    if(opening&&!box.dataset.loaded){box.dataset.loaded='1';
      handle(async()=>{
        const rows=await state.api.table('rfq_pilot_customers',
          {id:`eq.${id}`,store_id:`eq.${state.store}`,select:'photo',limit:'1'});
        if(rows?.[0]?.photo){preview.src=rows[0].photo;preview.classList.remove('hide');item.photo=rows[0].photo;}
      });}
  };
  choose.onclick=()=>pf.click();
  pf.onchange=()=>handle(async()=>{
    if(!pf.files?.[0])return;
    pending=await fileToDataUrl(pf.files[0],160);
    preview.src=pending;preview.classList.remove('hide');save.disabled=false;
    showMessage('هذه معاينة فقط — اضغط «حفظ الصورة» للتأكيد','ok');});
  save.onclick=()=>handle(async()=>{
    if(!pending)return;
    await state.api.rpc('rfq_pilot_set_customer_photo',{p_store:state.store,p_customer:id,p_photo:pending});
    item.photo=pending;pending='';pf.value='';save.disabled=true;save.textContent='✓ حُفظت الصورة';
    setTimeout(()=>{save.textContent='حفظ الصورة';},1600);
    showMessage('حُفظت صورة الزبون','ok');});
  cancel.onclick=()=>{pending='';pf.value='';save.disabled=true;box.classList.add('hide');};
  box.append(el('p','الصورة تُحفظ فقط بعد الضغط على «حفظ الصورة».','muted small'),
    preview,choose,pf,save,cancel);
  wrap.append(toggle,box);
  return wrap;
}
function renderCustomers(){
  if(state.offlineNow&&bridge()){const rows=mirrorRows(state.store+':customers');if(rows.length)state.customers=rows;}
  const active=state.customers.filter(x=>x.active);
  for(const id of ['saleCustomer','collectionCustomer','debtCustomer'])opts($(id),active,'اختر زبوناً',x=>`${x.name}${x.phone?' — '+x.phone:''}`);
  const list=$('customerList');list.replaceChildren();
  if(!active.length)list.append(el('p','لا يوجد زبائن في المتجر بعد.','muted'));
  const CF=state.debtFilter||'all';
  let showList=active;
  if(CF==='follow')showList=active.filter(x=>Number(state.customerDebt?.[x.id]||0)>0);
  if(CF==='clear')showList=active.filter(x=>!(Number(state.customerDebt?.[x.id]||0)>0));
  if(CF!=='all'&&!state.__debtsLoaded)list.append(el('p','جارٍ قراءة الأرصدة… اضغط الفلتر مجددًا بعد لحظات.','muted small'));
  for(const item of showList){
    const line=row(item.name,item.phone||'دون هاتف',()=>showCustomerBalance(item),'عرض الدين');
    if(item.photo){const av=el('img');av.className='avatar row-avatar';av.src=item.photo;av.alt='صورة '+item.name;line.prepend(av);}
    const stmt=el('button','كشف حساب وطباعة','btn sm ghost');stmt.type='button';
    stmt.onclick=()=>handle(()=>printCustomerStatement(item));
    line.append(stmt);
    if(state.role==='owner'){
      const pref=state.msgPrefs[item.id]||{enabled:true,consent:false};
      const msgBtn=el('button',pref.consent&&pref.enabled?'الرسائل: مفعّلة':'الرسائل: موقوفة','btn sm ghost');msgBtn.type='button';
      msgBtn.onclick=()=>handle(async()=>{
        const next=!(pref.consent&&pref.enabled);
        await state.api.rpc('rfq_pilot_set_customer_message_pref',{p_store:state.store,p_customer:item.id,
          p_enabled:next,p_consent:next});
        state.msgPrefs[item.id]={enabled:next,consent:next};renderCustomers();
        showMessage(next?'فُعّلت رسائل هذا الزبون بموافقته الموثقة':'أُوقفت رسائل هذا الزبون','ok');});
      line.append(msgBtn);
    }
    list.append(line);
  }
}
function statementDom(d,target){
  // كشف حساب الزبون: كل الأرقام من الخادم؛ لا رصيد محلي يُعرض كأنه مؤكد.
  // 130b — طلب المالك: «أي كشف لا يظهر بشكل دش» = الجدول الكلاسيكي فقط بلا صناديق؛ والطباعة الجدول فقط.
  const isPrint=target===$('printArea');
  const out=target||$('printArea');if(isPrint)out.className='';out.replaceChildren();
  out.append(el('h1',storeTitle()),
    el('p',`كشف حساب: ${d.customer_name}${d.customer_phone?' • '+d.customer_phone:''}`),
    el('p','تاريخ الكشف: '+new Date(d.generated_at||Date.now()).toLocaleString('ar-YE')));
  const table=el('table'),head=el('tr');
  for(const cell of ['التاريخ','المستند','عليه (دين)','دفع/إلغاء','الرصيد بعده'])head.append(el('th',cell));
  table.append(head);
  const labels={invoice_due:'فاتورة',owner_debit:'دين يدوي',collection:'تحصيل',invoice_void:'إلغاء فاتورة',collection_void:'عكس تحصيل',sales_return:'مرتجع بيع',sales_return_void:'إلغاء مرتجع'};
  for(const e of d.entries||[]){
    const isDebit=e.kind==='invoice_due'||e.kind==='owner_debit'||e.kind==='collection_void'||e.kind==='sales_return_void';
    const tr=el('tr');
    tr.append(el('td',new Date(e.at).toLocaleDateString('ar-YE')),
      el('td',(labels[e.kind]||e.kind)+(e.ref?' '+e.ref:'')),
      el('td',isDebit?cents(e.amount_cents):''),
      el('td',isDebit?'':cents(-e.amount_cents)),
      el('td',cents(e.balance_after_cents||0)));
    table.append(tr);
  }
  out.append(table);
  // أصناف الفواتير: على الشاشة فقط كجدول عادي — والطباعة الجدول فقط «بدون دش»
  if(!isPrint&&(d.invoices||[]).some(i=>(i.lines||[]).length)){
    const items=el('details',null,'stmt-items');
    items.append(el('summary','أصناف الفواتير'));
    const it=el('table'),ih=el('tr');
    for(const cell of ['فاتورة','الصنف','الكمية','السعر','المجموع'])ih.append(el('th',cell));
    it.append(ih);
    for(const inv of d.invoices||[])for(const l of inv.lines||[]){
      const tr=el('tr');
      tr.append(el('td',String(inv.number)+(inv.voided?' (ملغاة)':'')),
        el('td',l.name),el('td',String(l.qty_milli/1000)),el('td',cents(l.price_cents)),el('td',cents(l.total_cents)));
      it.append(tr);
    }
    items.append(it);out.append(items);
  }
  out.append(
    el('p',`إجمالي الدين: ${cents(d.debit_cents)}`),
    el('p',`إجمالي المسدد والملغى: ${cents(d.credit_cents)}`),
    el('p',`الرصيد المستحق: ${cents(d.balance_cents)}`,'print-total'),
    el('p','كشف تجريبي مقروء من الخادم؛ ليس مستنداً ضريبياً.'));
}
async function printCustomerStatement(item){
  assertOnlineStatement();
  const d=await state.api.rpc('rfq_pilot_customer_statement',{p_store:state.store,p_customer:item.id});
  if(!d||typeof d.balance_cents!=='number')throw Error('كشف الحساب غير مكتمل من الخادم؛ لم يُطبع شيء');
  const panel=$('statementPanel');
  if(!panel){statementDom(d);printPage();return;}
  panel.classList.remove('hide');
  statementDom(d,panel);
  if(item.photo){const av=el('img');av.className='avatar stmt-avatar';av.src=item.photo;av.alt='صورة الزبون';panel.prepend(av);}
  const btns=el('div',null,'row wrap mt');
  const pr=el('button','🖨 طباعة / حفظ PDF','btn p');pr.type='button';
  pr.onclick=()=>{statementDom(d,$('printArea'));$('printInvoice').hidden=false;
    if(item.photo){const av2=el('img');av2.className='avatar stmt-avatar';av2.src=item.photo;$('printArea').prepend(av2);}
    printPage();};
  const cl=el('button','إغلاق الكشف','btn sm ghost');cl.type='button';
  cl.onclick=()=>{panel.classList.add('hide');panel.replaceChildren();};
  btns.append(pr,cl);panel.append(btns);
  panel.scrollIntoView({behavior:'smooth',block:'start'});
}
function assertOnlineStatement(){
  if(!netReady())throw Error('كشف الحساب يحتاج اتصالاً بالخادم؛ لا نعرض رصيداً محلياً كأنه مؤكد');
}
function receiptDom(value,lines){
  const out=$('printArea');out.className='receipt';out.replaceChildren();
  if(state.storeProfile?.logo){const im=el('img');im.src=state.storeProfile.logo;im.className='print-logo';out.append(im);}
  out.append(el('h1',storeTitle()),
    el('p',(value.provisional?'فاتورة مؤقتة (رقمها من الخادم بعد الإقرار)':'فاتورة رقم '+value.number)+' • '+new Date().toLocaleString('ar-YE')));
  const table=el('table'),head=el('tr');for(const cell of ['الصنف','الكمية','السعر','المجموع'])head.append(el('th',cell));table.append(head);
  for(const l of lines){const tr=el('tr');for(const text of [l.name,String(l.qty_milli/1000),cents(l.price_cents),cents(Math.round(l.price_cents*l.qty_milli/1000))])tr.append(el('td',text));table.append(tr);}
  const tail=[el('p',`الإجمالي ${cents(value.total_cents)}`,'print-total')];
  if(value.cash_paid_cents!=null&&Number(value.cash_paid_cents)>0)tail.push(el('p',`دُفع نقدًا: ${cents(value.cash_paid_cents)}`));
  if(Number(value.other_paid_cents||0)>0)tail.push(el('p',`دُفع ${value.other_method==='transfer'?'بحوالة':'بمحفظة إلكترونية'}: ${cents(value.other_paid_cents)}`));
  tail.push(el('p',`الدين ${cents(value.due_cents)}`));
  if(value.provisional)tail.push(el('p','مستند مؤقت — بانتظار المزامنة — ليس إقرارًا من الخادم ولا فاتورة خوادم مؤكدة.'));
  if(value.localId)tail.push(el('p',`مرجع العملية على الهاتف: ${value.localId}`));
  tail.push(el('p','فاتورة تجريبية؛ ليست إشعار سداد أو مستند ضريبي.'));
  out.append(table,...tail);
}
function collectionReceiptDom(v){
  // وصل تحصيل صادق: مؤقت حتى إقرار الخادم، أو مؤكد منه — لا حالة ثالثة
  const out=$('printArea');out.className='receipt';out.replaceChildren();out.append(el('h1',storeTitle()),
    el('p','وصل تحصيل دين — '+new Date().toLocaleString('ar-YE')));
  out.append(el('p',v.provisional?'وصل مؤقت — بانتظار المزامنة — ليس إقرارًا من الخادم.':'تحصيل مؤكد من الخادم.'),
    el('p',`الزبون: ${v.customer}`),el('p',`المبلغ: ${cents(v.amount_cents)}`),
    el('p',v.local?'ضمن وردية محلية مؤقتة (تُربط بوردية الخادم بعد اعتماد المالك).':'ضمن وردية الخادم.'),
    el('p','وصل اختباري؛ ليس مستندًا ضريبيًا.'));
  $('printInvoice').hidden=false;
}
function recordLocalDecision(opId,kind,decision,note){
  // سجل قرارات المالك المحلية على الهاتف — يبقى بعد إعادة الفتح ويعرض للمالك «بانتظار التوثيق»
  // يُرجئ تغيير حالة العملية حتى يثبت حفظ السجل: فشل الحفظ = لا قرار ولا إلغاء
  const b=bridge();if(!b)return false;const key='owner_local_decisions:'+state.store;
  let j=[];try{j=JSON.parse(b.metaGet(key)||'[]');}catch{}
  j.push({op:opId,kind,decision,note,at:new Date().toISOString(),anchor:state.api?.lastServerDate||''});
  const ser=JSON.stringify(j);
  try{b.metaSet(key,ser);}catch{return false;}
  return b.metaGet(key)===ser; // ثبوت الحفظ بالقراءة بعد الكتابة
}
function decisionsStorageOk(){
  const b=bridge();if(!b)return false;const k='owner_decisions_probe:'+state.store;
  try{const prev=b.metaGet(k);b.metaSet(k,'probe');const ok=b.metaGet(k)==='probe';b.metaSet(k,prev);return ok;}catch{return false;}
}
function renderInvoice(value,lines){
  state.invoice=value;state.invoiceLines=lines;
  try{ if(typeof window.RafiqSaleEvent==='function') window.RafiqSaleEvent(value,state.lastSaleMeta||null); }catch(e){}
  $('latestInvoice').textContent=`${value.provisional?'فاتورة مؤقتة — بانتظار المزامنة':'الفاتورة '+value.number}\nالإجمالي ${cents(value.total_cents)}\nالدين ${cents(value.due_cents)}`;
  $('printInvoice').hidden=false;const rb0=$('returnLatestBtn');if(rb0)rb0.hidden=!!value.provisional;receiptDom(value,lines);
}
function renderDevice(status){
  const box=$('devicePanel'),ownerArea=$('ownerDevices');box.replaceChildren();if(ownerArea){ownerArea.replaceChildren();box.append(ownerArea);}const statusLabel=status==='approved'?'معتمد':status==='pending'?'بانتظار موافقة المالك':'مرفوض';
  const head=el('div',null,'row'),data=el('div');data.append(el('strong',`${embedded?'هاتف رفيق Android':'جهاز الويب'}: ${statusLabel}`),
    el('p',state.role==='worker'?'البيع محجوب حتى اعتماد الجهاز والوردية وجلسة العامل.':'مالك المتجر يستطيع اعتماد الجهاز وتجهيز الأصناف ومراجعة الوردية.'));
  head.append(data);const b=el('button','تحديث حالة الجهاز','btn sm ghost');b.onclick=()=>refresh().catch(err=>showMessage(err.message));head.append(b);box.append(head);
  updateDeviceNotice(status);
  if(state.role==='owner'){const area=$('ownerDevices');if(area)loadOwnerDevices().catch(e=>{area.textContent=friendlyError(String(e.message||e));});}
  if(state.role==='worker'&&status==='approved'&&!state.lease){
    // P3: actionable wording (owner now has a close-session button; P1).
    box.append(el('p','الحساب مشغول بجلسة عامل أخرى، أو انتهت جلسة هذا المتصفح. اطلب إغلاقها من المالك عبر زر «إغلاق جلسة» في بطاقة الورديات، أو اضغط «إعادة فتح جلسة البيع» بعد إذن المالك.','flash error'));
    // P2: manual recovery without a full re-login.
    const rb=el('button','إعادة فتح جلسة البيع','btn sm ghost');
    rb.onclick=()=>handle(async()=>{await requestDevice();await refresh();});
    box.append(rb);
  }
}
async function requestDevice(){
  // A kind label is useful for owner approval, but is NOT proof of SIM hardware.
  const kind=embedded?(state.role==='owner'?'owner_phone':'cashier_phone'):'web';
  const status=await state.api.rpc('rfq_pilot_request_device',{p_store:state.store,p_device:state.device,p_kind:kind});
  if(state.role==='owner'&&status==='pending'){
    try{await state.api.rpc('rfq_pilot_approve_device',{p_store:state.store,p_device:state.device});
      state.approved=true;state.deviceLimit=false;
    }catch(e){
      if(!String(e.message||e).includes('device_limit_reached'))throw e;
      state.approved=false;state.deviceLimit=true;
    }
  }else state.approved=status==='approved';
  renderDevice(state.approved?'approved':status);
  if(state.role==='worker'&&state.approved){
    try{await state.api.rpc('rfq_pilot_claim_worker',{p_store:state.store,p_device:state.device});state.lease=true;}
    catch(e){state.lease=false;showMessage(`لا يمكن فتح جلستين للعامل: ${e.message}`);}
  }
  updateSaleButtons();
}
async function safeRefresh(){
  // «الجهاز متصل» ≠ «الخادم متاح»: فشل الخادم المؤقت حالة معروضة بصدق، لا شاشة دخول ولا صمت
  try{state.serverDown=false;await refresh();}
  catch(e){
    const msg=String(e&&e.message||e);
    // الجولة 8+9: كل 5xx و429 برمز الاستجابة = خادم ساقط مؤقتًا (حتى «Internal Server Error» بلا
    // كلمات معروفة) → المرآة تُعرض؛ النص يُعتبر فقط بلا رمز (شبكة). رد أعمال 400 يُعاد كما هو.
    const sts=(e&&Number(e.status))||0;
    if(sts>=500||sts===429||(!sts&&/Failed to fetch|fetch failed|network|timeout|aborted|HTTP 5|503|502|504|unavailable/i.test(msg))){
      state.serverDown=true;
      showMessage('الجهاز متصل بالشبكة لكن خادم الاختبار غير متاح الآن — المعروض نسخة محلية، وكل عملية «بانتظار المزامنة»، ولا شيء معروض كمؤكد من الخادم.','ok');
      renderFromMirror();renderOfflineCenter();updateSaleButtons();
    }else throw e;
  }
}
// Explicit catalog fields: purchase cost is never requested from the shared table.
const CATALOG_PUBLIC_COLUMNS='id,store_id,name,barcode,unit,category,price_cents,stock_milli,active,expiry_date,created_at,updated_at';
async function readVisibleCatalog(){
  const store=state.store,role=state.role,user=state.user?.id;
  const products=await state.api.table('rfq_pilot_products',{
    store_id:`eq.${store}`,active:'eq.true',select:CATALOG_PUBLIC_COLUMNS,order:'name.asc',limit:'300'});
  if(role!=='owner')return products;
  // Server rechecks the authenticated live owner, even if JS role is tampered with.
  const costs=await state.api.rpc('rfq_pilot_owner_product_costs',{p_store:store});
  if(state.store!==store||state.role!=='owner'||state.user?.id!==user)throw Error('تغيّر الحساب أثناء قراءة الأصناف؛ حدّث الشاشة');
  const byId=new Map(costs.map(p=>[p.id,p.cost_cents]));
  return products.map(p=>({...p,cost_cents:byId.get(p.id)}));
}
async function refresh(){
  if(!state.api?.signedIn)return;
  const fresh=!$('homeView').children.length&&state.role==='owner';if(fresh)workspaceFeedback('نقرأ الأصناف والأرصدة من الخادم نفسه…');
  loadExpiring().catch(()=>{});
  state.offlineNow=state.mode!=='offline'&&!navigator.onLine;
  if(netReady())syncAll().catch(()=>{});
  if(!netReady()){renderFromMirror();renderOfflineCenter();updateSaleButtons();return;}
  try{const lic=await state.api.rpc('rfq_pilot_license_current',{p_store:state.store});if(typeof lic==='boolean')state.readOnly=!lic;}catch{}
  const ban=$('licenseBanner');if(ban){ban.textContent=state.readOnly?'الترخيص منتهٍ على الخادم: قراءة وتصدير فقط — العمليات الجديدة موقوفة حتى التجديد.':'';ban.classList.toggle('hide',!state.readOnly);}
  if(state.role==='worker'&&state.lease){
    try{await state.api.rpc('rfq_pilot_heartbeat',{p_store:state.store,p_device:state.device});}
    catch(e){
      // P2: transient heartbeat failure must not kill the lease permanently;
      // try a single re-claim (server guard still enforces one worker session).
      try{await state.api.rpc('rfq_pilot_claim_worker',{p_store:state.store,p_device:state.device});}
      catch(e2){state.lease=false;state.shift=null;showMessage(`توقفت جلسة البيع: ${e.message}`);}
    }
  }
  const devices=await state.api.table('rfq_pilot_devices',{
    store_id:`eq.${state.store}`,id:`eq.${state.device}`,select:'id,status',limit:'1'});
  state.approved=devices[0]?.status==='approved';renderDevice(devices[0]?.status||'revoked');
  if(state.role==='worker'&&!state.lease&&state.approved){
    // إصلاح 123: سقوط الإيجار محليًا يُستعاد تلقائيًا بمطالبة جديدة (الخادم يفرض جلسة عامل واحدة حية).
    try{await state.api.rpc('rfq_pilot_claim_worker',{p_store:state.store,p_device:state.device});state.lease=true;}catch{}
  }
  if(state.role==='worker'&&(!state.lease||!state.approved)){
    state.shift=null;renderWorker();updateSaleButtons();return;
  }
  const [products,customers]=await Promise.all([
    readVisibleCatalog(),
    state.api.table('rfq_pilot_customers',{store_id:`eq.${state.store}`,active:'eq.true',select:'id,name,phone,active',order:'name.asc',limit:'300'}),
  ]);
  state.products=products;state.customers=customers;workspaceFeedback('');
  refreshDynProductSelects();
  loadSuppliers().catch(()=>{});renderDemands().catch(()=>{});
  loadStoreProfile().catch(()=>{});loadMyProfile().catch(()=>{}).finally(renderDrawerIdentity);
  loadMyMsgLog().catch(()=>{});
  try{
    state.msgSettings=await state.api.rpc('rfq_pilot_get_message_settings',{p_store:state.store});
    state.msgPrefs=await state.api.rpc('rfq_pilot_get_customer_message_prefs',{p_store:state.store});
    state.voiceApproved=state.role==='owner'?true:await state.api.rpc('rfq_pilot_voice_my',{p_store:state.store});
  }catch{/* إعدادات الرسائل/الصوت إضافية؛ لا تكسر البيع */}
  renderProducts();renderCustomers();renderCart();fillReportCustomers();
  if(state.role==='owner'&&state.sellerMode&&!state.readOnly){
    try{await ensureOwnerSellerSession();}
    catch(e){showMessage(`تعذّر استعادة جلسة بيع المالك: ${friendlyError(String(e.message||e))}. لم تُغلق ورديتك ولم تُسجّل فاتورة جديدة.`);}
    updateSellerBar();updateSaleButtons();
  }
  if(state.role==='owner')await renderOwner();else await renderWorker();
  pumpSms().catch(()=>{});
  // The SMS migration is not installed on this store. Do not query those missing
  // tables during refresh: doing so made a successful customer/product save look broken.
  try{localStorage.setItem('rafiq-worker-state-v1',JSON.stringify({userId:state.user?.id,store:state.store,
    approved:state.approved,lease:state.lease,shift:state.shift,at:state.api?.lastServerDate||''}));}catch{}
  // SMS dispatch is not part of this release or the owner's authorisation.
}
async function renderWorker(){
  const home=$('homeView'),shiftBox=$('shiftList');home.replaceChildren();shiftBox.replaceChildren();
  {const greet=el('div',null,'dashboard-intro'),gi=el('div');
   gi.append(el('strong',`${dayGreeting()} — ${state.storeName||'متجرك'}`),el('span',todayLine(),'sub'));
   greet.append(gi);home.append(greet);}
  if(!state.lease||!state.approved){home.append(el('div','بانتظار جهاز معتمد وجلسة عامل واحدة. لا يمكنك البيع الآن.','flash error'));
    shiftBox.append(el('p','لا يمكن طلب وردية قبل اعتماد الجهاز والجلسة.','muted'));
    const sc=syncCenterCard();if(sc)home.append(sc);updateSaleButtons();return;}
  const ms=await state.api.rpc('rfq_pilot_my_open_shift',{p_store:state.store,p_device:state.device});
  state.shift=ms?(ms.id!=null?String(ms.id):String(ms)):null; // تطبيع الشكلين
  const title=state.shift?'وردية معتمدة ومفتوحة':'لا توجد وردية معتمدة';
  home.append(el('div',title,state.shift?'flash ok':'flash error'));
  home.append(el('p','تُحدّث البيانات دورياً للتجربة؛ هذا ليس بديلاً عن مزامنة فورية مختبرة على هاتفين.','muted small'));
  if(state.shift){shiftBox.append(row('وردية مفتوحة','يمكن للعامل إنشاء فاتورة نقد/دين بعد إقرار الخادم'));}
  else {
    const btn=el('button','اطلب فتح وردية من المالك','btn p');btn.onclick=()=>handle(async()=>{
      await state.api.rpc('rfq_pilot_request_shift',{p_store:state.store,p_device:state.device});showMessage(state.mode==='offline'?'فُتحت الوردية مباشرة (وضع محلي).':'أُرسل الطلب للمالك؛ انتظر موافقته.','ok');await refresh();});
    shiftBox.append(btn);
  }
  const pending=await state.api.table('rfq_pilot_shift_requests',{
    store_id:`eq.${state.store}`,worker_id:`eq.${state.user.id}`,select:'id,status,created_at',order:'created_at.desc',limit:'3'});
  for(const p of pending)shiftBox.append(row(`طلب ${p.status}`,stamp(p.created_at)));
  if(state.pending){home.append(el('div','توجد فاتورة نتيجتها غير مؤكدة. استخدم «أعد نفس العملية» قبل محاولة بيع جديدة.','flash error'));}
  const sc=syncCenterCard();if(sc)home.append(sc); // يظهر للعامل أيضًا بعد إعادة الفتح، لا للمالك فقط
  updateSaleButtons();
}


// ===== طلبات واحتياجات المتجر (مالك وعامل) =====
const DEMAND_STATUS={needed:'مطلوب توفيره',ordered:'طُلب من المورّد',received:'تم توفيره ✓',cancelled:'ملغي'};
async function renderDemands(){
  const box=$('demandList');if(!box)return;
  const pf=$('demandProduct');
  if(pf){const cur=pf.value;pf.replaceChildren();const o0=el('option','— بضاعة جديدة (اكتب الاسم بالأسفل) —');o0.value='';pf.append(o0);
    for(const pr of state.products.filter(x=>x.active!==false)){const o=el('option',pr.name);o.value=pr.id;pf.append(o);}pf.value=cur;}
  if(!netReady()||!state.api?.signedIn){box.replaceChildren(el('p','طلبات الاحتياج تظهر عند الاتصال بالخادم.','muted small'));return;}
  let list=[];try{list=await state.api.rpc('rfq_pilot_demand_list',{p_store:state.store,p_limit:100});}catch{return;}
  box.replaceChildren();
  if(!list.length){box.append(el('p','لا طلبات مسجلة — كل ما يطلبه الزبائن متوفر ✓','muted small'));return;}
  for(const d of list){
    const wrap=row(`${d.item_name}${d.qty_milli?` — كمية ${Number(d.qty_milli)/1000}`:''} • ${DEMAND_STATUS[d.status]||d.status}`,
      `${d.note?d.note+' • ':''}${stamp(d.created_at)}`);
    const mk=(label,status)=>{const b=el('button',label,'btn sm ghost');b.type='button';
      b.onclick=()=>handle(async()=>{await state.api.rpc('rfq_pilot_set_demand_status',{p_store:state.store,p_id:d.id,p_status:status});
        showMessage('حُدّثت حالة طلب الاحتياج','ok');renderDemands();});return b;};
    const btns=el('span');btns.style.display='flex';btns.style.gap='6px';btns.style.flexWrap='wrap';
    if(d.status==='needed')btns.append(mk('طُلب من المورّد','ordered'),mk('تم توفيره ✓','received'),mk('إلغاء','cancelled'));
    else if(d.status==='ordered')btns.append(mk('تم توفيره ✓','received'),mk('إلغاء','cancelled'));
    else if(d.status==='cancelled')btns.append(mk('إعادة فتح','needed'));
    if(btns.children.length)wrap.append(btns);
    box.append(wrap);
  }
}
const demandFormEl=$('demandForm');
if(demandFormEl)demandFormEl.addEventListener('submit',e=>{e.preventDefault();handle(async()=>{
  assertWritable();
  const pid=$('demandProduct').value||null;
  const name=pid?'':$('demandName').value.trim();
  if(!pid&&name.length<2)throw Error('اختر صنفًا موجودًا أو اكتب اسم البضاعة المطلوبة');
  const qv=$('demandQty').value;
  await state.api.rpc('rfq_pilot_add_demand',{p_store:state.store,p_id:crypto.randomUUID(),
    p_product:pid,p_name:name,p_qty_milli:qv?qtyMilli(qv):null,p_note:$('demandNote').value.trim()});
  e.target.reset();showMessage('سُجّل طلب الاحتياج — يظهر للمالك والعامل حتى يُوفَّر','ok');renderDemands();
});});


// ===== بيع المالك بهويته (وضع بيع المالك) =====
// Owner leases expire while Android is backgrounded. Recover as OWNER, never as worker.
// Keep the last known shift on errors: an expired lease is not a closed shift.
let ownerSessionFlight=null,ownerSessionEpoch=0;
function transientSellerError(e){
  const status=Number(e?.status)||0;
  return status>=500||status===429||(!status&&/aborted|Failed to fetch|fetch failed|network|timeout|unavailable/i.test(String(e?.message||e)));
}
function ensureOwnerSellerSession({enter=false,forceClaim=false}={}){
  if(state.role!=='owner'||(!state.sellerMode&&!enter)||!state.api?.signedIn)
    return Promise.reject(Error('جلسة بيع المالك غير مفعّلة لهذا الحساب'));
  if(state.readOnly)return Promise.reject(Error('الترخيص منتهٍ؛ لا يمكن تجديد جلسة بيع جديدة'));
  if(!netReady())return Promise.reject(Error('لا اتصال للتحقق من جلسة بيع المالك'));
  const ctx={api:state.api,user:state.user?.id,store:state.store,device:state.device,epoch:ownerSessionEpoch};
  const same=()=>state.api===ctx.api&&state.user?.id===ctx.user&&state.store===ctx.store&&state.device===ctx.device&&
    state.role==='owner'&&ownerSessionEpoch===ctx.epoch&&(enter||state.sellerMode);
  const guard=()=>{if(!same())throw Error('تغيّر الحساب أو وضع البيع أثناء استعادة الجلسة');};
  if(ownerSessionFlight&&ownerSessionFlight.api===ctx.api&&ownerSessionFlight.user===ctx.user&&
    ownerSessionFlight.store===ctx.store&&ownerSessionFlight.device===ctx.device&&ownerSessionFlight.epoch===ctx.epoch)
    return ownerSessionFlight.promise;
  const previousStatus=state.ownerSessionState;
  state.ownerSessionState='checking';updateSellerBar();updateSaleButtons();
  const flight={...ctx};ownerSessionFlight=flight;
  flight.promise=(async()=>{
    try{
      const args={p_store:ctx.store,p_device:ctx.device};
      if(state.lease&&!forceClaim){
        try{await ctx.api.rpc('rfq_pilot_heartbeat',args);}
        catch(e){guard();await ctx.api.rpc('rfq_pilot_claim_owner_seller',args);}
      }else await ctx.api.rpc('rfq_pilot_claim_owner_seller',args);
      guard();
      const ms=await ctx.api.rpc('rfq_pilot_my_open_shift',args);guard();
      state.lease=true;state.shift=ms?(ms.id!=null?String(ms.id):String(ms)):null;
      state.ownerSessionState='ready';if(enter)state.sellerMode=true;
      if(['unverified','denied'].includes(previousStatus)&&/تعذّر استعادة جلسة بيع المالك|يلزم استعادة جلسة بيع المالك|owner_seller_device_or_session_denied|seller_session_already_active/.test($('message').dataset.rawMessage||''))$('message').hidden=true;
      return state.shift;
    }catch(e){
      if(same()){
        state.ownerSessionState=transientSellerError(e)?'unverified':'denied';
        if(!transientSellerError(e))state.lease=false;
        // Do not clear state.shift/cart/cash: only a successful server read may clear a shift.
      }
      throw e;
    }finally{
      if(ownerSessionFlight===flight)ownerSessionFlight=null;
      if(same()){updateSellerBar();updateSaleButtons();}
    }
  })();
  return flight.promise;
}
async function enterOwnerSeller(){
  closeDrawer();if(state.role!=='owner')return;
  await ensureOwnerSellerSession({enter:true,forceClaim:true});
  setView('pos');updateSellerBar();updateSaleButtons();
  showMessage(state.shift?'وضع بيع المالك مفعّل: ورديتك مفتوحة، وكل بيع يُختم باسمك (بواسطة: المالك)':'وضع بيع المالك: افتح ورديتك من الشريط بالأعلى لبدء البيع','ok');
}
function updateSellerBar(){
  const bar=$('ownerSellerBar');if(!bar)return;
  bar.classList.toggle('hide',!state.sellerMode);
  if(!state.sellerMode)return;
  const st=$('ownerSellerState'),open=$('ownerSellerOpen');if(!st||!open)return;open.replaceChildren();
  if(['checking','unverified','denied'].includes(state.ownerSessionState)){
    st.textContent=state.ownerSessionState==='checking'?'جارٍ التحقق من جلسة بيع المالك وورديته…':
      'تعذّر التحقق من جلسة بيع المالك. انتهاء الجلسة لا يغلق ورديتك؛ استعد الجلسة قبل الحفظ، ولا تفتح وردية أخرى.';
    if(state.ownerSessionState!=='checking'){
      const retry=el('button','استعادة جلسة المالك والوردية','btn p wide mt');retry.type='button';
      retry.onclick=()=>handle(async()=>{await ensureOwnerSellerSession({forceClaim:true});showMessage(state.shift?'استُعيدت جلسة المالك ووردّيته المفتوحة نفسها؛ لم تُفتح وردية جديدة.':'استُعيدت الجلسة؛ الخادم يؤكد عدم وجود وردية مفتوحة.','ok');});open.append(retry);
    }
    return;
  }
  if(state.shift){st.textContent='وردية المالك مفتوحة الآن على هذا الجهاز — كل بيع يُسجَّل باسمك أنت. إغلاقها من «الصندوق والورديات» بجرد النقد الفعلي.';}
  else{st.textContent='لا توجد وردية مالك مفتوحة على هذا الجهاز بعد.';
    const f=inlineMoneyInput('عهدة افتتاح درج المالك بالريال:');open.append(f.wrap);
    const b=el('button','افتح وردية المالك وابدأ البيع','btn p wide mt');b.type='button';
    b.onclick=()=>handle(async()=>{
      const opening=moneyCents(f.input.value);
      // Recheck first: a concurrent refresh/resume may have rediscovered an existing shift.
      await ensureOwnerSellerSession();
      if(state.shift){showMessage('وردية المالك مفتوحة بالفعل؛ استُعيدت نفسها دون فتح أخرى.','ok');return;}
      const api=state.api,store=state.store,device=state.device,user=state.user?.id,epoch=ownerSessionEpoch;
      const id=await api.rpc('rfq_pilot_open_owner_shift',{p_store:store,p_device:device,p_opening_cents:opening});
      if(state.api!==api||state.store!==store||state.device!==device||state.user?.id!==user||ownerSessionEpoch!==epoch||!state.sellerMode)return;
      state.shift=String(id);showMessage('فُتحت وردية المالك — بيعك الآن موثّق باسمك','ok');updateSellerBar();updateSaleButtons();});
    open.append(b);}
}
const osNav=$('ownerSellerNav');if(osNav)osNav.onclick=()=>{closeDrawer();return handle(enterOwnerSeller);};
const osExit=$('exitSellerMode');if(osExit)osExit.onclick=()=>{ownerSessionEpoch++;state.ownerSessionState=null;state.sellerMode=false;updateSellerBar();updateSaleButtons();goTo('home');
  showMessage('انتهى وضع بيع المالك — ورديتك تبقى مفتوحة في الصندوق حتى تغلقها بجرد','ok');};

// ===== الجرد الدوري =====
async function loadStocktake(){
  const body=$('stocktakeBody');if(!body||state.role!=='owner')return;
  let t=null;try{t=await state.api.rpc('rfq_pilot_stocktake_get',{p_store:state.store});}catch{return;}
  body.replaceChildren();
  const startBtn=$('startStocktake');
  if(!t){body.append(el('p','لا جرد محفوظ بعد. ابدأ أول جرد لعدّ المخزون فعليًا ومطابقته مع النظام.','muted small'));if(startBtn)startBtn.disabled=false;return;}
  if(t.status!=='open'){body.append(el('p',`آخر جرد: ${t.status==='closed'?'مغلق ومعتمد ✓':'ملغي'} • بدأ ${stamp(t.created_at)}`,'muted small'));if(startBtn)startBtn.disabled=false;return;}
  if(startBtn)startBtn.disabled=true;
  body.append(el('p',`جرد مفتوح منذ ${stamp(t.created_at)} — عدّ كل صنف في المحل واكتب الكمية الفعلية؛ الفرق يظهر مباشرة، والاعتماد يُسوّي الفروق بحركات موثّقة.`,'muted small'));
  const sum=el('p','','muted small');
  const upd=()=>{const c=t.lines.filter(x=>x.counted_milli!=null).length;
    const d=t.lines.filter(x=>x.counted_milli!=null&&x.counted_milli!==x.system_milli).length;
    sum.textContent=`عُدّ ${c} من ${t.lines.length} صنف • أصناف فيها فرق: ${d}`;};
  for(const l of t.lines){
    const wrap=el('div',null,'list-row'),txt=el('span');
    txt.append(el('strong',l.name),el('small',`نظامي: ${Number(l.system_milli)/1000} ${l.unit||''}`));
    const inp=el('input');inp.type='number';inp.step='0.001';inp.min='0';inp.placeholder='العدّ الفعلي';
    inp.style.maxWidth='130px';if(l.counted_milli!=null)inp.value=Number(l.counted_milli)/1000;
    const diff=el('small','');diff.style.minWidth='86px';
    const calc=()=>{if(inp.value===''){diff.textContent='';return;}
      const d=Math.round(Number(inp.value)*1000)-l.system_milli;
      diff.textContent=d===0?'✓ مطابق':`فرق ${d>0?'+':''}${d/1000}`;
      diff.style.color=d===0?'var(--green)':'var(--red)';};
    inp.addEventListener('change',()=>handle(async()=>{
      const cv=inp.value===''?null:qtyMilli(inp.value);
      await state.api.rpc('rfq_pilot_set_stocktake_count',{p_store:state.store,p_stocktake:t.id,p_product:l.product_id,p_counted_milli:cv});
      l.counted_milli=cv;calc();upd();}));
    calc();wrap.append(txt,inp,diff);body.append(wrap);
  }
  upd();body.append(sum);
  const close=el('button','اعتماد الجرد وتسوية الفروق موثّقًا','btn amber wide mt');close.type='button';
  close.onclick=()=>handle(async()=>{
    const r=await state.api.rpc('rfq_pilot_close_stocktake',{p_store:state.store,p_stocktake:t.id});
    showMessage(`اعتُمد الجرد: عُدّ ${r.counted} صنف، فروق ${r.diffs}، صافي قيمة الفروق ${cents(r.diff_value_cents)} — سُوّيت بحركات موثّقة بالسبب`,'ok');
    await refresh();loadStocktake();});
  body.append(close);
}
const stBtn=$('startStocktake');
if(stBtn)stBtn.onclick=()=>handle(async()=>{
  await state.api.rpc('rfq_pilot_open_stocktake',{p_store:state.store,p_id:crypto.randomUUID(),p_note:''});
  showMessage('بدأ الجرد — التقطت صورة المخزون النظامي الآن. عدّ الأصناف فعليًا.','ok');loadStocktake();});

// ===== ملصقات الباركود (Code39 قابل للمسح) =====
const C39={'0':'nnnwwnwnn','1':'wnnwnnnnw','2':'nnwwnnnnw','3':'wnwwnnnnn','4':'nnnwwnnnw','5':'wnnwwnnnn','6':'nnwwwnnnn','7':'nnnwnnwnw','8':'wnnwnnwnn','9':'nnwwnnwnn','A':'wnnnnwnnw','B':'nnwnnwnnw','C':'wnwnnwnnn','D':'nnnnwwnnw','E':'wnnnwwnnn','F':'nnwnwwnnn','G':'nnnnnwwnw','H':'wnnnnwwnn','I':'nnwnnwwnn','J':'nnnnwwwnn','K':'wnnnnnnww','L':'nnwnnnnww','M':'wnwnnnnwn','N':'nnnnwnnww','O':'wnnnwnnwn','P':'nnwnwnnwn','Q':'nnnnnnwww','R':'wnnnnnwwn','S':'nnwnnnwwn','T':'nnnnwnwwn','U':'wwnnnnnnw','V':'nwwnnnnnw','W':'wwwnnnnnn','X':'nwnnwnnnw','Y':'wwnnwnnnn','Z':'nwwnwnnnn','-':'nwnnnnwnw','.':'wwnnnnwnn',' ':'nwwnnnwnn','*':'nwnnwnwnn','$':'nwnwnwnnn','/':'nwnwnnnwn','+':'nwnnnwnwn','%':'nnnwnwnwn'};
function barcodeSvg(text){
  const clean=String(text||'').toUpperCase().split('').filter(c=>C39[c]&&c!=='*').join('');
  if(!clean)return '';
  const t='*'+clean+'*';let x=2;const bars=[];
  for(const ch of t){const pat=C39[ch];for(let i=0;i<9;i++){const w=pat[i]==='w'?2.7:1.1;
    if(i%2===0)bars.push(`<rect x="${x.toFixed(1)}" y="1" width="${w}" height="38"/>`);x+=w;}x+=1.4;}
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${x.toFixed(1)} 40" preserveAspectRatio="none" style="width:100%;height:42px" fill="#000">${bars.join('')}</svg>`;
}
function printLabels(list){
  if(!list.length){showMessage('لا أصناف لها باركود للطباعة');return;}
  const out=$('printArea');out.className='';out.replaceChildren();
  const grid=el('div',null,'labels');
  for(const pr of list){
    const lab=el('div',null,'label');
    lab.append(el('div',storeTitle(),'label-store'),el('div',pr.name,'label-name'),el('div',cents(pr.price_cents),'label-price'));
    if(pr.barcode){const holder=el('div');holder.innerHTML=barcodeSvg(pr.barcode);lab.append(holder,el('div',pr.barcode,'label-num'));}
    grid.append(lab);
  }
  out.append(grid);printPage();
}
const palBtn=$('printAllLabels');
if(palBtn)palBtn.onclick=()=>printLabels(state.products.filter(x=>x.active!==false&&x.barcode));

// ===== تقارير PDF الشاملة =====
function reportHead(title){
  const out=$('printArea');out.className='';out.replaceChildren();
  if(state.storeProfile?.logo){const im=el('img');im.src=state.storeProfile.logo;im.className='print-logo';out.append(im);}
  out.append(el('h1',storeTitle()),el('h2',title,'h2'),el('p',`أُنشئ ${new Date().toLocaleString('ar-YE')} — بيانات مؤكدة من الخادم`));
  return out;
}
function tableOf(headers,rows){
  const t=el('table'),h=el('tr');for(const c of headers)h.append(el('th',c));t.append(h);
  for(const r of rows){const tr=el('tr');for(const v of r)tr.append(el('td',String(v??'')));t.append(tr);}return t;
}
let dailyCache={date:null,data:null};
async function getDaily(){
  const d=($('reportDate')?.value)||new Date().toISOString().slice(0,10);
  if(dailyCache.date!==d)dailyCache={date:d,data:await state.api.rpc('rfq_pilot_daily_report',{p_store:state.store,p_date:d})};
  return dailyCache;
}
function fillReportCustomers(){
  const sel=$('reportCustomer');if(!sel)return;const cur=sel.value;sel.replaceChildren();
  for(const c of state.customers||[]){const o=el('option',c.name);o.value=c.id;sel.append(o);}
  if(cur)sel.value=cur;
}
let lastProfit=null;
const lpBtn=$('loadProfit');
if(lpBtn){const pf=$('profitFrom'),pt=$('profitTo');
  if(pf&&pt&&!pf.value){const t=new Date();pt.value=t.toISOString().slice(0,10);pf.value=new Date(t.getTime()-29*864e5).toISOString().slice(0,10);}
  lpBtn.onclick=()=>handle(async()=>{
    lastProfit=await state.api.rpc('rfq_pilot_profit_report',{p_store:state.store,p_from:pf.value,p_to:pt.value});
    const box=$('profitResult');box.replaceChildren();
    const g=el('div',null,'grid g4');
    amount(g,'صافي الإيراد',cents(lastProfit.net_revenue_cents));amount(g,'تكلفة البضاعة المباعة',cents(lastProfit.cogs_cents));
    amount(g,'الربح الدقيق',cents(lastProfit.gross_profit_cents));amount(g,'هامش الربح',`${lastProfit.margin_pct}٪`);
    box.append(g,el('p',`الفترة ${lastProfit.from} ← ${lastProfit.to} • ${lastProfit.invoices} فاتورة • مرتجعات ${cents(lastProfit.returns_cents)}`,'muted small'));
    for(const pr2 of lastProfit.top_products||[])box.append(row(`${pr2.name} — ربح ${cents(pr2.profit_cents)}`,`مبيعات ${cents(pr2.revenue_cents)} • تكلفة ${cents(pr2.cogs_cents)} • كمية ${Number(pr2.qty_milli)/1000}`));
    for(const d of lastProfit.by_day||[])box.append(row(`مبيعات ${d.d}`,`${cents(d.revenue_cents)} • ${d.invoices} فاتورة`));
    $('printProfit').classList.remove('hide');
  });
}
const ppBtn=$('printProfit');
if(ppBtn)ppBtn.onclick=()=>{if(!lastProfit)return;const out=reportHead(`تقرير الربح الدقيق (${lastProfit.from} ← ${lastProfit.to})`);
  out.append(tableOf(['البند','القيمة'],[['صافي الإيراد',cents(lastProfit.net_revenue_cents)],['تكلفة البضاعة المباعة',cents(lastProfit.cogs_cents)],['الربح الإجمالي الدقيق',cents(lastProfit.gross_profit_cents)],['هامش الربح',`${lastProfit.margin_pct}٪`],['عدد الفواتير',lastProfit.invoices],['قيمة المرتجعات',cents(lastProfit.returns_cents)]]),
    el('h2','الأصناف الأكثر ربحًا','h2'),
    tableOf(['الصنف','المبيعات','التكلفة','الربح'],(lastProfit.top_products||[]).map(x=>[x.name,cents(x.revenue_cents),cents(x.cogs_cents),cents(x.profit_cents)])));
  printPage();};
const rdInput=$('reportDate');if(rdInput&&!rdInput.value)rdInput.value=new Date().toISOString().slice(0,10);
const rds=$('repDailySales');if(rds)rds.onclick=()=>handle(async()=>{const {date,data}=await getDaily();
  const out=reportHead(`تقرير مبيعات اليوم — ${date}`);
  out.append(tableOf(['رقم','الوقت','الإجمالي','نقد','محفظة/حوالة','آجل','بواسطة','الحالة'],
    (data.sales||[]).map(v=>[v.number,new Date(v.created_at).toLocaleTimeString('ar-YE'),cents(v.total_cents),cents(v.cash_paid_cents),
      Number(v.other_paid_cents||0)?cents(v.other_paid_cents)+(v.other_method==='transfer'?' (حوالة)':' (محفظة)'):'' ,cents(v.due_cents),
      v.worker_id===state.user?.id?'المالك':'عامل '+String(v.worker_id).slice(0,8),v.voided_at?'ملغاة':'مؤكدة'])),
    el('p',`إجمالي المبيعات: ${cents(data.sales_totals.total_cents)} • نقدًا: ${cents(data.sales_totals.cash_cents)} • محفظة/حوالة: ${cents(data.sales_totals.other_cents)} • آجل: ${cents(data.sales_totals.due_cents)} • عدد الفواتير: ${data.sales_totals.count}`,'print-total'));
  if((data.sales_returns||[]).length)out.append(el('h2','مرتجعات اليوم','h2'),
    tableOf(['الفاتورة','القيمة','طريقة الرد','السبب'],data.sales_returns.map(r=>[r.invoice_number??'—',cents(r.total_cents),r.refund_method,r.reason||''])));
  if((data.collections||[]).length)out.append(el('h2','تحصيلات اليوم','h2'),
    tableOf(['الزبون','المبلغ','الطريقة'],data.collections.map(c=>[c.customer_name||'—',cents(c.amount_cents),c.method||'cash'])));
  printPage();});
const rdp=$('repDailyPurchases');if(rdp)rdp.onclick=()=>handle(async()=>{const {date,data}=await getDaily();
  const out=reportHead(`تقرير توريدات اليوم — ${date}`);
  out.append(tableOf(['المورّد','إجمالي الشراء','المسدد','المتبقي آجل','الحالة'],
    (data.purchases||[]).map(x=>[x.supplier_name||'—',cents(x.total_cents),cents(x.paid_cents),cents(x.due_cents),x.voided_at?'ملغاة':'مؤكدة'])),
    el('p',`إجمالي التوريدات: ${cents(data.purchases_totals.total_cents)} • المسدد منها: ${cents(data.purchases_totals.paid_cents)} • المتبقي آجل على المتجر: ${cents(data.purchases_totals.due_cents)} • عدد الفواتير: ${data.purchases_totals.count}`,'print-total'));
  if((data.supplier_payments||[]).length)out.append(el('h2','دفعات للموردين اليوم','h2'),
    tableOf(['المورّد','المبلغ','ملاحظة'],data.supplier_payments.map(x=>[x.supplier_name||'—',cents(Math.abs(x.amount_cents)),x.note||''])));
  printPage();});
const rInv=$('repInventory');if(rInv)rInv.onclick=()=>handle(async()=>{
  const out=reportHead('تقرير المخزون الحالي');
  const rows=[...state.products].filter(x=>x.active!==false).sort((a,b)=>String(a.category||'').localeCompare(String(b.category||''))||String(a.name).localeCompare(String(b.name)));
  if(rows.some(x=>x.cost_cents==null||!Number.isSafeInteger(Number(x.cost_cents))))throw Error('تكلفة بعض الأصناف غير متاحة الآن. اتصل بالخادم وحدّث الأصناف قبل طباعة تقييم المخزون؛ لن نعرض تكلفة صفرية وهمية.');
  let val=0;const trs=rows.map(x=>{const v=Math.round(Number(x.cost_cents||0)*Number(x.stock_milli||0)/1000);val+=v;
    return [x.name,x.category||'—',x.unit||'',Number(x.stock_milli||0)/1000,cents(x.cost_cents),cents(x.price_cents),cents(v),x.expiry_date||'—'];});
  out.append(tableOf(['الصنف','النوع','الوحدة','الرصيد','التكلفة','سعر البيع','قيمة المخزون بالتكلفة','الصلاحية'],trs),
    el('p',`عدد الأصناف: ${rows.length} • إجمالي قيمة المخزون بالتكلفة: ${cents(val)}`,'print-total'));
  printPage();});
const rCus=$('repCustomers');if(rCus)rCus.onclick=()=>handle(async()=>{
  const list=await state.api.rpc('rfq_pilot_customers_report',{p_store:state.store});
  const debtors=list.filter(x=>Number(x.balance_cents)>0);
  const total=debtors.reduce((a,x)=>a+Number(x.balance_cents),0);
  const out=reportHead('تقرير الزبائن الشامل');
  out.append(tableOf(['الزبون','الهاتف','الرصيد المستحق','آخر نشاط','الحالة'],
    list.map(x=>[x.name,x.phone||'—',cents(x.balance_cents),x.last_activity?new Date(x.last_activity).toLocaleDateString('ar-YE'):'—',x.active?'نشط':'معطّل'])),
    el('p',`عدد الزبائن: ${list.length} • من عليهم دين: ${debtors.length} • إجمالي المستحق: ${cents(total)}`,'print-total'));
  printPage();});
const rSup=$('repSuppliers');if(rSup)rSup.onclick=()=>handle(async()=>{
  await loadSuppliers();
  const list=state.suppliers||[];
  const due=list.filter(x=>Number(x.balance_cents)>0).reduce((a,x)=>a+Number(x.balance_cents),0);
  const out=reportHead('تقرير الموردين الشامل');
  out.append(tableOf(['المورّد','النوع','الهاتف','الرصيد','الحالة'],
    list.map(x=>[x.name,(typeof KIND_LABEL!=='undefined'&&KIND_LABEL[x.kind])||x.kind||'',x.phone||'—',
      `${cents(Math.abs(Number(x.balance_cents||0)))} ${Number(x.balance_cents)>0?'(مستحق للمورّد على المتجر)':Number(x.balance_cents)<0?'(مدفوع مقدمًا)':''}`,x.active?'نشط':'معطّل'])),
    el('p',`عدد الموردين: ${list.length} • إجمالي المستحق للموردين: ${cents(due)}`,'print-total'));
  printPage();});
const rcs=$('repCustomerStmt');if(rcs)rcs.onclick=()=>handle(async()=>{
  const id=$('reportCustomer')?.value;const c=(state.customers||[]).find(x=>x.id===id);
  if(!c)throw Error('اختر زبونًا أولًا');await printCustomerStatement(c);});

// ===== شاشة متابعة المتجر (مالك): واسعة، هادئة، كل شيء مهم في نظرة واحدة =====
async function renderMonitor(){
  const box=$('monitorView');if(!box||state.role!=='owner')return;
  if(!box.children.length){for(let i=0;i<4;i++)box.append(el('div',null,'skel'));}
  let m=null;try{m=await state.api.rpc('rfq_pilot_owner_monitor',{p_store:state.store});}
  catch(e){showMessage(e.message||'تعذّر تحميل شاشة المتابعة');return;}
  if(!m)return;box.replaceChildren();
  const hero=el('div',null,'dashboard-intro mon-hero'),intro=el('div');
  intro.append(el('strong',`${dayGreeting()} — ${state.storeName||'متجرك'}`),
    el('span',`${todayLine()} • متابعة حية من بيانات الخادم نفسه`,'sub'));
  hero.append(intro,el('span',(m.open_shifts||[]).length?`${m.open_shifts.length} وردية مفتوحة الآن`:'الصندوق بلا وردية مفتوحة','pill'));
  box.append(hero);
  const k=el('div',null,'grid g4 dashboard-cards mon-kpis');
  amount(k,'مبيعات اليوم',cents(m.today.sales_cents));amount(k,'فواتير اليوم',String(m.today.invoices));
  amount(k,'تحصيلات اليوم',cents(m.today.collections_cents));amount(k,'ديون الزبائن القائمة',cents(m.totals.outstanding_cents));
  const k2=el('div',null,'grid g4 dashboard-cards mon-kpis');
  amount(k2,'إجمالي مبيعات المتجر',cents(m.totals.sales_cents));amount(k2,'نقد اليوم',cents(m.today.cash_cents));
  amount(k2,'بيع آجل اليوم',cents(m.today.credit_cents));amount(k2,'الأصناف / الزبائن',`${m.totals.products} / ${m.totals.customers}`);
  box.append(k,k2);
  // لوحة متابعة هادئة للمالك عن بُعد: تعرض ما وصل فعلاً من الخادم فقط،
  // وتفصل حركة البيع عن إشارات المخزون والدين بلا أي حالة تقديرية مخفية.
  const calm=el('section',null,'card mon-card mon-calm');
  const stockIssues=(m.out_stock||[]).length+(m.low_stock||[]).length;
  const debtTotal=Number(m.totals?.outstanding_cents||0);
  const mood=stockIssues===0&&debtTotal===0?'الوضع مطمئن — لا نواقص ولا ديون قائمة 🌿':
    stockIssues>0?'المتجر يتحرك — راجع الأصناف التي تحتاج تزويدًا 📦':
    'البيع مستمر — توجد أرصدة زبائن تستحق المتابعة 🤝';
  calm.append(el('div','نبض المتجر','mon-kicker'),el('h2',mood,'mon-mood'),
    el('p',`ملخص هادئ من آخر قراءة للخادم • ${stamp(state.api?.lastServerDate||new Date().toISOString())}`,'muted small'));
  const pulse=el('div',null,'mon-pulse-row');
  const pulseItems=[['🧾',`${Number(m.today?.invoices||0)} فاتورة اليوم`],['💵',`${cents(m.today?.cash_cents||0)} نقد اليوم`],['🤝',`${cents(m.today?.credit_cents||0)} بيع آجل اليوم`],['📦',`${stockIssues} صنف يحتاج انتباهًا`]];
  for(const [icon,label] of pulseItems){const item=el('div',null,'mon-pulse-item');item.append(el('span',icon),el('strong',label));pulse.append(item);}
  calm.append(pulse);box.append(calm);
  const activity=el('section',null,'card mon-card mon-activity');
  activity.append(el('h2','الحركة الأخيرة','h2'),el('p','فواتير مؤكدة وإشارات أصناف من بيانات المتجر.','muted small'));
  const events=[];
  for(const v of (m.recent_invoices||[]).slice(0,4))events.push({icon:v.voided_at?'↩':'🛒',title:v.voided_at?`فاتورة ${v.number} أُلغيت`:`بيع مؤكد — فاتورة ${v.number}`,detail:`${cents(v.total_cents)} • ${stamp(v.created_at)}`,tone:v.voided_at?'warn':'good'});
  for(const p of (m.out_stock||[]).slice(0,3))events.push({icon:'⛔',title:`نفد الصنف: ${p.name}`,detail:'راجع التزويد قبل البيع التالي',tone:'warn'});
  for(const p of (m.low_stock||[]).slice(0,3))events.push({icon:'📉',title:`مخزون منخفض: ${p.name}`,detail:`المتبقي ${Number(p.stock_milli||0)/1000}`,tone:'warn'});
  if(!events.length)activity.append(el('p','لا حركة تستدعي القلق الآن — المتجر هادئ وكل المؤشرات مستقرة ✓','muted'));
  for(const ev of events){const line=el('div',null,'mon-event '+ev.tone);line.append(el('span',ev.icon,'mon-event-icon'),el('div',null,'mon-event-copy'));
    const copy=line.lastChild;copy.append(el('strong',ev.title),el('small',ev.detail));activity.append(line);}
  box.append(activity);
  const attn=[];
  for(const p of m.out_stock||[])attn.push(['red',`نفد من المخزون: ${p.name}`,'products']);
  for(const p of m.low_stock||[])attn.push(['amber',`مخزون يقترب من النفاد: ${p.name} (متبقٍّ ${Number(p.stock_milli)/1000})`,'products']);
  for(const x of m.expiring||[])attn.push([x.expired?'red':'amber',`${x.expired?'بضاعة منتهية الصلاحية':'بضاعة تقترب من الانتهاء'}: ${x.name} — ${x.expiry} (كمية ${Number(x.qty_milli)/1000})`,'products']);
  if((m.pending?.devices||0)>0)attn.push(['amber',`${m.pending.devices} جهاز بانتظار اعتمادك`,'settings']);
  if((m.pending?.shift_requests||0)>0)attn.push(['amber',`${m.pending.shift_requests} طلب وردية بانتظار موافقتك`,'shifts']);
  if((m.demands_needed||0)>0)attn.push(['amber',`📝 ${m.demands_needed} طلب احتياج بانتظار التوفير من الموردين`,'products']);
  if((m.messages?.failed||0)>0)attn.push(['red',`${m.messages.failed} رسالة فشلت — راجع سجل الرسائل`,'settings']);
  if((m.messages?.queued||0)>0)attn.push(['amber',`${m.messages.queued} رسالة تنتظر الإرسال من هاتف المتجر`,'settings']);
  const ac=el('section',null,'card mon-card');ac.append(el('h2','🔔 تنبيهات تحتاج انتباهك','h2'));
  if(!attn.length)ac.append(el('p','لا تنبيهات الآن — كل شيء على ما يرام ✓','muted'));
  for(const [tone,text,view] of attn){const r=el('div',null,'attn-row');r.append(el('span',null,'dot '+tone),el('span',text));
    r.onclick=()=>goTo(view);r.setAttribute('role','button');r.tabIndex=0;r.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();goTo(view);}};ac.append(r);}
  box.append(ac);
  const dc=el('section',null,'card mon-card');dc.append(el('h2','أكبر الديون القائمة','h2'));
  if(!(m.top_debtors||[]).length)dc.append(el('p','لا ديون قائمة ✓','muted'));
  for(const d of m.top_debtors)dc.append(row(`${d.name} — ${cents(d.balance_cents)}`,d.phone||'بلا هاتف',()=>goTo('customers'),'الزبائن'));
  box.append(dc);
  const g=el('div',null,'grid g2');
  const sc2=el('section',null,'card mon-card');sc2.append(el('h2','الورديات المفتوحة الآن','h2'));
  if(!(m.open_shifts||[]).length)sc2.append(el('p','لا وردية مفتوحة الآن.','muted'));
  for(const sh of m.open_shifts)sc2.append(row(`وردية عامل ${String(sh.worker_id).slice(0,8)}`,`منذ ${stamp(sh.opened_at)} • العهدة ${cents(sh.opening_cents)}`,()=>goTo('shifts'),'الصندوق'));
  const ic=el('section',null,'card mon-card');ic.append(el('h2','آخر الفواتير','h2'));
  if(!(m.recent_invoices||[]).length)ic.append(el('p','لا فواتير بعد.','muted'));
  for(const v of m.recent_invoices)ic.append(row(`فاتورة ${v.number} — ${cents(v.total_cents)}${v.voided_at?' — ملغاة':''}`,`الدين ${cents(v.due_cents)} • ${stamp(v.created_at)}`));
  g.append(sc2,ic);box.append(g);
  const mc=el('section',null,'card mon-card');mc.append(el('h2','حالة رسائل المتجر','h2'),
    el('p',`بانتظار الإرسال: ${m.messages.queued} • أُرسلت: ${m.messages.sent} • فشلت: ${m.messages.failed} • محجوبة (بلا رقم أو موافقة): ${m.messages.blocked}`,'muted'));
  const mb=el('button','فتح سجل الرسائل','btn sm ghost');mb.type='button';mb.onclick=()=>goTo('settings');mc.append(mb);
  box.append(mc);
}

async function renderOwner(){
  const [storeRows,members,pendingDevices,pendingRequests,shifts,invoices,summary,monitor]=await Promise.all([
    state.api.table('rfq_pilot_stores',{id:`eq.${state.store}`,select:'id,name,enabled,seat_limit,license_until',limit:'1'}),
    state.api.table('rfq_pilot_members',{store_id:`eq.${state.store}`,select:'user_id,role,active'}),
    state.api.table('rfq_pilot_devices',{store_id:`eq.${state.store}`,status:'eq.pending',select:'id,user_id,kind,created_at',order:'created_at.desc'}),
    state.api.table('rfq_pilot_shift_requests',{store_id:`eq.${state.store}`,status:'eq.pending',select:'id,worker_id,cashier_device_id,created_at',order:'created_at.desc'}),
    state.api.table('rfq_pilot_shifts',{store_id:`eq.${state.store}`,status:'eq.open',select:'id,worker_id,opening_cents,opened_at,expected_cents',order:'opened_at.desc'}),
    state.api.table('rfq_pilot_invoices',{store_id:`eq.${state.store}`,select:'id,number,total_cents,due_cents,created_at,voided_at,void_reason',order:'created_at.desc',limit:'20'}),
    state.api.rpc('rfq_pilot_owner_summary',{p_store:state.store}),
    state.api.rpc('rfq_pilot_owner_monitor',{p_store:state.store}).catch(()=>null),
  ]);
  const store=storeRows[0];state.storeName=store?.name||'متجر رفيق';
  $('storeLine').textContent=`${state.storeName} • عضويات ${members.length} • أجهزة ${store?.seat_limit??'—'} • الترخيص حتى ${stamp(store?.license_until)}`;
  const home=$('homeView');home.replaceChildren();
  // ===== واجهة النموذج المعتمد: بطاقة + إجراءات + يحتاج انتباهك + نوافذ مغلقة =====
  const hero=el('div',null,'dashboard-intro'),intro=el('div');
  intro.append(el('span','مساحة عملك اليوم','hero-kicker'),el('strong',`${dayGreeting()}، ${state.storeName}`),
    el('span',todayLine(),'sub'));
  hero.append(intro,el('span',shifts.length?`${shifts.length} وردية مفتوحة`:'الصندوق بلا وردية مفتوحة','pill'));
  const counts=el('span',`${state.products.length} صنف · ${state.customers.length} زبون`,'hero-meta');intro.append(counts);
  const lowStock=state.products.filter(x=>Number(x.stock_milli||0)<=(Number(state.msgSettings?.low_stock_milli)||1000));
  const stat=el('div',null,'m-stat');
  stat.append(el('div','مبيعات اليوم','s-label'));
  const sv=el('div',null,'s-value');sv.textContent=monitor?.today?cents(monitor.today.sales_cents):'—';
  stat.append(sv);
  const srow=el('div',null,'s-row');
  for(const [k,v] of [['إجمالي المبيعات',cents(summary.sales_cents)],['ديون الزبائن',cents(summary.outstanding_debt_cents)],['نقد المبيعات',cents(summary.cash_received_on_sales_cents)]]){
    const p=el('span',null,'pill');p.textContent=k+': '+v;srow.append(p);}
  const refBtn=el('button',null,'m-refresh');refBtn.type='button';
  refBtn.append(el('span','↻','refresh-ico'),document.createTextNode(' تحديث'));
  refBtn.onclick=()=>handle(async()=>{haptic();uiTapSound();spinRefresh(refBtn,true);
    try{await safeRefresh();showMessage('حالة المتجر محدثة.','ok');}finally{spinRefresh(refBtn,false);}});
  srow.append(refBtn);stat.append(srow);
  const quick=el('div',null,'m-quick-row');
  for(const [ic,lb,fn,cls] of [['🛒','بيع جديد',()=>state.role==='owner'?handle(enterOwnerSeller):goTo('pos'),'m-green'],
    ['🤝','تسديد دين',()=>goTo('customers'),'m-red'],['📤','مصروف',()=>goTo('shifts'),'m-amber'],
    ['📦','أصناف',()=>goTo('products'),'m-navy']]){
    const b=el('button',null,'m-quick');b.type='button';
    const icb=el('span',ic,'q-ico');icb.classList.add(cls);
    b.append(icb,el('span',lb));b.onclick=fn;quick.append(b);}
  const attWrap=el('div');attWrap.append(el('div','⚡ يحتاج انتباهك','m-section-title'));
  const atts=[];
  if(pendingDevices.length)atts.push(['var(--red)',`${pendingDevices.length} جهاز بانتظار الاعتماد`,'الصندوق — اعتمد أو ارفض',()=>goTo('shifts')]);
  if(pendingRequests.length)atts.push(['var(--amber)',`${pendingRequests.length} طلب وردية بانتظار الموافقة`,'الصندوق — افتح الوردية',()=>goTo('shifts')]);
  if(lowStock.length)atts.push(['var(--amber)',`أصناف قاربت النفاد: ${lowStock.length}`,'أولها: '+lowStock.slice(0,2).map(x=>x.name).join('، '),()=>goTo('products')]);
  if(Number(summary.outstanding_debt_cents||0)>0)atts.push(['var(--red)',`ديون زبائن قائمة: ${cents(summary.outstanding_debt_cents)}`,'راجع حسابات الزبائن',()=>goTo('customers')]);
  if(!atts.length)atts.push(['var(--green)','كل شيء تحت السيطرة ✓','لا طلبات معلّقة ولا نواقص حرجة',null]);
  for(const [dot,t,sub,fn] of atts){
    const r=el('button',null,'m-att');r.type='button';
    const d=el('span',null,'att-dot');d.style.background=dot;
    const mid=el('div',null,'a-t');mid.append(el('div',t),el('div',sub,'a-s'));
    r.append(d,mid,el('span','‹','chev'));if(fn)r.onclick=fn;attWrap.append(r);}
  const worldsWrap=el('div');worldsWrap.append(el('div','🗂 نوافذ العمل','m-section-title'));
  for(const [ic,t,sub,fn] of [
    ['🛒','البيع','بحث، سلة، مراجعة ودفع',()=>state.role==='owner'?handle(enterOwnerSeller):goTo('pos')],
    ['🤝','الديون والزبائن','الأرصدة، المتابعة، التسديد',()=>goTo('customers')],
    ['💰','الصندوق والورديات','الوردية، الحركات، الاعتمادات',()=>goTo('shifts')],
    ['📦','الأصناف والمخزون','الجرد، النواقص، الصلاحيات',()=>goTo('products')]]){
    const w=el('button',null,'m-world');w.type='button';
    const head=el('div',null,'w-head');head.append(el('div',ic,'w-ico'));
    const mid=el('div',null,'w-mid');mid.append(el('h2',t),el('div',sub,'w-sub'));
    head.append(mid,el('div','›','chev'));w.append(head);w.onclick=fn;worldsWrap.append(w);}
  const det=el('details',null,'m-fold');
  det.append(el('summary','📊 نظرة المتجر والاختصارات'));
  const inner=el('div',null,'f-inner');
  inner.append(el('p',`الرصيد القائم: ${cents(summary.outstanding_debt_cents)} — لكل زبون كشفه في شاشة الزبائن.`,'muted small'));
  const recent=el('section',null,'card');recent.append(el('h2','آخر الفواتير المؤكدة','h2'));
  if(!invoices.length)recent.append(el('p','لا توجد فواتير في المتجر بعد.','muted'));
  for(const item of invoices.slice(0,3))recent.append(row(`فاتورة ${item.number} — ${cents(item.total_cents)}${item.voided_at?' — ملغاة':''}`,
    `الدين ${cents(item.due_cents)} • ${stamp(item.created_at)}${item.voided_at?` • أُلغيت: ${String(item.void_reason||'').slice(0,60)}`:''}`));
  const stockZero=state.products.filter(p=>p.active!==false&&Number(p.stock_milli)===0);
  inner.append(recent,el('p',stockZero.length?`${stockZero.length} صنف رصيده صفر — راجع الجرد في شاشة الأصناف.`:'الأصناف ورصيدها في شاشة الأصناف.','muted small'));
  const quickCard=el('section',null,'card');quickCard.append(el('h2','اختصارات إضافية','h2'));
  const quick2=el('div',null,'btn-grid quick-actions');
  for(const [name,view,field] of [
    ['＋ إضافة صنف','products','productName'],['＋ إضافة زبون','customers','customerName'],
    ['＋ إضافة مورّد','suppliers','supName'],['📊 متابعة المتجر','monitor',null],['▧ التقارير والتصدير','reports',null]]){
    const link=el('button',name,'btn ghost');link.type='button';link.onclick=()=>goTo(view,field);quick2.append(link);}
  const remBtn=el('button','📨 تذكير المستحقين الآن','btn ghost');remBtn.type='button';
  remBtn.onclick=()=>handle(async()=>{const n=await state.api.rpc('rfq_pilot_enqueue_reminders',{p_store:state.store});
    showMessage(`وُضعت ${n} رسالة تذكير في قائمة الإرسال`,'ok');pumpSms().catch(()=>{});});
  quick2.append(remBtn);quickCard.append(quick2);inner.append(quickCard);det.append(inner);
  home.append(hero,stat,quick,attWrap,worldsWrap,det);
  {const sc=syncCenterCard();if(sc)home.append(sc);}
  const shiftBox=$('shiftList');shiftBox.replaceChildren();
  for(const d of pendingDevices){const button=()=>handle(async()=>{
    await state.api.rpc('rfq_pilot_approve_device',{p_store:state.store,p_device:d.id});showMessage('اعتمد المالك جهازاً جديداً.','ok');await refresh();});
    shiftBox.append(row(`طلب جهاز ${d.kind}`,`المستخدم ${d.user_id.slice(0,8)} • ${stamp(d.created_at)}`,button,'اعتماد جهاز'));}
  {const sc=syncCenterCard();if(sc)home.append(sc);}
  // P1: the server function rfq_pilot_revoke_worker existed with no owner UI.
  for(const m of members){
    if(m.role!=='worker'||!m.active)continue;
    const button=()=>handle(async()=>{
      await state.api.rpc('rfq_pilot_revoke_worker',{p_store:state.store,p_worker:m.user_id});
      showMessage('أُغلقت جلسة العامل؛ سيحتاج دخولًا جديدًا.','ok');await refresh();});
    shiftBox.append(row(`جلسة العامل ${m.user_id.slice(0,8)}`,'الإغلاق يفشل الجلسة القديمة فورًا (fail-closed)',button,'إغلاق جلسة'));
  }
  for(const req of pendingRequests){
    const openingField=inlineMoneyInput('عهدة افتتاح الوردية بالريال اليمني:');
    const button=()=>handle(async()=>{
      const opening=moneyCents(openingField.input.value);await state.api.rpc('rfq_pilot_approve_shift',{p_request:req.id,p_opening_cents:opening});
      showMessage('فتح المالك الوردية؛ العامل يمكنه البيع بعد تحديث حالته.','ok');await refresh();});
    shiftBox.append(row('طلب وردية بانتظار موافقة المالك',`العامل ${req.worker_id.slice(0,8)} • ${stamp(req.created_at)}`,button,'فتح وردية'),openingField.wrap);}
  opts($('cashShift'),shifts,'اختر وردية مفتوحة',s=>`${s.worker_id.slice(0,8)} — ${stamp(s.opened_at)}`);
  for(const shift of shifts){
    const countedField=inlineMoneyInput('كم النقد الموجود فعلاً بالدرج؟ (ريال يمني)');
    const button=()=>handle(async()=>{
      const counted=moneyCents(countedField.input.value);const report=await state.api.rpc('rfq_pilot_close_shift',{p_shift:shift.id,p_counted_cents:counted});
      printShift(report);showMessage('أُغلقت الوردية بتقرير خزينة.','ok');await refresh();});
    shiftBox.append(row('وردية مفتوحة',`العامل ${shift.worker_id.slice(0,8)} • العهدة ${cents(shift.opening_cents)}`,button,'إغلاق وطباعة'),countedField.wrap);}
  if(!shiftBox.children.length)shiftBox.append(el('p','لا طلبات أو ورديات مفتوحة.','muted'));
  const cards=$('reportCards');cards.replaceChildren();amount(cards,'مبيعات',cents(summary.sales_cents));
  amount(cards,'الدين القائم',cents(summary.outstanding_debt_cents));
  amount(cards,'الهامش التقريبي (ليس صافي ربح)',cents(summary.gross_margin_estimate_cents));
  amount(cards,'مبيعات الآجل الجديدة',cents(summary.new_credit_cents));
  const list=$('invoiceList');list.replaceChildren();if(!invoices.length)list.append(el('p','لا توجد فواتير اختبار.','muted'));
  for(const item of invoices){
    const wrap=el('div');
    if(item.voided_at){
      wrap.append(row(`فاتورة ${item.number} — ملغاة موثّقاً`,`دين ${cents(item.due_cents)} • ${stamp(item.created_at)} • السبب: ${item.void_reason||'—'}`));
    }else{
      const line=row(`فاتورة ${item.number} — ${cents(item.total_cents)}`,`دين ${cents(item.due_cents)} • ${stamp(item.created_at)}`);
      const form=el('div',null,'hide');
      const reason=el('input');reason.placeholder='سبب الإلغاء (إلزامي)';reason.maxLength=200;
      const confirmBtn=el('button','تأكيد الإلغاء الموثّق','btn sm');confirmBtn.type='button';
      confirmBtn.onclick=()=>handle(async()=>{
        if(reason.value.trim().length<3)throw Error('اكتب سبب الإلغاء أولاً');
        await state.api.rpc('rfq_pilot_void_invoice',{p_store:state.store,p_invoice:item.id,p_reason:reason.value.trim()});
        showMessage(`أُلغيت الفاتورة ${item.number} موثّقاً؛ عاد أثرها في المخزون والدين`,'ok');await refresh();});
      form.append(reason,confirmBtn);
      const voidBtn=el('button','إلغاء موثّق','btn sm ghost');voidBtn.type='button';
      voidBtn.onclick=()=>form.classList.toggle('hide');
      const retBtn=el('button','↩ مرتجع بيع','btn sm ghost');retBtn.type='button';
      retBtn.onclick=()=>handle(()=>openSalesReturn(item.id,item.number));
      line.append(voidBtn,retBtn);wrap.append(line,form);
    }
    list.append(wrap);
  }
  try{
    const collections=await state.api.rpc('rfq_pilot_recent_collections',{p_store:state.store});
    const colBox=$('collectionList');if(colBox){colBox.replaceChildren();
      if(!collections.length)colBox.append(el('p','لا توجد تحصيلات بعد.','muted'));
      for(const c of collections){
        const wrap=el('div');
        const line=row(`تحصيل ${cents(c.amount_cents)} — ${c.customer_name}`,stamp(c.at)+(c.reversed?' • تم عكسه':''));
        if(!c.reversed){
          const form=el('div',null,'hide');
          const reason=el('input');reason.placeholder='سبب عكس التحصيل (إلزامي)';reason.maxLength=200;
          const confirmBtn=el('button','تأكيد العكس الموثّق','btn sm');confirmBtn.type='button';
          confirmBtn.onclick=()=>handle(async()=>{
            if(reason.value.trim().length<3)throw Error('اكتب سبب العكس أولاً');
            await state.api.rpc('rfq_pilot_void_collection',{p_store:state.store,p_entry:c.id,p_reason:reason.value.trim()});
            showMessage('عُكس التحصيل موثّقاً؛ عاد الدين كما كان','ok');await refresh();});
          form.append(reason,confirmBtn);
          const revBtn=el('button','عكس موثّق','btn sm ghost');revBtn.type='button';
          revBtn.onclick=()=>form.classList.toggle('hide');
          line.append(revBtn);wrap.append(line,form);
        }else wrap.append(line);
        colBox.append(wrap);
      }
    }
  }catch(e){/* قائمة التحصيلات إضافية؛ لا تكسر لوحة المالك */}
}
function printPage(){
  const out=$('printArea');
  if(out&&!out.querySelector('.printed-by')){
    const pf=state.storeProfile||{};
    if(pf.invoice_footer)out.append(el('p',pf.invoice_footer,'printed-by'));
    out.append(el('p',`طُبع بواسطة: ${state.user?.email||'—'} • نفّذ العملية موثّقة خادميًا باسم فاعلها • ${new Date().toLocaleString('ar-YE')}`,'printed-by'));
  }
  if(embedded && window.RafiqPilotPrint?.print)window.RafiqPilotPrint.print();
  else window.print();
}
function printShift(report){
  const out=$('printArea');out.className='';out.replaceChildren();out.append(el('h1',`تقرير خزينة — ${state.storeName}`),el('p',`وردية ${report.shift_id}`));
  const t=el('table');for(const [label,val] of [
    ['العهدة',report.opening_cents],['إجمالي المبيعات',report.sales_total_cents],['دين المبيعات',report.sales_due_cents],
    ['نقد المبيعات',report.sales_cash_cents],['التحصيل النقدي',report.collections_cash_cents],
    ['حركات نقدية أخرى (صافي)',report.other_cash_net_cents],['المتوقع',report.expected_cents],
    ['المعدود',report.counted_cents],['الفارق',report.difference_cents]]){
      const tr=el('tr');tr.append(el('th',label),el('td',cents(val)));t.append(tr);}
  out.append(t,el('p','تقرير اختبار: لا يشمل المشتريات والمرتجعات أو التسوية القديمة.'));printPage();
}

async function loadSettingsPanels(){
  if(!state.api?.signedIn||!state.store)return;
  const li=$('launchInfo');if(li){const la=launchActivation();
    li.textContent=la?`التفعيل: ${la.mode==='offline'?'بدون إنترنت':la.mode==='online'?'بالإنترنت':'الاثنان'} • ${la.months===63?'مدى الحياة':'ساري حتى '+stamp(la.until)}`:'غير مفعّل';}
  const ld=$('launchDeviceLine');if(ld)ld.textContent='رمز هذا الجهاز (للتجديد): '+deviceCodePretty();
  if(state.role==='owner')loadOwnerDevices().catch(e=>showMessage(e.message));
  if(state.role==='owner')loadMemberPerms().catch(()=>{});
  if(state.role==='owner'){
    try{
      const st=state.msgSettings||await state.api.rpc('rfq_pilot_get_message_settings',{p_store:state.store});
      state.msgSettings=st;
      $('msgMaster').checked=!!st.master_enabled;$('msgWhatsappOn').checked=!!st.whatsapp_enabled;
      if($('msgWaInvoiceMode'))$('msgWaInvoiceMode').value=st.wa_invoice_mode==='pdf'?'pdf':'text';
      $('msgSmsOn').checked=!!st.sms_enabled;$('msgWhatsappPhone').value=st.whatsapp_phone||'';
      $('msgOwnerPhone').value=st.owner_alert_phone||'';
      $('msgEvtCredit').checked=st.events?.credit_sale!==false;$('msgEvtCollection').checked=st.events?.collection!==false;
      $('msgEvtReminder').checked=st.events?.reminder!==false;$('msgEvtOwner').checked=st.events?.owner_alerts!==false;
      $('msgReminderOn').checked=!!st.reminder?.enabled;
      $('msgReminderMin').value=Number(st.reminder?.min_balance_cents||0)/100;
      if($('msgQuietStart'))$('msgQuietStart').value=st.reminder?.quiet_start??21;
      if($('msgQuietEnd'))$('msgQuietEnd').value=st.reminder?.quiet_end??7;
      const tpl=st.templates||{};
      if($('tplCreditSale'))$('tplCreditSale').value=tpl.credit_sale||'';
      if($('tplCollection'))$('tplCollection').value=tpl.collection||'';
      if($('tplReminder'))$('tplReminder').value=tpl.reminder||'';
      if($('tplOwnerAlert'))$('tplOwnerAlert').value=tpl.owner_alert||'';
      $('msgSmsDeviceState').textContent=st.sms_sender_device_id?
        (st.sms_sender_device_id===state.device?'جهاز إرسال SMS: هذا الجهاز':'جهاز إرسال SMS: جهاز آخر معيّن'):'جهاز إرسال SMS: غير معيّن';
      const log=await state.api.rpc('rfq_pilot_message_log',{p_store:state.store,p_limit:20});
      renderMsgRows($('msgLog'),log);
      renderMsgRows($('myMsgLog'),log);
    }catch(e){showMessage(e.message||'تعذر تحميل إعدادات الرسائل');}
    try{
      const list=await state.api.rpc('rfq_pilot_voice_list',{p_store:state.store});
      const box=$('voiceList');box.replaceChildren();
      if(!list.length)box.append(el('p','لا أعضاء بعد.','muted'));
      for(const m of list){
        const btn=el('button',m.approved?'الصوت معتمد ✓':'اعتماد الصوت','btn sm ghost');btn.type='button';
        btn.onclick=()=>handle(async()=>{
          await state.api.rpc('rfq_pilot_voice_set',{p_store:state.store,p_user:m.user_id,p_approved:!m.approved,p_label:m.label||''});
          showMessage(m.approved?'أُلغي اعتماد الصوت':'اعتُمد الصوت لهذا العضو','ok');loadSettingsPanels();});
        box.append(row(`${m.role==='owner'?'مالك':'عامل'} ${String(m.user_id).slice(0,8)}`,m.approved?'أوامره الصوتية مسموحة ضمن قواعد التأكيد':'غير معتمد صوتيًا',()=>btn.click(),'تبديل'));
        box.lastChild.replaceChild(btn,box.lastChild.lastChild);
      }
    }catch(e){showMessage(e.message||'تعذر تحميل اعتمادات الصوت');}
  }
  const vs=$('voiceMyState');if(vs)vs.textContent=state.role==='owner'?'المالك: الأوامر الصوتية متاحة':
    (state.voiceApproved?'صوتك معتمد من المالك للأوامر المسموحة':'صوتك غير معتمد بعد؛ اطلب من المالك اعتماده من الإعدادات');
}
async function pumpSms(){
  if(state.smsPumping||!embedded)return;
  const st=state.msgSettings;if(!st?.master_enabled||!st?.sms_enabled)return;
  const b=bridge();if(!b||typeof b.smsSend!=='function')return;
  state.smsPumping=true;
  try{
    const phys=typeof b.physicalId==='function'?String(b.physicalId()||''):'';
    const jobs=phys?await state.api.rpc('rfq_pilot_sms_claim_v2',{p_store:state.store,p_physical:phys})
      :(st.sms_sender_device_id===state.device?await state.api.rpc('rfq_pilot_sms_claim',{p_store:state.store,p_device:state.device}):[]);
    for(const job of jobs||[]){
      let ok=false,err='';
      try{const r=JSON.parse(b.smsSend(JSON.stringify({slot:1,dest:job.phone,body:job.body,task:job.id}))||'{}');
        ok=['sent','submitted','delivered'].includes(r.status);err=ok?'':(r.error||r.status||'');}catch(e){err=String(e&&e.message||e);}
      await state.api.rpc('rfq_pilot_sms_ack',{p_store:state.store,p_id:job.id,p_ok:ok,p_error:err});
    }
  }finally{state.smsPumping=false;}
}

// ===== Step 4 module: suppliers, store profile, message rows, sales returns, contacts/camera =====
async function fileToDataUrl(file,max=192){
  const bmp=await createImageBitmap(file);
  const sc=Math.min(1,max/Math.max(bmp.width,bmp.height));
  const cv=document.createElement('canvas');cv.width=Math.max(1,Math.round(bmp.width*sc));cv.height=Math.max(1,Math.round(bmp.height*sc));
  cv.getContext('2d').drawImage(bmp,0,0,cv.width,cv.height);
  return cv.toDataURL('image/jpeg',0.82);
}
function renderMsgRows(box,log){
  if(!box)return;box.replaceChildren();
  if(!log?.length){box.append(el('p','لا رسائل بعد.','muted'));return;}
  const chip={queued:'⏳ بالانتظار',sending:'✈ تُرسل الآن',sent:'✓ أُرسلت',delivered:'✓✓ وصلت',failed:'✗ فشلت'};
  for(const m of log){
    const r=row(`${m.channel==='sms'?'SMS':'واتساب'} • ${m.event} • ${chip[m.status]||m.status}`,
      `${m.customer_name||m.phone||''} • ${stamp(m.at)}`);
    r.style.cursor='pointer';r.title='اضغط لقراءة نص الرسالة';
    r.onclick=()=>showMessage(`نص الرسالة (${chip[m.status]||m.status}): ${m.body||'—'}`,'ok');
    box.append(r);
  }
}
async function loadMyMsgLog(){
  const box=$('myMsgLog');if(!box||!state.api?.signedIn||!state.store)return;
  try{const log=await state.api.rpc('rfq_pilot_message_log',{p_store:state.store,p_limit:15});renderMsgRows(box,log);}
  catch{box.replaceChildren(el('p','سجل الرسائل الكامل عند المالك في «إعدادات الرسائل».','muted'));}
}
async function loadStoreProfile(){
  // الوضع المحلي (بلا خادم): الاسم من الحساب المحلي المحفوظ على الجهاز، لا من بيانات تجريبية
  if(state.mode==='offline'||state.api?.access==='local'){
    const localName=(localAccount()?.name)||'متجر رفيق';
    const dsnLocal=$('drawerStoreName');if(dsnLocal)dsnLocal.textContent=localName;
    // بلا شعار: دائرة بحرف المحل بألوان الهوية، فلا تختفي الصورة في اللوحة الجانبية
    const dspLocal=$('drawerStorePhoto');
    if(dspLocal){const ch=(localName.trim()[0]||'ر');const svg='<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><rect width="96" height="96" rx="22" fill="#0e2a47"/><text x="50%" y="56%" dominant-baseline="middle" text-anchor="middle" font-size="44" font-family="Tajawal,sans-serif" font-weight="700" fill="#d4a017">'+ch+'</text></svg>';dspLocal.src='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(svg);dspLocal.classList.remove('hide');}
    return;
  }
  if(!state.api?.signedIn||!state.store)return;
  try{const pf=await state.api.rpc('rfq_pilot_get_store_profile',{p_store:state.store});
    if(pf&&typeof pf==='object'){state.storeProfile=pf;
      const dsn=$('drawerStoreName');if(dsn)dsn.textContent=pf.display_name||state.storeName||'متجر رفيق';
      const dsp=$('drawerStorePhoto');
      if(dsp){if(pf.logo){dsp.src=pf.logo;dsp.classList.remove('hide');}else dsp.classList.add('hide');}
      if($('storeDisplayName'))$('storeDisplayName').value=pf.display_name||'';
      if($('storeProfilePhone'))$('storeProfilePhone').value=pf.phone||'';
      if($('storeAddress'))$('storeAddress').value=pf.address||'';
      if($('storeFooter'))$('storeFooter').value=pf.invoice_footer||'';
      if(pf.logo&&$('storeLogoPreview')){const im=$('storeLogoPreview');im.src=pf.logo;im.classList.remove('hide');state.storeLogoData=pf.logo;}
    }}catch{}
}
// ===== 130: الملف الشخصي (اسم وصورة) + قفل التطبيق (بصمة/رقم سري) =====
function renderDrawerIdentity(){ // الوعد المعلن في الإعدادات: الاسم والصورة في القائمة الجانبية — فعليًا
  const nm=$('drawerUserName'),ph=$('drawerUserPhoto');
  const local=state.mode==='offline'||state.api?.access==='local';
  const my=state.myProfile||{};
  const name=my.display_name||my.p_name||(local?(localAccount()||{}).name:null)||state.user?.email||'';
  const pretty=name&&name.indexOf(' — وضع محلي')>0?name.split(' — وضع محلي')[0]:name;
  if(nm&&pretty)nm.textContent=pretty; // لا يُمحى الاسم أبدًا بقيمة فارغة — آخر اسم ظاهر يبقى
  const photo=my.photo||my.p_photo||null;
  if(ph&&photo){ph.src=photo;ph.classList.remove('hide');} // الصورة الظاهرة لا تختفي بنتيجة فارغة
}
async function loadMyProfile(){
  if(state.mode==='offline'||state.api?.access==='local'){
    try{ // الملف الشخصي في الوضع المحلي من قاعدة الجهاز مباشرة
      const store=new LocalStore({get:kvGet,set:kvSet});
      const my=(store.db.profile&&store.db.profile.my)||null;
      state.myProfile=my||{display_name:(localAccount()||{}).name||''};
      const mn=$('myDisplayName');if(mn&&state.myProfile.display_name&&!mn.value)mn.value=state.myProfile.display_name;
      const mp=$('myPhotoPreview');
      if(mp){const p=state.myProfile.photo||state.myProfile.p_photo;
        if(p){mp.src=p;mp.classList.remove('hide');}else mp.classList.add('hide');}
      renderDrawerIdentity();return;
    }catch{renderDrawerIdentity();return;} // محليًا: حتى عند فشل القراءة — لا مسح ولا مسار خادمي
  }
  if(!state.api?.signedIn||!state.store)return;
  try{
    const rows=await state.api.rpc('rfq_pilot_store_profiles',{p_store:state.store});
    const me=(rows||[]).find(r=>r.user_id===state.user?.id)||null;
    if(me)state.myProfile=me; // نتيجة فارغة (مجهضة/شبكة) لا تمحو آخر اسم وصورة معروفين
    const mn=$('myDisplayName');if(mn&&me?.display_name)mn.value=me.display_name;
    const mp=$('myPhotoPreview');
    if(mp){if(me?.photo){mp.src=me.photo;mp.classList.remove('hide');}else mp.classList.add('hide');}
    state.storeMembers=rows||[];
    const wsr=$('workerSupplierRequest');
    if(wsr)wsr.classList.toggle('hide',!(state.role==='worker'&&me?.can_add_suppliers));
    renderDrawerIdentity();
  }catch{renderDrawerIdentity();}
}
// ===== 130c: كل قسم زر طيّ/فتح (أكورديون) — الحالة تبقى في الجلسة، بلا طيّ قسري بعد التحديث =====
const foldState={load(key,def){try{const v=sessionStorage.getItem('rafiq-fold:'+key);return v===null?def:v==='1';}catch{return def;}},
  save(key,open){try{sessionStorage.setItem('rafiq-fold:'+key,open?'1':'0');}catch{}}};
function applyFolds(){
  for(const card of document.querySelectorAll('.card')){
    if(card.dataset.foldWired||card.closest('details')||card.querySelector('details.card-fold'))continue;
    const h=card.querySelector('h2');if(!h)continue;
    card.dataset.foldWired='1';
    const key=card.id||String(h.textContent||'').trim().slice(0,48);
    const det=document.createElement('details');det.className='card-fold';
    const sum=document.createElement('summary');
    h.classList.add('fold-title');sum.append(h);
    det.append(sum);
    while(card.firstChild)det.append(card.firstChild);
    card.append(det);
    const rows=det.querySelectorAll('.row').length; // القوائم الطويلة تُطوَى افتراضيًا
    const posLegacy=!!card.closest('#posView')&&!card.closest('#ownerSellerBar'); // بناء 147: بطاقات البيع القديمة مطوية افتراضيًا
    det.open=foldState.load(key,!posLegacy&&rows<=5);
    det.addEventListener('toggle',()=>foldState.save(key,det.open));
    if(!reducedMotion())det.classList.add('fold-anim');
  }
}
const foldObserver=new MutationObserver(()=>{
  if(document.getElementById('appScreen')&&!document.getElementById('appScreen').classList.contains('hide')){
    clearTimeout(window.__foldT);window.__foldT=setTimeout(applyFolds,120);
  }
});
setTimeout(()=>{try{foldObserver.observe(document.body,{childList:true,subtree:true});}catch{}},0);
document.addEventListener('DOMContentLoaded',()=>setTimeout(applyFolds,60));

(function wireMyProfile(){
  const pick=$('myPhotoPick');if(!pick)return;
  pick.onclick=()=>$('myPhotoFile').click();
  $('myPhotoFile').onchange=async()=>{
    const f=$('myPhotoFile').files?.[0];if(!f)return;
    const url=await fileToDataUrl(f,160);
    const mp=$('myPhotoPreview');mp.src=url;mp.classList.remove('hide');mp.dataset.pending='1';
    showMessage('اضغط «حفظ ملفي» لتأكيد الصورة','ok');
  };
  $('saveMyProfile').onclick=()=>handle(async()=>{
    const mp=$('myPhotoPreview');
    const photo=mp?.dataset.pending?mp.src:null;
    const local=state.mode==='offline'||state.api?.access==='local';
    if(local){ // الحفظ على هذا الجهاز فقط — كان الزر وهميًا في الوضع المحلي
      const store=new LocalStore({get:kvGet,set:kvSet});
      const cur=(store.db.profile&&store.db.profile.my)||{};
      const next={...cur,display_name:$('myDisplayName').value.trim(),
        photo:photo!==null?photo:(cur.photo||cur.p_photo||null)};
      store.rpc('rfq_pilot_save_my_profile',{...next,p_name:next.display_name,p_photo:next.photo});
      state.myProfile=next;
    }else{
      await state.api.rpc('rfq_pilot_save_my_profile',{p_store:state.store,
        p_name:$('myDisplayName').value.trim(),p_photo:photo});
    }
    if(mp)delete mp.dataset.pending;
    showMessage('حُفظ ملفك الشخصي','ok');await loadMyProfile();renderDrawerIdentity();
  });
})();
function bridgeLock(payload){const b=window.RafiqAppLock||null;if(!b||typeof b.appLock!=='function')return null;try{return JSON.parse(b.appLock(JSON.stringify(payload))||'null');}catch{return null;}}
(function wireLock(){
  const bio=$('lockBiometric'),pin=$('lockPin');
  if(!bio||!pin)return;
  const sync=()=>{const st=bridgeLock({action:'status'})||{};
    bio.checked=!!st.bio;pin.checked=!!st.pin;
    const available=st.bio_available!==false; // لا خانة وهمية: تعطيل مع سبب مكتوب
    bio.disabled=!available&&!st.bio;
    const note=$('bioNote');
    if(note)note.textContent=!available?(st.bio_reason||'البصمة غير متاحة على هذا الهاتف — استخدم الرقم السري.'):
      (st.bio?'البصمة مفعّلة على هذا الهاتف.':'مفعّلة عند تأشيرها؛ تحتاج بصمة مسجلة في إعدادات أندرويد.');
    const quick=$('quickUnlockBtn');if(quick)quick.classList.toggle('hide',!(st.bio||st.pin));};
  window.__rafiqLockChanged=sync;
  setTimeout(sync,300);
  bio.onchange=()=>{
    if(bio.checked){const st=bridgeLock({action:'enable_bio'});
      if(!st?.ok){bio.checked=false;const why=st?.error||'البصمة غير متاحة: تأكد أنك في تطبيق الهاتف، وأن بصمة مسجّلة في إعدادات أندرويد';
        const note=$('bioNote');if(note)note.textContent=why;showMessage(why);}
      else showMessage('فُعّل الدخول بالبصمة','ok');
      sync();
    }else{bridgeLock({action:'disable_bio'});sync();}
  };
  pin.onchange=()=>{
    if(pin.checked){pin.checked=false;const st=bridgeLock({action:'set_pin'});
      if(st?.ok){pin.checked=true;showMessage('حُفظ الرقم السري','ok');}
      else showMessage(st?.error||'تعذّر تعيين الرقم السري');
    }else bridgeLock({action:'disable_pin'});
  };
  const setPin=$('setPinBtn');
  if(setPin)setPin.onclick=()=>{const st=bridgeLock({action:'set_pin'});
    if(st?.ok){pin.checked=true;showMessage('حُفظ الرقم السري','ok');}
    else showMessage(st?.error||'تعذّر تعيين الرقم السري');};
  const clr=$('clearLockBtn');
  if(clr)clr.onclick=()=>{bridgeLock({action:'clear'});bio.checked=false;pin.checked=false;showMessage('أُوقف قفل التطبيق','ok');};
  const quick=$('quickUnlockBtn');
  if(quick)quick.onclick=()=>{const st=bridgeLock({action:'unlock'})||{};
    if(st.ok)showMessage('تم التحقق — يمكنك الدخول الآن','ok');};
})();
// ===== 130: طلبات الموردين (العامل يطلب — المالك يوافق أو يرفض) + صلاحيات العاملين =====
async function loadSupplierRequests(){
  const box=$('supplierRequests');if(!box||!state.api?.signedIn||!state.store)return;
  try{
    const rows=await state.api.rpc('rfq_pilot_supplier_requests_list',{p_store:state.store})||[];
    box.replaceChildren();
    if(state.role==='owner'){
      box.append(el('h2','طلبات إضافة الموردين','h2'));
      const pending=rows.filter(r=>r.status==='pending');
      if(!pending.length)box.append(el('p','لا طلبات معلّقة.','muted small'));
      for(const r of pending){
        const line=row(`${r.name} — ${KIND_LABEL[r.kind]||r.kind}`,
          `${r.description||'—'}${r.phone?' • '+r.phone:''} • من: ${r.worker_name||'عامل'} • ${stamp(r.created_at)}`);
        const ok=el('button','موافقة','btn sm p');ok.type='button';
        ok.onclick=()=>handle(async()=>{
          await state.api.rpc('rfq_pilot_decide_supplier_request',{p_store:state.store,p_id:r.id,p_approve:true,p_reason:null});
          showMessage('وُافق على الطلب ونُشئ المورد','ok');await loadSupplierRequests();await loadSuppliers();});
        const no=el('button','رفض','btn sm ghost');no.type='button';
        no.onclick=()=>{
          const why=window.prompt('سبب الرفض (اختياري)')||'';
          handle(async()=>{
            await state.api.rpc('rfq_pilot_decide_supplier_request',{p_store:state.store,p_id:r.id,p_approve:false,p_reason:why||null});
            showMessage('رُفض الطلب','ok');await loadSupplierRequests();});
        };
        line.append(ok,no);box.append(line);
      }
      for(const r of rows.filter(r=>r.status!=='pending').slice(0,6))
        box.append(el('p',`${r.status==='approved'?'✓':'✗'} ${r.name} — ${r.status==='approved'?'مقبول':'مرفوض'}${r.reason?' • '+r.reason:''}`,'muted small'));
    }else{
      box.append(el('h2','طلبات موردي','h2'));
      if(!rows.length)box.append(el('p','لم ترسل طلبات بعد.','muted small'));
      for(const r of rows.slice(0,8))
        box.append(el('p',`${r.status==='pending'?'⏳':r.status==='approved'?'✓':'✗'} ${r.name} — ${r.status==='pending'?'بانتظار موافقة المالك':r.status==='approved'?'مقبول':'مرفوض'}${r.reason?' • '+r.reason:''}`,'muted small'));
    }
  }catch(e){box.replaceChildren(el('p','تعذّر تحميل طلبات الموردين.','muted'));}
}
(function wireSupplierRequest(){
  const f=$('wsrForm');if(!f)return;
  f.addEventListener('submit',e=>{e.preventDefault();handle(async()=>{
    const id=await state.api.rpc('rfq_pilot_request_supplier',{p_store:state.store,
      p_name:$('wsrName').value.trim(),p_kind:$('wsrKind').value,
      p_description:$('wsrDesc').value.trim(),p_phone:$('wsrPhone').value.trim()});
    if(!id)throw Error('تعذّر إرسال الطلب');
    f.reset();showMessage('أُرسل الطلب للمالك — بانتظار الموافقة','ok');await loadSupplierRequests();
  });});
})();
async function loadMemberPerms(){
  const box=$('memberPermsList');if(!box||state.role!=='owner'||!state.api?.signedIn)return;
  try{
    const rows=await state.api.rpc('rfq_pilot_member_perms_list',{p_store:state.store})||[];
    box.replaceChildren();
    if(!rows.length)box.append(el('p','لا أعضاء بعد.','muted small'));
    for(const m of rows){
      const line=row(m.display_name||String(m.user_id).slice(0,8),
        m.role==='owner'?'مالك':'عامل');
      if(m.role!=='owner'){
        const tg=el('label',null,'switch-line');
        const cb=el('input');cb.type='checkbox';cb.checked=!!m.can_add_suppliers;
        cb.onchange=()=>handle(async()=>{
          await state.api.rpc('rfq_pilot_set_member_perm',{p_store:state.store,p_user:m.user_id,p_can_add_suppliers:cb.checked});
          showMessage(cb.checked?'فُعّلت الصلاحية':'أُوقفت الصلاحية','ok');});
        tg.append(cb,el('span','إضافة الموردين (بالطلب)'));line.append(tg);
      }
      box.append(line);
    }
  }catch{box.replaceChildren(el('p','تعذّر تحميل الصلاحيات.','muted'));}
}
const KIND_LABEL={supplier:'مورّد',company_rep:'مندوب شركة',daily_distributor:'موزّع يومي متجول',company:'شركة',distributor:'موزّع'};
const SUP_ENTRY_LABEL={purchase:'فاتورة شراء',payment:'دفعة',purchase_return:'مرتجع للمورّد',purchase_void:'إلغاء شراء (موثّق)',payment_void:'إلغاء دفعة'};
async function loadSuppliers(){
  if(!state.api?.signedIn||!state.store)return;
  try{state.suppliers=await state.api.rpc('rfq_pilot_suppliers_overview',{p_store:state.store});renderSuppliers();}
  catch(e){const box=$('supplierList');if(box){box.replaceChildren(el('p','تعذّر تحميل الموردين. بياناتهم لم تُحذف.','muted'));const retry=el('button','إعادة تحميل الموردين','btn sm p');retry.type='button';retry.onclick=()=>handle(loadSuppliers);box.append(retry);}if(state.view==='suppliers')showMessage(e.message||'تعذّر تحميل الموردين');}
}
function supplierOptions(sel,placeholder){
  if(!sel)return;const cur=sel.value;
  sel.replaceChildren();const o0=el('option',placeholder);o0.value='';sel.append(o0);
  for(const x of state.suppliers.filter(z=>z.active)){const o=el('option',`${x.name} — ${KIND_LABEL[x.kind]||x.kind}`);o.value=x.id;sel.append(o);}
  if(cur)sel.value=cur;
}
function renderSuppliers(){
  supplierOptions($('purSupplier'),'اختر المورّد');supplierOptions($('paySupplier'),'اختر المورّد');supplierOptions($('retSupplier'),'اختر المورّد');supplierOptions($('ocrSupplier'),'اختر المورّد');
  const box=$('supplierList');if(!box)return;box.replaceChildren();
  if(!state.suppliers.length){box.append(el('p','لا موردون بعد. أضف أول مورّد من الأعلى (المالك).','muted'));return;}
  for(const x of state.suppliers){
    const bal=Number(x.balance_cents||0);
    const line=row(`${x.name} — ${KIND_LABEL[x.kind]||x.kind}${x.active?'':' (معطّل)'}`,
      `${x.phone||'دون هاتف'} • ${bal>0?'لنا عليه (دين على المتجر)':bal<0?'له عندنا مدفوع مقدمًا':'رصيده صفر'}: ${cents(Math.abs(bal))}`);
    if(x.photo){const im=el('img');im.src=x.photo;im.className='avatar';line.prepend(im);}
    const stmt=el('button','كشف الحساب','btn sm ghost');stmt.type='button';
    stmt.onclick=()=>handle(()=>showSupplierStatement(x));
    line.append(stmt);
    if(state.role==='owner'){
      const ed=el('button','تعديل','btn sm ghost');ed.type='button';
      ed.onclick=()=>{state.editingSupplier=x.id;$('supName').value=x.name;$('supPhone').value=x.phone||'';$('supKind').value=x.kind;
        $('supNotes').value=x.notes||'';state.supplierPhotoData=x.photo||'';
        const pv=$('supPhotoPreview');if(x.photo){pv.src=x.photo;pv.classList.remove('hide');}else pv.classList.add('hide');
        showMessage('وضع التعديل: عدّل ثم اضغط «حفظ المورّد»','ok');window.scrollTo({top:0,behavior:'smooth'});};
      const tg=el('button',x.active?'تعطيل':'تفعيل','btn sm ghost');tg.type='button';
      tg.onclick=()=>handle(async()=>{await state.api.rpc('rfq_pilot_update_supplier',{p_store:state.store,p_supplier:x.id,p_name:x.name,p_phone:x.phone,p_kind:x.kind,p_photo:x.photo,p_notes:x.notes,p_active:!x.active});
        showMessage(x.active?'عُطّل المورّد':'فُعّل المورّد','ok');await loadSuppliers();});
      line.append(ed,tg);
    }
    box.append(line);
  }
}
// 130: خيارات الأصناف تُملأ وقت الحاجة لا وقت الإقلاع — نموذج الشراء كان يفتح بقائمة فارغة.
function fillDynProductSelect(sel){
  const cur=sel.value;
  sel.replaceChildren();
  const ph=el('option','اختر صنفًا');ph.value='';sel.append(ph);
  for(const pr of state.products.filter(z=>z.active!==false)){const o=el('option',pr.name);o.value=pr.id;sel.append(o);}
  if(cur)sel.value=cur;
}
function refreshDynProductSelects(){
  for(const sel of document.querySelectorAll('.dl-product'))fillDynProductSelect(sel);
}
function dynLine(container,withExpiry,withCost=true){
  const wrap=el('div',null,'dyn-line');
  const sel=el('select');sel.className='dl-product';
  fillDynProductSelect(sel);
  const qty=el('input');qty.type='number';qty.min='0.001';qty.step='0.001';qty.value='1';qty.className='dl-qty';qty.placeholder='الكمية';
  wrap.append(sel,qty);
  let cost=null;
  if(withCost){cost=el('input');cost.type='number';cost.min='0';cost.step='0.01';cost.className='dl-cost';cost.placeholder='التكلفة بالريال';wrap.append(cost);
    sel.onchange=()=>{const pr=state.products.find(z=>z.id===sel.value);if(pr&&cost)cost.value=Number(pr.cost_cents||0)/100;};}
  let exp=null;
  if(withExpiry){exp=el('input');exp.type='date';exp.dir='ltr';exp.className='dl-expiry';exp.title='تاريخ الصلاحية';wrap.append(exp);}
  const rm=el('button','✕','btn sm ghost');rm.type='button';rm.onclick=()=>wrap.remove();wrap.append(rm);
  container.append(wrap);
  return wrap;
}
function readDynLines(container,needCost=true){
  const out=[];
  for(const w of container.querySelectorAll('.dyn-line')){
    const pid=w.querySelector('.dl-product')?.value;if(!pid)continue;
    const q=Number(w.querySelector('.dl-qty')?.value||0);
    const c=needCost?moneyCents(w.querySelector('.dl-cost')?.value||'0'):0;
    const ex=w.querySelector('.dl-expiry')?.value||null;
    if(q>0)out.push({product_id:pid,qty_milli:qtyMilli(String(q)),cost_cents:c,...(ex?{expiry:ex}:{})});
  }
  return out;
}
async function myOpenShiftId(){
  if(state.shift)return state.shift;
  try{const r=await state.api.rpc('rfq_pilot_my_open_shift',{p_store:state.store,p_device:state.device});return r||null;}catch{return null;}
}
async function showSupplierStatement(x){
  const card=$('supplierStatementCard'),box=$('supplierStatement');if(!card||!box)return;
  card.classList.remove('hide');$('supplierStatementTitle').textContent=`كشف: ${x.name}`;
  box.replaceChildren(el('p','جارٍ التحميل من الخادم…','muted'));
  const rows=await state.api.rpc('rfq_pilot_supplier_statement',{p_store:state.store,p_supplier:x.id});
  box.replaceChildren();
  if(!rows?.length){box.append(el('p','لا حركات بعد.','muted'));return;}
  for(const e of rows){
    const line=row(`${SUP_ENTRY_LABEL[e.kind]||e.kind} — ${cents(e.amount_cents)}`,
      `الرصيد: ${cents(e.balance_cents)} • ${stamp(e.created_at)}${e.note?' • '+e.note:''}`);
    box.append(line);
    for(const l of e.lines||[])box.append(row(`↳ ${l.name} ×${Number(l.qty_milli)/1000} @ ${cents(l.cost_cents)}`,`= ${cents(l.line_total_cents)}`));
    if(e.kind==='purchase'&&e.purchase_id&&state.role==='owner'){
      const vb=el('button','إلغاء هذه الفاتورة موثّقًا','btn sm ghost');vb.type='button';
      const vform=el('div',null,'hide');const vr=el('input');vr.placeholder='سبب إلغاء فاتورة الشراء (إلزامي)';vr.maxLength=200;
      const vc=el('button','تأكيد الإلغاء الموثّق','btn sm');vc.type='button';
      vc.onclick=()=>handle(async()=>{if(vr.value.trim().length<3)throw Error('اكتب سببًا واضحًا أولًا');
        await state.api.rpc('rfq_pilot_void_purchase',{p_store:state.store,p_purchase:e.purchase_id,p_reason:vr.value.trim()});
        showMessage('أُلغيت فاتورة الشراء موثّقًا وعاد أثرها','ok');await loadSuppliers();showSupplierStatement(x);await refresh();});
      vform.append(vr,vc);vb.onclick=()=>vform.classList.toggle('hide');box.append(vb,vform);
    }
  }
  card.scrollIntoView({behavior:'smooth'});
}
async function openSalesReturn(invoiceId,number){
  const d=await state.api.rpc('rfq_pilot_invoice_detail',{p_store:state.store,p_invoice:invoiceId});
  if(d.voided_at)throw Error('الفاتورة ملغاة — لا مرتجع عليها');
  const card=$('salesReturnCard');
  if(!card)throw Error('مساحة المرتجع غير موجودة في الواجهة');
  (state.role==='owner'?$('reportsView'):$('posView')).append(card);card.classList.remove('hide');
  card.replaceChildren(el('h2',`مرتجع بيع — فاتورة ${number??d.number}`,'h2'),
    el('p','اختر كمية الإرجاع لكل بند. الردّ: من دين الزبون، أو نقدًا من وردية مفتوحة، أو محفظة/حوالة. السبب إلزامي والمستند لا يُحذف.','muted small'));
  const inputs=[];
  for(const l of d.lines||[]){
    const remain=Number(l.qty_milli)-Number(l.returned_milli||0);
    const wrap=el('div',null,'row');const inp=el('input');inp.type='number';inp.min='0';inp.max=remain/1000;inp.step='0.001';inp.value='0';inp.style.maxWidth='110px';
    wrap.append(el('span',`${l.name} — مباع ${Number(l.qty_milli)/1000}، متبقٍّ للإرجاع ${remain/1000} @ ${cents(l.price_cents)}`),inp);
    inputs.push({line:l,inp});card.append(wrap);
  }
  const method=el('select');for(const [v,t] of [['debt','خصم من دين الزبون'],['cash','ردّ نقد من الدرج'],['wallet','ردّ بمحفظة'],['transfer','ردّ بحوالة']]){const o=el('option',t);o.value=v;method.append(o);}
  const reason=el('input');reason.placeholder='سبب المرتجع (إلزامي)';reason.maxLength=200;
  const ref=el('input');ref.placeholder='مرجع المحفظة/الحوالة (اختياري)';ref.maxLength=120;
  const submit=el('button','تأكيد مرتجع البيع الموثّق','btn amber wide mt');submit.type='button';
  submit.onclick=()=>handle(async()=>{
    const lines=inputs.filter(x=>Number(x.inp.value)>0).map(x=>({invoice_line_id:x.line.line_id,qty_milli:qtyMilli(x.inp.value)}));
    if(!lines.length)throw Error('اختر كمية إرجاع واحدة على الأقل');
    if(reason.value.trim().length<3)throw Error('اكتب سبب المرتجع');
    const shiftId=method.value==='debt'?null:await myOpenShiftId();
    if(method.value!=='debt'&&!shiftId)throw Error('الردّ النقدي/الإلكتروني يحتاج وردية مفتوحة لهذه الجلسة — أو اختر الخصم من الدين');
    const r=await state.api.rpc('rfq_pilot_sales_return',{p_store:state.store,p_invoice:invoiceId,p_lines:lines,
      p_refund_method:method.value,p_shift:shiftId,p_reason:reason.value.trim(),p_refund_reference:ref.value.trim()||null,p_id:crypto.randomUUID()});
    showMessage(`سُجّل مرتجع بيع بمبلغ ${cents(r.total_cents)} وعاد للمخزون`,'ok');
    card.classList.add('hide');await refresh();
  });
  card.append(el('label','طريقة ردّ المبلغ:'),method,el('label','السبب:'),reason,ref,submit);
  card.classList.remove('hide');card.scrollIntoView({behavior:'smooth'});
}
// wiring (elements exist in the static page)
window.__rafiqContactTarget='';
window.__rafiqContact=(num)=>{const t=window.__rafiqContactTarget&&$(window.__rafiqContactTarget);if(t&&num)t.value=String(num).replace(/[^0-9+]/g,'');};
function pickContact(inputId){
  window.__rafiqContactTarget=inputId;
  if(embedded&&window.RafiqPilotContacts?.pick){window.RafiqPilotContacts.pick();return;}
  showMessage('اختيار الرقم من جهات الاتصال متاح في تطبيق Android فقط — اكتبه يدويًا هنا.','ok');
}
{
  const pc=$('pickCustomerContact');if(pc)pc.onclick=()=>pickContact('customerPhone');
  const ps=$('pickSupplierContact');if(ps)ps.onclick=()=>pickContact('supPhone');
  const sc=$('scanProductBarcode');if(sc)sc.onclick=()=>{window.__rafiqBarcodeTarget='productForm';
    if(embedded&&window.RafiqPilotScanner?.scan)window.RafiqPilotScanner.scan();else showMessage('الكاميرا متاحة في تطبيق Android فقط','ok');};
  const supPhoto=$('supPhoto');if(supPhoto)supPhoto.onchange=()=>handle(async()=>{if(!supPhoto.files?.[0])return;
    state.supplierPhotoData=await fileToDataUrl(supPhoto.files[0],192);
    const pv=$('supPhotoPreview');pv.src=state.supplierPhotoData;pv.classList.remove('hide');});
  const logoF=$('storeLogoFile');if(logoF)logoF.onchange=()=>handle(async()=>{if(!logoF.files?.[0])return;
    state.storeLogoData=await fileToDataUrl(logoF.files[0],256);
    const pv=$('storeLogoPreview');pv.src=state.storeLogoData;pv.classList.remove('hide');});
  const savePf=$('saveStoreProfile');if(savePf)savePf.onclick=()=>handle(async()=>{
    const r=await state.api.rpc('rfq_pilot_save_store_profile',{p_store:state.store,
      p_display_name:$('storeDisplayName').value.trim(),p_phone:$('storeProfilePhone').value.trim(),
      p_address:$('storeAddress').value.trim(),p_footer:$('storeFooter').value.trim(),p_logo:state.storeLogoData||null});
    state.storeProfile=r&&typeof r==='object'?r:state.storeProfile;
    $('storeProfileMsg').textContent='حُفظت تهيئة المتجر — تظهر في الفواتير والكشوف من الآن.';
    showMessage('حُفظت تهيئة المتجر','ok');});
  const supForm=$('supplierForm');if(supForm)supForm.addEventListener('submit',e=>{e.preventDefault();handle(async()=>{
    const body={p_store:state.store,p_name:$('supName').value.trim(),p_phone:$('supPhone').value.trim(),
      p_kind:$('supKind').value,p_photo:state.supplierPhotoData||null,p_notes:$('supNotes').value.trim()};
    if(state.editingSupplier){await state.api.rpc('rfq_pilot_update_supplier',{...body,p_supplier:state.editingSupplier,p_active:true});state.editingSupplier=null;showMessage('حُدّث المورّد','ok');}
    else{await state.api.rpc('rfq_pilot_create_supplier',body);showMessage('أُضيف المورّد','ok');}
    state.supplierPhotoData='';e.target.reset();$('supPhotoPreview')?.classList.add('hide');await loadSuppliers();});});
  // ===== قراءة فواتير المشتريات: تصوير + OCR اقتراحات + مراجعة إلزامية + ترحيل =====
  const ocrDraft={imageSha256:null,thumb:null,rows:[]};
  function ocrEl(tag,txt,cls){const e=document.createElement(tag);if(txt!=null)e.textContent=txt;if(cls)e.className=cls;return e;}
  function ocrRowDefaults(raw){
    const parsed=parseOcrLine(raw||'');
    const guess=(parsed&&parsed.name)||'';
    const byName=guess?state.products.find(p=>String(p.name).trim()===guess.trim()):null;
    const byCode=parsed&&parsed.barcode?state.products.find(p=>String(p.barcode||'')===String(parsed.barcode)):null;
    return {raw:raw||'',name:guess,barcode:(parsed&&parsed.barcode)||'',
      productId:(byCode||byName||{}).id||'',match:byCode?'مطابق للباركود':(byName?'مطابق للاسم':''),
      quantity:(parsed&&parsed.qty>0)?parsed.qty:'',unitCostRiyal:(parsed&&parsed.buy!=null)?parsed.buy:'',
      expiry:'',noExpiry:false,reviewed:false,flags:(parsed&&parsed.flags)||[]};
  }
  function renderOcrRows(){
    const box=$('ocrLinesBox');if(!box)return;
    box.replaceChildren();
    if(!ocrDraft.rows.length){box.append(ocrEl('p','لا بنود بعد — استخرجها من الصورة أو أضف سطرًا يدويًا.','muted small'));return;}
    const table=ocrEl('table','',"log");
    const head=ocrEl('tr');
    for(const t of ['السطر من الفاتورة','الصنف المطابق','الكمية','التكلفة ريال','الصلاحية','المبلغ','✓'])head.append(ocrEl('th',t));
    table.append(head);
    ocrDraft.rows.forEach((r,i)=>{
      const tr=ocrEl('tr');
      const raw=ocrEl('td');raw.append(ocrEl('div',r.raw||'(سطر يدوي)','muted small'));
      if(r.flags&&r.flags.length)for(const f of r.flags)raw.append(ocrEl('div','⚠ '+f,'muted small'));
      if(r.match)raw.append(ocrEl('div','✓ '+r.match,'muted small'));
      tr.append(raw);
      const tdSel=ocrEl('td');const sel=ocrEl('select');
      const op=ocrEl('option','— اختر الصنف —');op.value='';sel.append(op);
      for(const p of state.products.filter(z=>z.active!==false)){const o=ocrEl('option',p.name);o.value=p.id;if(p.id===r.productId)o.selected=true;sel.append(o);}
      sel.onchange=()=>{r.productId=sel.value;r.match=sel.value?'اخترته يدويًا':'';};
      tdSel.append(sel);tr.append(tdSel);
      const tdQ=ocrEl('td');const q=ocrEl('input');q.type='number';q.min='0.001';q.step='0.001';q.value=r.quantity;
      q.oninput=()=>{r.quantity=q.value;ocrTotals();};tdQ.append(q);tr.append(tdQ);
      const tdC=ocrEl('td');const c=ocrEl('input');c.type='number';c.min='0';c.step='0.01';c.value=r.unitCostRiyal;
      c.oninput=()=>{r.unitCostRiyal=c.value;ocrTotals();};tdC.append(c);tr.append(tdC);
      const tdE=ocrEl('td');const ex=ocrEl('input');ex.type='date';ex.dir='ltr';ex.value=r.expiry;
      ex.oninput=()=>{r.expiry=ex.value;r.noExpiry=false;nb.checked=false;};
      const nb=ocrEl('input');nb.type='checkbox';nb.checked=!!r.noExpiry;
      const lbl=ocrEl('label','بلا صلاحية');lbl.prepend(nb);
      nb.onchange=()=>{r.noExpiry=nb.checked;if(nb.checked){r.expiry='';ex.value='';}};
      tdE.append(ex,lbl);tr.append(tdE);
      const tdT=ocrEl('td',(function(){const n=Number(r.quantity||0)*Number(r.unitCostRiyal||0);return n>0?cents(Math.round(n*1000)):'—';})());
      tdT.classList.add('ocr-line-total');tr.append(tdT);
      const tdR=ocrEl('td');const cb=ocrEl('input');cb.type='checkbox';cb.checked=!!r.reviewed;
      cb.onchange=()=>{r.reviewed=cb.checked;};tdR.append(cb);tr.append(tdR);
      const tdX=ocrEl('td');const rm=ocrEl('button','✕','btn sm ghost');rm.type='button';
      rm.onclick=()=>{ocrDraft.rows.splice(i,1);renderOcrRows();};tdX.append(rm);tr.append(tdX);
      table.append(tr);
    });
    box.append(table);
    ocrTotals();
  }
  function ocrSum(){return ocrDraft.rows.reduce((t,r)=>t+Math.round(Number(r.quantity||0)*Number(r.unitCostRiyal||0)*1000),0);}
  function ocrTotals(){
    const el2=$('ocrSumLine');if(!el2)return;
    el2.textContent='مجموع البنود: '+cents(ocrSum())+' — يجب أن يطابق إجمالي الفاتورة المطبوع تمامًا.';
  }
  async function normalizeInvoiceImage(file){
    let bmp=null;
    try{bmp=await createImageBitmap(file,{imageOrientation:'from-image'});}catch{bmp=await createImageBitmap(file);}
    const scale=Math.min(1,1400/Math.max(bmp.width,bmp.height));
    const w=Math.max(1,Math.round(bmp.width*scale)),h=Math.max(1,Math.round(bmp.height*scale));
    const cv=document.createElement('canvas');cv.width=w;cv.height=h;
    cv.getContext('2d').drawImage(bmp,0,0,w,h);
    if(bmp.close)bmp.close();
    return cv.toDataURL('image/jpeg',0.82);
  }
  async function enhanceForOcr(file){
    // تجربة مختبرية على صورة فاتورة حرارية حقيقية (750px مضغوطة): التكبير ≥2200 + رمادي + تباين
    // رفعت الأسطر القابلة للاستخدام من 0 إلى 10/35؛الصورة الأصلية الكبيرة تُقرأ كما هي دون تصغير.
    let bmp=null;
    try{bmp=await createImageBitmap(file,{imageOrientation:'from-image'});}catch{bmp=await createImageBitmap(file);}
    const scale=Math.max(1,2200/Math.max(bmp.width,bmp.height));
    const w=Math.max(1,Math.round(bmp.width*scale)),h=Math.max(1,Math.round(bmp.height*scale));
    const cv=document.createElement('canvas');cv.width=w;cv.height=h;
    const ctx=cv.getContext('2d');
    try{ctx.filter='grayscale(1) contrast(1.25) brightness(1.04)';}catch{}
    ctx.imageSmoothingQuality='high';
    ctx.drawImage(bmp,0,0,w,h);
    if(bmp.close)bmp.close();
    return cv.toDataURL('image/jpeg',0.92);
  }
  const capBtn=$('ocrCaptureBtn');if(capBtn)capBtn.onclick=()=>$('ocrFile').click();
  const ocrFile=$('ocrFile');if(ocrFile)ocrFile.onchange=()=>handle(async()=>{
    const f=ocrFile.files&&ocrFile.files[0];if(!f)return;
    if(f.size>15*1024*1024)throw Error('الصورة أكبر من 15 ميغا — التقطها من الكاميرا مباشرة');
    const buf=new Uint8Array(await f.arrayBuffer());
    ocrDraft.imageSha256=bytesHex(sha256Bytes(buf));
    ocrDraft.thumb=await normalizeInvoiceImage(f);
    ocrDraft.ocrImage=await enhanceForOcr(f); // صورة القراءة فقط — غير محفوظة في الفاتورة
    const img=$('ocrImagePreview');img.src=ocrDraft.thumb;img.classList.remove('hide');
    $('ocrImageMeta').textContent='بصمة الصورة محفوظة ('+ocrDraft.imageSha256.slice(0,12)+'…) — الصورة على هذا الجهاز فقط ولا تُرفع لأي مكان.';
    $('ocrRunBtn').disabled=false;
    $('ocrStatus').textContent='الصورة جاهزة — اضغط «استخراج البنود» أو أدخلها يدويًا.';
    if(!$('ocrInvoiceDate').value)$('ocrInvoiceDate').value=new Date().toISOString().slice(0,10);
  });
  async function runLocalOcr(dataUrl,onProgress){
    const T=window.Tesseract;
    if(!T||!T.createWorker)throw Error('محرك القراءة غير متاح هنا — أدخل البنود يدويًا (الإدخال اليدوي يعمل دائمًا)');
    const base=new URL('assets/tesseract/',location.href).href;
    const worker=await T.createWorker('ara+eng',1,{ // eng للأرقام — اختُبر: الأسطر المفيدة 10 مقابل 8
      workerPath:base+'worker.min.js',corePath:base+'tesseract-core.wasm.js',
      langPath:base+'lang',gzip:false,
      logger:m=>{if(m&&m.status==='recognizing text'&&onProgress)onProgress(Math.round((m.progress||0)*100));}
    });
    try{const {data}=await worker.recognize(dataUrl||'');
      return (data.lines||[]).map(l=>String(l.text||'').trim()).filter(t=>t.length>1);
    }finally{try{await worker.terminate();}catch{}}
  }
  const runBtn=$('ocrRunBtn');if(runBtn)runBtn.onclick=()=>handle(async()=>{
    if(!ocrDraft.thumb)throw Error('اختر صورة الفاتورة أولًا');
    $('ocrStatus').textContent='جارٍ قراءة الصورة… قد تستغرق نصف دقيقة.';
    const lines=await runLocalOcr(ocrDraft.ocrImage||ocrDraft.thumb,p=>{$('ocrStatus').textContent='جارٍ القراءة… '+p+'٪';});
    if(!lines.length)throw Error('لم يُقرأ أي نص من الصورة — أدخل البنود يدويًا من الجدول أسفل');
    ocrDraft.rows=lines.map(ocrRowDefaults);
    $('ocrStatus').textContent='قُرئ '+lines.length+' سطرًا — كلها اقتراحات. راجعها وأكّدها.';
    renderOcrRows();
  });
  const addRow=$('ocrAddRowBtn');if(addRow)addRow.onclick=()=>{ocrDraft.rows.push(ocrRowDefaults(''));renderOcrRows();};
  const markAll=$('ocrMarkAllBtn');if(markAll)markAll.onclick=()=>{
    for(const r of ocrDraft.rows)r.reviewed=true;
    renderOcrRows();$('ocrRulesMsg').textContent='أُكدت كل البنود — راجع الأرقام قبل الترحيل.';
  };
  const postBtn=$('ocrPostBtn');if(postBtn)postBtn.onclick=()=>handle(async()=>{
    const msg=$('ocrRulesMsg');msg.textContent='';
    const draft={
      reviewedByOwner:ocrDraft.rows.length>0&&ocrDraft.rows.every(r=>r.reviewed),
      imageSha256:ocrDraft.imageSha256,
      supplierId:$('ocrSupplier').value||null,
      invoiceDateIso:$('ocrInvoiceDate').value||'',
      invoiceRef:$('ocrInvoiceRef').value.trim(),
      paymentType:$('ocrPayType').value,
      declaredTotalCents:Math.round(Number($('ocrDeclaredTotal').value||0)*1000),
      paidCents:Math.round(Number($('ocrPaid').value||0)*1000),
      lines:ocrDraft.rows.map(r=>({
        productId:r.productId||null,
        quantity:Number(r.quantity||0),
        unitCostCents:Math.round(Number(r.unitCostRiyal||0)*1000),
        expiryIso:r.noExpiry?null:(r.expiry||null),
        expiryRequired:!r.noExpiry,
        reviewed:!!r.reviewed
      }))
    };
    const v=validatePurchaseDraft(draft);
    if(!v.ok){msg.textContent='⛔ '+v.reason;return;}
    const shiftId=$('ocrFromShift').checked&&v.paid_cents>0?await myOpenShiftId():null;
    if($('ocrFromShift').checked&&v.paid_cents>0&&!shiftId)throw Error('لا وردية مفتوحة — ألغِ خيار الدرج أو افتح وردية أولًا');
    const r=await state.api.rpc('rfq_pilot_save_purchase_v3',{
      p_store:state.store,p_supplier:draft.supplierId,
      p_lines:ocrDraft.rows.map(x=>({product_id:x.productId,qty_milli:Math.round(Number(x.quantity||0)*1000),
        cost_cents:Math.round(Number(x.unitCostRiyal||0)*1000),expiry:x.noExpiry?null:(x.expiry||null),
        expiry_date:x.noExpiry?null:(x.expiry||null)})),
      p_paid_cents:v.paid_cents,p_note:'فاتورة مورّد مقروءة من الصورة — رقم '+draft.invoiceRef,
      p_shift_id:shiftId,p_pay_method:$('ocrPayMethod').value,
      p_invoice_ref:draft.invoiceRef,p_invoice_date:draft.invoiceDateIso,
      p_image_sha256:draft.imageSha256,p_image_thumb:ocrDraft.thumb,
      p_declared_total_cents:v.total_cents,
      p_idempotency_key:(globalThis.crypto&&crypto.randomUUID)?crypto.randomUUID():('p-'+Date.now())
    });
    showMessage(`حُفظت فاتورة الشراء: إجمالي ${cents(r.total_cents)} — الباقي دين على المتجر في كشف المورّد`,'ok');
    ocrDraft.rows=[];ocrDraft.imageSha256=null;ocrDraft.thumb=null;
    $('ocrImagePreview').classList.add('hide');$('ocrRunBtn').disabled=true;
    $('ocrInvoiceRef').value='';$('ocrDeclaredTotal').value='';$('ocrPaid').value='0';
    renderOcrRows();await loadSuppliers();await refresh();
  });
  renderOcrRows();

  const addPL=$('addPurchaseLine');if(addPL)addPL.onclick=()=>dynLine($('purchaseLines'),true);
  const addRL=$('addReturnLine');if(addRL)addRL.onclick=()=>dynLine($('returnLines'),false);
  if($('purchaseLines')&&!$('purchaseLines').children.length)dynLine($('purchaseLines'),true);
  if($('returnLines')&&!$('returnLines').children.length)dynLine($('returnLines'),false);
  const purForm=$('purchaseForm');if(purForm)purForm.addEventListener('submit',e=>{e.preventDefault();handle(async()=>{
    const lines=readDynLines($('purchaseLines'),true);if(!lines.length)throw Error('أضف بند شراء واحدًا على الأقل');
    const paid=moneyCents($('purPaid').value||'0');
    const shiftId=$('purFromShift').checked&&paid>0?await myOpenShiftId():null;
    if($('purFromShift').checked&&paid>0&&!shiftId)throw Error('لا وردية مفتوحة لهذه الجلسة — ألغِ خيار الدرج أو افتح وردية أولًا');
    const r=await state.api.rpc('rfq_pilot_save_purchase_v2',{p_store:state.store,p_supplier:$('purSupplier').value,
      p_lines:lines,p_paid_cents:paid,p_note:$('purNote').value.trim(),p_shift_id:shiftId,p_pay_method:$('purPayMethod').value});
    showMessage(`حُفظت فاتورة الشراء: إجمالي ${cents(r.total_cents)} — الباقي دين على المتجر في كشف المورّد`,'ok');
    e.target.reset();$('purchaseLines').replaceChildren();dynLine($('purchaseLines'),true);await loadSuppliers();await refresh();});});
  const payForm=$('supplierPayForm');if(payForm)payForm.addEventListener('submit',e=>{e.preventDefault();handle(async()=>{
    const shiftId=$('payFromShift').checked?await myOpenShiftId():null;
    if($('payFromShift').checked&&!shiftId)throw Error('لا وردية مفتوحة لهذه الجلسة');
    await state.api.rpc('rfq_pilot_supplier_payment_v2',{p_store:state.store,p_supplier:$('paySupplier').value,
      p_amount_cents:moneyCents($('payAmount').value),p_note:$('payNote').value.trim(),p_shift_id:shiftId,p_pay_method:$('payMethod').value});
    showMessage('سُجّلت دفعة المورّد','ok');e.target.reset();await loadSuppliers();await refresh();});});
  const retForm=$('supplierReturnForm');if(retForm)retForm.addEventListener('submit',e=>{e.preventDefault();handle(async()=>{
    const lines=readDynLines($('returnLines'),false);if(!lines.length)throw Error('أضف بند مرتجع واحدًا على الأقل');
    for(const l of lines){const pr=state.products.find(z=>z.id===l.product_id);l.cost_cents=Number(pr?.cost_cents||0);}
    const r=await state.api.rpc('rfq_pilot_supplier_return',{p_store:state.store,p_supplier:$('retSupplier').value,p_lines:lines,p_note:$('retNote').value.trim()});
    showMessage(`سُجّل مرتجع للمورّد بقيمة ${cents(r.total_cents)} وخفّض دين المتجر`,'ok');
    e.target.reset();$('returnLines').replaceChildren();dynLine($('returnLines'),false);await loadSuppliers();await refresh();});});
  const pi=$('printInvoice'),rb=$('returnLatestBtn');
  if(pi&&rb)rb.onclick=()=>handle(async()=>{const inv=state.invoice;if(!inv||inv.provisional||!inv.invoice_id)throw Error('لا فاتورة مؤكدة في هذه الجلسة بعد');await openSalesReturn(inv.invoice_id,inv.number);});
  const prn=$('printSupplierStatement');if(prn)prn.onclick=()=>handle(async()=>{
    const card=$('supplierStatementCard');if(!card||card.classList.contains('hide'))throw Error('افتح كشف مورّد أولًا');
    const out=$('printArea');out.className='';out.replaceChildren();
    if(state.storeProfile?.logo){const im=el('img');im.src=state.storeProfile.logo;im.className='print-logo';out.append(im);}
    out.append(el('h1',storeTitle()),el('p',$('supplierStatementTitle').textContent+' • '+new Date().toLocaleString('ar-YE')));
    const src=$('supplierStatement');for(const n of src.childNodes)out.append(n.cloneNode(true));
    printPage();});
}

function arabicDigits(t){return String(t).replace(/[٠-٩]/g,d=>'٠١٢٣٤٥٦٧٨٩'.indexOf(d));}
function voiceFindCustomer(text){
  return (state.customers||[]).filter(c=>c&&c.active!==false&&c.name&&text.includes(c.name))
    .sort((a,b)=>b.name.length-a.name.length)[0]||null;
}
async function applyVoiceCommand(raw){
  const text=arabicDigits(raw||'').trim();
  if(!text)throw Error('لم أسمع شيئًا واضحًا؛ حاول مرة أخرى');
  if(state.role==='worker'&&!state.voiceApproved)throw Error('صوتك غير معتمد من المالك بعد؛ فعّله من الإعدادات');
  // أمر صوتي قيد المراجعة: قاعدة المالك — ما عدا البيع النقدي/الآجل يُراجَع ويُؤكَّد صوتيًا دون لمس.
  const pv=state.pendingVoice;
  if(pv){
    if(/^(نعم|أكّد|اكد|تأكيد|موافق|تمام|نفّذ|نفذ)/.test(text)){state.pendingVoice=null;await pv.run();}
    else if(/^(لا|إلغاء|الغاء|ألغ|الغ|أوقف|اوقف|تراجع)/.test(text)){state.pendingVoice=null;showMessage('أُلغي الأمر الصوتي — لم يُنفَّذ شيء.','ok');}
    else showMessage('عندك أمر بانتظار قرارك: قل «نعم» للتنفيذ أو «لا» للإلغاء.','ok');
    return;
  }
  const numMatch=text.match(/(\d+(?:\.\d+)?)/);
  // تحصيل صوتي بمراجعة وتأكيد صوتي: «حصّل من فلان 5000» — نفس مسار نموذج التحصيل حرفيًا.
  if(/حصّل|حصل|تحصيل|استلم|اقبض/.test(text)){
    if(state.role!=='worker'||!state.lease||!(state.shift||state.localShift))throw Error('التحصيل الصوتي للعامل المعتمد صاحب البصمة في وردية مفتوحة فقط');
    if(state.localShift&&state.localShift.closing)throw Error('الوردية المؤقتة أُغلقت محليًا — لا تحصيل بعد الإغلاق المؤقت');
    const cust=voiceFindCustomer(text);
    if(!cust)throw Error('لم أتعرف على الزبون؛ قل مثلًا: حصّل من فلان 5000');
    const amount=numMatch?Math.round(Number(numMatch[1])*100):0;
    if(!(amount>0))throw Error('قل مبلغ التحصيل مثل: حصّل من فلان 5000');
    state.pendingVoice={run:async()=>{
      assertWritable();
      const local=!!state.localShift;
      const shiftRef=state.shift||(state.localShift&&state.localShift.id);
      const r=await pendingOperation('collection','rfq_pilot_collect_debt_v2',{
        p_shift:shiftRef,p_device:state.device,p_event:crypto.randomUUID(),
        p_customer:cust.id,p_amount_cents:amount,p_method:'cash',p_reference:null});
      const prov=!!(r&&r.provisional);
      collectionReceiptDom({provisional:prov,amount_cents:amount,customer:cust.name,local});
      showMessage(prov?'حُفظ التحصيل الصوتي على الهاتف — وصل مؤقت «بانتظار المزامنة» حتى إقرار الخادم.':'قُبل التحصيل الصوتي في الخادم.','ok');
      await refresh();
    }};
    showMessage(`راجع التحصيل: ${cents(amount)} من ${cust.name} نقدًا — قل «نعم» للتأكيد أو «لا» للإلغاء؛ لن يُنفَّذ شيء قبل نعمك.`,'ok');
    return;
  }
  // استعلام رصيد صوتي: «رصيد فلان»
  if(/رصيد|كم على|حساب/.test(text)){
    const cust=voiceFindCustomer(text);
    if(!cust)throw Error('لم أتعرف على الزبون؛ قل مثلًا: رصيد فلان');
    const bal=await state.api.rpc('rfq_pilot_customer_balance',{p_store:state.store,p_device:state.device,p_customer:cust.id});
    showMessage(`${cust.name} • الرصيد المستحق: ${cents(Number(bal)||0)}`,'ok');
    return;
  }
  const product=state.products.filter(x=>x.active!==false&&text.includes(x.name))
    .sort((a,b)=>b.name.length-a.name.length)[0];
  if(!product){
    $('productSearch').value=text;renderProductMatches();
    throw Error('لم أتعرف على الصنف؛ قل اسمه بوضوح مثل: أضف شاي تجريبي 2');
  }
  // الكمية من بقية الجملة بعد حذف اسم الصنف — أسماء الأصناف نفسها تحوي أرقامًا (5 كجم، 400 جرام…)
  const rest=text.replace(product.name,' ');
  const restNum=rest.match(/(\d+(?:\.\d+)?)/);
  const qty=restNum?Number(restNum[1]):1;
  const qtyMilli=Math.round(qty*1000);
  const line=state.cart.find(l=>l.product_id===product.id);
  if(line)line.qty_milli+=qtyMilli;
  else state.cart.push({product_id:product.id,name:product.name,price_cents:Number(product.price_cents),qty_milli:qtyMilli});
  // طلب المالك (2026-10-23): «+ أضف إلى السلة» يُفرّغ خانات المدفوع — الدفع مرة واحدة في النهاية
  for(const id of ['cashPaid','otherPaid','otherReference']){const f=$(id);if(f)f.value='';}
  renderCart();
  showMessage(`أُضيف صوتيًا: ${product.name} ×${qty} — راجع السلة ثم أكّد البيع بلمس زر الحفظ`,'ok');
}
window.__rafiqVoice=text=>{handle(()=>applyVoiceCommand(text));};
async function handle(action){try{await action();}catch(e){showMessage(e.message||'تعذر إكمال الطلب');if(state.role==='owner'&&!$('homeView').children.length)workspaceFeedback(friendlyError(String(e.message||e)),true);}}
async function signIn(ev){ev.preventDefault();await handle(async()=>{
  if(!state.api)throw Error('هيّئ المشروع أولاً');
  const user=await state.api.signIn($('email').value,$('password').value);$('password').value='';state.user=user;
  const membership=await state.api.table('rfq_pilot_members',{
    user_id:`eq.${user.id}`,active:'eq.true',select:'store_id,role',limit:'2'});
  if(membership.length!==1){try{await state.api.signOut();}catch{state.api.clear();}
    state.user=null;throw Error('حسابك يحتاج عضوية واحدة معتمدة في متجر الاختبار');}
  await enterSession(user,membership[0]);
});}
async function logout(){
  ownerSessionEpoch++;state.sellerMode=false;state.ownerSessionState=null;
  const api=state.api;state.user=null;state.store=null;state.role=null;state.lease=false;state.shift=null;state.cart=[];
  $('who').hidden=true;$('logout').hidden=true;$('menuToggle').hidden=true;closeDrawer();
  if(state.mode==='offline'){state.api=null;showPinScreen();return;}
  screen('login');$('latestInvoice').textContent='لا توجد فاتورة مؤكدة في هذه الجلسة.';
  try{if(api)await api.signOut();}catch{api?.clear();showMessage('خروج محلي؛ قد تبقى الجلسة الخادمية حتى انتهاء إيجارها.');}
}

const voiceBtn=$('voiceAdd');
if(voiceBtn)voiceBtn.onclick=()=>handle(async()=>{
  if(window.RafiqPilotVoice?.start){window.RafiqPilotVoice.start();showMessage('تحدث الآن: قل اسم الصنف والكمية','ok');return;}
  const SR=window.webkitSpeechRecognition||window.SpeechRecognition;
  if(!SR)throw Error('التعرف الصوتي غير متاح على هذا الجهاز');
  const rec=new SR();rec.lang='ar-YE';rec.interimResults=false;
  rec.onresult=e=>{window.__rafiqVoice(e.results[0][0].transcript);};
  rec.onerror=()=>showMessage('تعذر سماع الصوت؛ حاول مرة أخرى');
  rec.start();showMessage('تحدث الآن: قل اسم الصنف والكمية','ok');
});
function collectMsgPayload(extra={}){
  const tpl={};
  const t1=$('tplCreditSale')?.value.trim(),t2=$('tplCollection')?.value.trim(),t3=$('tplReminder')?.value.trim(),t4=$('tplOwnerAlert')?.value.trim();
  if(t1)tpl.credit_sale=t1;if(t2)tpl.collection=t2;if(t3)tpl.reminder=t3;if(t4)tpl.owner_alert=t4;
  return {master_enabled:$('msgMaster').checked,whatsapp_enabled:$('msgWhatsappOn').checked,
    wa_invoice_mode:$('msgWaInvoiceMode')?.value||'text',
    sms_enabled:$('msgSmsOn').checked,whatsapp_phone:$('msgWhatsappPhone').value.trim(),
    owner_alert_phone:$('msgOwnerPhone').value.trim(),
    sms_sender_device_id:state.msgSettings?.sms_sender_device_id||null,
    sms_sender_physical:state.msgSettings?.sms_sender_physical||null,
    low_stock_milli:state.msgSettings?.low_stock_milli??1000,
    events:{credit_sale:$('msgEvtCredit').checked,collection:$('msgEvtCollection').checked,
      reminder:$('msgEvtReminder').checked,owner_alerts:$('msgEvtOwner').checked},
    reminder:{enabled:$('msgReminderOn').checked,min_balance_cents:moneyCents($('msgReminderMin').value||'0'),
      max_per_customer:2,quiet_start:Number($('msgQuietStart')?.value||21),quiet_end:Number($('msgQuietEnd')?.value||7)},
    greeting_footer:$('msgFooter')?.value.trim()||'',templates:tpl,...extra};
}
const saveMsgBtn=$('saveMsgSettings');
if(saveMsgBtn)saveMsgBtn.onclick=()=>handle(async()=>{
  for(const id of ['tplCreditSale','tplCollection','tplReminder','tplOwnerAlert']){
    const v=$(id)?.value.trim()||'';
    if(v.length>320)throw Error('نص الرسالة تجاوز ٣٢٠ حرفًا؛ قصّره قليلًا');
  }
  state.msgSettings=await state.api.rpc('rfq_pilot_save_message_settings',{p_store:state.store,p:collectMsgPayload()});
  showMessage('حُفظت إعدادات الرسائل وقوالبها على الخادم','ok');loadSettingsPanels();pumpSms().catch(()=>{});
});
const smsDeviceBtn=$('setSmsDevice');
if(smsDeviceBtn)smsDeviceBtn.onclick=()=>handle(async()=>{
  const b0=bridge();const phys=b0&&typeof b0.physicalId==='function'?String(b0.physicalId()||''):'';
  // إصلاح 123: اجمع حالة النموذج الحالية أولًا حتى لا تمسح إعادة الرسم مفاتيح غير محفوظة، وسجّل الهوية الفيزيائية للهاتف.
  const payload=collectMsgPayload({sms_sender_device_id:state.device,sms_sender_physical:phys||state.msgSettings?.sms_sender_physical||null});
  state.msgSettings=await state.api.rpc('rfq_pilot_save_message_settings',{p_store:state.store,p:payload});
  showMessage('عُيّن هذا الهاتف مرسل SMS للمتجر — سيُرسل بجلسة أي عضو على هذا الهاتف نفسه','ok');loadSettingsPanels();pumpSms().catch(()=>{});
});
const stickySaleBtn=$('postSaleSticky');
// بناء 145: النافذة والشريط العائم إلى body مباشرة — فالتحويب داخل السلف يكسر position:fixed
if(stickySaleBtn)document.body.appendChild(stickySaleBtn);
{const rsModal=$('saleReview');if(rsModal)document.body.appendChild(rsModal);}
if(stickySaleBtn)stickySaleBtn.onclick=()=>{if(state.saleOff){showMessage(state.saleOffReason||'البيع غير متاح الآن');return;}openSaleReview();};
const themeBtn=$('themeToggle');
function applyThemeLabel(){if(themeBtn)themeBtn.textContent=document.body.classList.contains('dark')?'☀️ الوضع الفاتح':'🌙 الوضع الليلي';}
if(themeBtn)themeBtn.onclick=()=>{const dark=document.body.classList.toggle('dark');
  try{localStorage.setItem('rafiq-theme',dark?'dark':'light');}catch{}applyThemeLabel();};
applyThemeLabel();
const remindBtn=$('sendReminders');
function dayGreeting(){const h=new Date().getHours();if(h>=5&&h<12)return 'صباح الخير';if(h>=12&&h<17)return 'نهارك سعيد';if(h>=17&&h<23)return 'مساء الخير';return 'ليلة هادئة';}
function todayLine(){try{return new Intl.DateTimeFormat('ar',{weekday:'long',day:'numeric',month:'long',year:'numeric'}).format(new Date());}catch{return '';}}
const MSG_DEFAULTS={credit_sale:'بيع آجل: {amount} ريال\nرصيدك المستحق: {balance} ريال',collection:'استلمنا منك: {amount} ريال\nالمتبقي: {balance} ريال',reminder:'تذكير ودي: رصيدك المستحق {balance} ريال',owner_alert:'عملية جديدة: {amount} ريال\nرصيد الزبون: {balance} ريال'};
function smsSegments(len){return len<=70?1:1+Math.ceil((len-70)/67);}
function estMsgLen(tpl){const store=state.storeName||'متجرك';return tpl.split('{store}').join(store).split('{amount}').join('5000').split('{balance}').join('5000').length;}
function updateFooterEstimate(){const box=$('footerEstimate');if(!box)return;const f=($('msgFooter')?.value||'').trim();
  const tpl=($('tplCreditSale')?.value.trim())||MSG_DEFAULTS.credit_sale;
  const base=estMsgLen(tpl);const total=f?base+1+f.length:base;
  box.textContent=`رسالة البيع الآجل ≈ ${total} حرف = ${smsSegments(total)} ${smsSegments(total)===1?'مقطع واحد':'مقاطع'}${f?' (مع التذييل الموسمي)':''} — بمبالغ تجريبية ٥٠٠٠ ريال. القصير أجمل وأسرع، والقرار لك.`;}
for(const id of ['tplCreditSale','tplCollection','tplReminder','tplOwnerAlert','msgFooter']){const n=$(id);if(n)n.addEventListener('input',updateFooterEstimate);}
document.querySelectorAll('[data-footer-preset]').forEach(b=>b.addEventListener('click',()=>{const f=$('msgFooter');if(f){f.value=b.dataset.footerPreset||'';updateFooterEstimate();f.focus();}}));
if(remindBtn)remindBtn.onclick=()=>handle(async()=>{
  const n=await state.api.rpc('rfq_pilot_enqueue_reminders',{p_store:state.store});
  showMessage(`وُضعت ${n} رسالة تذكير في قائمة الإرسال`,'ok');loadSettingsPanels();pumpSms().catch(()=>{});
});
$('setupForm').addEventListener('submit',e=>{e.preventDefault();handle(async()=>{
  const url=projectUrl($('projectUrl').value),key=publicKey($('publicKey').value);
  if(embedded){
    // أمر المالك (الجولة 9): التهيئة من الشاشة الموحدة نفسها عند غياب الإعداد السحابي — القيم
    // تُتحقق هنا وأصليًا، وتُحفَر مشفّرة في Keystore الهاتف عبر الجسر، ولا تُوضع أبدًا في تخزين
    // WebView؛ ثم تُعاد الشاشة الرئيسية لتقلع الواجهة الموحدة بالتكوين الجديد (لا دفتر قديم).
    const b=bridge();
    if(!b||!b.savePilotConfiguration)throw Error('تهيئة مشروع الهاتف تُدار من صفحة المالك المشفّرة داخل التطبيق');
    const res=JSON.parse(b.savePilotConfiguration(url,key)||'{}');
    if(!res.ok)throw Error(res.error==='invalid'?'رابط المشروع أو المفتاح العام غير صالح':'تعذر حفظ التهيئة على هذا الهاتف — لم يُحفظ شيء');
    $('publicKey').value='';
    showMessage('حُفظت تهيئة المشروع مشفّرة على الهاتف — يُعاد فتح الواجهة الموحدة الآن.','ok');
    if(b.restartForConfiguration)b.restartForConfiguration();
    return;
  }
  state.api=new PilotApi(url,key);try{localStorage.setItem('rafiq-test-web-config',JSON.stringify({url,key}));}catch{}
  $('publicKey').value='';screen('login');showMessage('حُفظت بيانات المشروع العامة محلياً؛ لم يُرسل أي ملف أو فاتورة.','ok');
});});
$('loginForm').addEventListener('submit',signIn);
$('logout').onclick=logout;
$('changeProject').onclick=()=>{if(embedded)return;logout();state.api=null;screen('setup');};
$('modeSwitchLogin').onclick=()=>showModeScreen(); // العودة إلى شاشة الخيارين من أي وقت
if(embedded){
  $('changeProject').hidden=true;
  // A native WebView interception serves only public config from THIS phone's Keystore.
  // Never copy that config to WebView localStorage, a URL, or the old Room database.
  bootCloudConfig();
}
function bootCloudConfig(){ // يُستدعى عند الإقلاع وعند اختيار «بالإنترنت» — فالتفعيل قد يحدث بعد الإقلاع
  if(!embedded||state.mode==='offline'||!launchActivated())return Promise.resolve();
  return fetch('/rafiq-config',{cache:'no-store'}).then(async response=>{
    if(state.mode==='offline'||!launchActivated())return;
    // أمر المالك (الجولة 9): إقلاع بلا إعداد سحابي محفوظ = وضع تهيئة من الشاشة الموحدة نفسها.
    if(response.status===404){showMessage('لم يُهيَّأ مشروع سحابي على هذا الهاتف بعد — أدخل رابطه ومفتاحه العام للبدء.','ok');
      if(state.mode==='online'&&!state.api)screen('setup');return;}
    if(!response.ok)throw Error('لم تُحمَّل تهيئة مشروع الاختبار من الهاتف');
    const {url,key}=await response.json();state.api=new PilotApi(url,key);
    $('projectUrl').value=state.api.url;$('publicKey').value='';screen('login');
    tryRestoreSession();
  }).catch(error=>showMessage(error.message));
}
for(const [bid,kind] of [['exportInvoices','invoices'],['exportCustomers','customers'],['exportDebts','debts']]){
  const btn=$(bid);if(btn)btn.onclick=()=>handle(async()=>{showMessage(await exportCsv(kind),'ok');});
}
if($('openArchive'))$('openArchive').onclick=()=>{const b=bridge();
  if(b&&b.openLocalArchive)b.openLocalArchive();else showMessage('أرشيف الهاتف المحلي متاح داخل تطبيق الهاتف فقط.');};
$('reload').onclick=()=>handle(async()=>{
  haptic();uiTapSound();spinRefresh($('reload'),true); // طلب المالك: دوران + صوت + اهتزاز
  try{await safeRefresh();showMessage(state.serverDown?'الخادم غير متاح الآن — بقيت على النسخة المحلية الصادقة.':'حالة المتجر محدثة.','ok');}
  finally{spinRefresh($('reload'),false);}
});
for(const b of document.querySelectorAll('[data-view]'))b.onclick=()=>goTo(b.dataset.view);
$('menuToggle').onclick=()=>openDrawer();
$('menuClose').onclick=closeDrawer;
$('drawerScrim').onclick=closeDrawer;
const _bm=$('bottomMore');if(_bm)_bm.onclick=openDrawer;
{const ts=$('tabSale');if(ts)ts.onclick=()=>{closeDrawer();if(state.role==='owner'&&!state.sellerMode)return handle(enterOwnerSeller);goTo('pos');};}
window.addEventListener('keydown',e=>{if(e.key==='Escape')closeDrawer();});
$('catalogSearch').addEventListener('input',renderCatalog);
$('productSearch').addEventListener('input',renderProductMatches);
$('productSearch').addEventListener('keydown',e=>{
  if(e.key!=='Enter')return;e.preventDefault();
  const text=$('productSearch').value.trim();
  const matches=searchCatalog(text),exact=matches.filter(p=>p.barcode===text);
  const chosen=exact.length===1?exact[0]:matches.length===1?matches[0]:null;
  if(chosen){$('saleProduct').value=chosen.id;$('productMatches').classList.add('hide');$('productSearch').blur();
    showMessage(`${chosen.name} — اختر الكمية ثم اضغط إضافة إلى السلة.`, 'ok');}
  else showMessage(matches.length?'اختر صنفاً من النتائج قبل إضافته للسلة.':'الصنف غير موجود في قائمة المتجر.');
});
$('openProductList').onclick=()=>setView('products');
$('scanBarcode').onclick=()=>{
  if(embedded&&typeof window.RafiqPilotScanner?.scan==='function')window.RafiqPilotScanner.scan();
  else{$('productSearch').focus();showMessage('اكتب الباركود أو اسم الصنف؛ ماسح الكاميرا متاح في تطبيق Android فقط.','ok');}
};
// The Android scanner only returns a barcode string. No sale, stock, or database
// write is triggered from a camera callback: the worker must still confirm the cart.
window.__rafiqBarcodeTarget='';
window.__rafiqPilotBarcode=(barcode)=>{
  const text=String(barcode||'').trim().slice(0,80);if(!text)return;
  if(window.__rafiqBarcodeTarget==='productForm'){window.__rafiqBarcodeTarget='';const pb=$('productBarcode');if(pb){pb.value=text;pb.focus();}showMessage('التُقط الباركود في نموذج الصنف','ok');return;}
  $('productSearch').value=text;renderProductMatches();
  const exact=state.products.filter(p=>p.active!==false&&p.barcode===text);
  if(exact.length===1){$('saleProduct').value=exact[0].id;$('productMatches').classList.add('hide');$('productSearch').blur();
    showMessage(`${exact[0].name} — أضف الصنف إلى السلة بعد اختيار الكمية.`,'ok');}
  else showMessage(exact.length?'الباركود مكرر؛ راجع الأصناف قبل البيع.':'لا يوجد صنف بهذا الباركود؛ راجع قائمة الأصناف.');
};
setInterval(()=>{if(navigator.onLine)syncAll().catch(()=>{});},45000); // No SMS sender in this release.
$('addItem').onclick=()=>handle(async()=>{
  const product=state.products.find(p=>p.id===$('saleProduct').value);
  if(!product)throw Error('اختر صنفاً');const qty=qtyMilli($('saleQty').value);
  if(state.cart.some(l=>l.product_id===product.id))throw Error('الصنف موجود بالسلة؛ احذفه لتعديل الكمية');
  state.cart.push({product_id:product.id,name:product.name,price_cents:Number(product.price_cents),qty_milli:qty});
  // طلب المالك (2026-10-23): «+ أضف إلى السلة» يُفرّغ خانات المدفوع — الدفع مرة واحدة في النهاية
  for(const id of ['cashPaid','otherPaid','otherReference']){const f=$(id);if(f)f.value='';}
  renderCart();
  // ملاحظة المالك (2026-10-21): كان باركود/بحث الصنف الأول يبقى عالقًا بالمربع بعد الإضافة
  // فيضطر لحذفه يدويًا قبل اختيار صنف آخر، ولوحة المفاتيح تبقى مفتوحة فتعيق قراءة السلة —
  // ننظّف المربع ونغلق اللوحة ونعيد الكمية للوضع الابتدائي؛ البحث التالي بنقرة أو بزر المسح.
  const ps=$('productSearch');if(ps){ps.value='';ps.blur();}
  $('productMatches')?.classList.add('hide');
  const q=$('saleQty');if(q)q.value='1';
});
$('cashPaid').addEventListener('input',renderCart);
$('saleForm').addEventListener('submit',e=>{e.preventDefault();handle(async()=>{
  if(state.saleSubmitting)throw Error('جارٍ حفظ الفاتورة؛ لا تضغط الحفظ مرة أخرى');
  state.saleSubmitting=true;$('postSale').disabled=true;
  try{await submitSaleOnce();}finally{state.saleSubmitting=false;updateSaleButtons();}
});});
async function submitSaleOnce(){
  assertWritable();
  if(state.role==='owner'){
    if(!state.sellerMode)throw Error('فعّل وضع بيع المالك قبل حفظ البيع');
    if(netReady())await ensureOwnerSellerSession();
  }
  if(!state.lease||!(state.shift||(state.role==='worker'&&state.localShift&&!state.localShift.closing)))
    throw Error(state.role==='owner'?'يلزم استعادة جلسة بيع المالك وورديته المفتوحة؛ لم تُحفظ فاتورة جديدة':'يلزم جلسة عامل معتمدة ووردية مفتوحة (مقرّة من الخادم أو محلية مؤقتة)');
  const previousSale=state.pending||getPending();
  if(previousSale){state.pending=previousSale;updateSaleButtons();throw Error('أعد العملية المعلقة بنفس معرفها قبل إنشاء بيع جديد');}
  if(!state.cart.length)throw Error('السلة فارغة');
  const total=cartTotal(state.cart),paid=moneyCents($('cashPaid').value),other=moneyCents($('otherPaid')?.value||'0'),customer=$('saleCustomer').value||null;
  if(paid+other>total)throw Error('المدفوع (نقد + محفظة/حوالة) أكبر من الفاتورة');
  if(total>paid+other&&!customer)throw Error('اختر زبوناً لفاتورة الدين');
  if(total===paid+other&&customer)throw Error('البيع المدفوع بالكامل لا يحتاج حساب زبون');
  const lines=state.cart.map(({product_id,qty_milli})=>({product_id,qty_milli}));
  const id=crypto.randomUUID();
  state.lastSaleMeta={customer,total,paid,other};
  setPending({id,payload:{p_shift:state.shift||(state.localShift&&state.localShift.id),p_device:state.device,p_invoice:id,
    p_customer:customer,p_lines:lines,p_cash_cents:paid,p_other_cents:other,
    p_other_method:other>0?($('otherMethod')?.value||'wallet'):null,
    p_other_reference:other>0?($('otherReference')?.value.trim()||null):null,
    p_sms_consent:false,_v3:1},snapshot:[...state.cart]});
  await submitPending();
}
function stageSaleIntent(pending){
  if(!validSaleIntent(pending)||!pending.snapshot.length)
    throw Error('حمولة البيع أو لقطة الأسعار ناقصة؛ لا يُرسل طلب إلى الخادم');
  // كتابة واحدة لمسار الإرسال: السجل نفسه في ofx_ops هو ما يقرأه syncPush.
  // إن فشلت الكتابة يبقى معرّف النية في Room لإعادة المحاولة، بلا RPC.
  const id=ofxQueue('invoice',{...pending.payload,_snapshot:pending.snapshot,_actor:state.user?.id},pending.id);
  setPending(null); // رفع قفل النية المؤقتة فقط بعد ثبوت حمولة الطابور بالقراءة
  return id;
}
function restoreQueuedSale(){
  if(!embedded||!['owner','worker'].includes(state.role)||state.invoice)return;
  const b=bridge();if(!b)return;
  const entries=queuedOps(b).filter(o=>o.kind==='invoice'&&sameStoreOp(o));
  const latest=entries.reverse().find(o=>{try{const p=JSON.parse(o.payload);
    return p._actor===state.user?.id&&p.p_device===state.device&&Array.isArray(p._snapshot)&&p._snapshot.length;
  }catch{return false;}});
  if(!latest)return;
  const p=JSON.parse(latest.payload),total=cartTotal(p._snapshot);
  renderInvoice({number:'—',total_cents:total,due_cents:total-Number(p.p_cash_cents)-Number(p.p_other_cents||0),cash_paid_cents:Number(p.p_cash_cents),other_paid_cents:Number(p.p_other_cents||0),other_method:p.p_other_method,
    provisional:true,localId:latest.id},p._snapshot);
}
async function submitPending(){
  if(!state.pending)throw Error('لا توجد عملية معلّقة');
  if(state.role==='owner'&&state.sellerMode&&navigator.onLine)await ensureOwnerSellerSession();
  if(!state.lease||!state.approved)throw Error(state.role==='owner'?'العملية المعلقة تحتاج استعادة جلسة بيع المالك المعتمدة':'العملية المعلقة تحتاج جلسة عامل معتمدة');
  if(embedded&&state.mode!=='offline'){
    const pending=state.pending,id=stageSaleIntent(pending);
    const total=cartTotal(pending.snapshot),paid=Number(pending.payload.p_cash_cents),otherP=Number(pending.payload.p_other_cents||0);
    state.cart=[];renderCart();resetSaleFields();
    renderInvoice({number:'—',total_cents:total,due_cents:total-paid-otherP,cash_paid_cents:paid,other_paid_cents:otherP,other_method:pending.payload.p_other_method,provisional:true,localId:id},pending.snapshot);
    showMessage('حُفظ البيع في قاعدة الهاتف بنفس المعرّف — مستند مؤقت حتى إقرار الخادم.','ok');
    if(navigator.onLine)try{await syncAll();}catch{showMessage('البيع محفوظ على الهاتف؛ تعذّر جلب بيانات الخادم الآن، وستُعاد مزامنته بنفس المعرّف');}
    return;
  }
  if(state.mode!=='offline'&&(!navigator.onLine||state.offlineNow||state.localShift)){
    const snapshot=state.pending.snapshot||[];
    const total=cartTotal(snapshot.length?snapshot:state.cart);
    const paid=Number(state.pending.payload.p_cash_cents||0);
    ofxQueue('invoice',{...state.pending.payload,_snapshot:snapshot},state.pending.id); // يرمي إن فشل الحفظ؛ القيم المتوقعة تُشتق من اللقطة وقت المزامنة
    setPending(null);state.cart=[];renderCart();resetSaleFields();
    showMessage('حُفظ البيع على الهاتف — مستند مؤقت «بانتظار المزامنة» حتى إقرار الخادم.','ok');
    renderInvoice({number:'—',total_cents:total,due_cents:Math.max(total-paid,0),provisional:true},snapshot);
    return;
  }
  // The server also checks identity/device and compares the entire payload for idempotency.
  const {payload,snapshot}=state.pending;
  let result;
  try{result=await state.api.rpc(payload._v3?'rfq_pilot_post_invoice_v3':'rfq_pilot_post_invoice_guarded',guardedInvoiceArgs({...payload,_snapshot:snapshot}));}
  catch(e){
    const msg=String(e&&e.message||e);
    // شرط المالك (الجولة 10): نص الشبكة يُعتبر فقط بلا رمز استجابة — 400 بنص «Network unavailable» أعمال.
    const stp=(e&&Number(e.status))||0;
    if(!stp&&/aborted|Failed to fetch|fetch failed|network|timeout/i.test(msg)){
      ofxQueue('invoice',{...payload,_snapshot:snapshot},state.pending.id);
      const total=cartTotal(snapshot&&snapshot.length?snapshot:state.cart);
      const paid=Number(payload.p_cash_cents||0);
      setPending(null);state.cart=[];renderCart();resetSaleFields();
      showMessage('انقطع الاتصال أثناء الإرسال: العملية محفوظة على الهاتف في طابور المزامنة بنفس المعرف — مستند مؤقت، بلا تكرار.','ok');
      renderInvoice({number:'—',total_cents:total,due_cents:Math.max(total-paid,0),provisional:true},snapshot);return;
    }
    throw e;
  }
  if(!result||!Number.isSafeInteger(result.number)||result.number<1||
     !Number.isSafeInteger(result.total_cents)||result.total_cents<0||
     !Number.isSafeInteger(result.due_cents)||result.due_cents<0||
     result.invoice_id!==state.pending.id)
    throw Error('لم يصل إقرار فاتورة مطابق من الخادم؛ احتفظ بنفس معرّف البيع وأعد المحاولة');
  const localTotal=cartTotal(snapshot),localDue=localTotal-Number(payload.p_cash_cents)-Number(payload.p_other_cents||0);
  if(Number(result.total_cents)!==localTotal||Number(result.due_cents)!==localDue)
    throw Error('تنبيه: أقرّ الخادم مبلغاً مختلفاً عن مستند البيع المؤقت. لا تُسلّم الفاتورة؛ احتفظ بمعرّفها وراجع المالك');
  const confirmedLines=Array.isArray(result.lines)?result.lines:
    await state.api.table('rfq_pilot_invoice_lines',{
      store_id:`eq.${state.store}`,invoice_id:`eq.${result.invoice_id}`,
      select:'invoice_id,product_id,name_snapshot,price_cents,qty_milli',limit:'1000'});
  if(!invoiceLinesAgree(snapshot,confirmedLines,result.invoice_id))
    throw Error('سطور الفاتورة لا تطابق لقطة البيع؛ احتفظ بنفس المعرف وراجع المالك، ولا تُسلّم نسخة مؤكدة');
  setPending(null);renderInvoice(result,snapshot);state.cart=[];renderCart();resetSaleFields();
  showMessage(result.already_committed?'الفاتورة محفوظة سابقاً؛ لم تُكرر.':'أُقرت الفاتورة على '+(state.mode==='offline'?'الجهاز (وضع محلي)':'الخادم')+'.','ok');await refresh();
}
$('retryPending').onclick=()=>handle(submitPending);
$('printInvoice').onclick=printPage;
$('customerForm').addEventListener('submit',e=>{e.preventDefault();handle(async()=>{
  assertWritable();
  const id=crypto.randomUUID();
  // The live endpoint has FIVE arguments. It has no customer SMS-consent storage.
  const cPayload={p_store:state.store,p_device:state.device,p_id:id,
    p_name:$('customerName').value.trim(),p_phone:$('customerPhone').value.trim()};
  try{await state.api.rpc('rfq_pilot_create_customer',cPayload);}
  catch(err){const stc=(err&&Number(err.status))||0;if(stc||!/aborted|Failed to fetch|fetch failed|network|timeout/i.test(String(err&&err.message||err)))throw err; // شرط المالك (الجولة 10): رد أعمال برمز = خطأ صريح لا طابور
    ofxQueue('customer',cPayload,id);showMessage('حُفظ الزبون محليًا بانتظار المزامنة.','ok');e.target.reset();await refresh();return;}
  e.target.reset();showMessage('أُضيف الزبون إلى المتجر.','ok');await refresh();
});});
$('collectionForm').addEventListener('submit',e=>{e.preventDefault();handle(async()=>{
  assertWritable();
  if(state.role!=='worker'||!state.lease||!(state.shift||state.localShift))throw Error('التحصيل للعامل في وردية مفتوحة (خادمية أو محلية مؤقتة) فقط');
  if(state.localShift&&state.localShift.closing)throw Error('الوردية المؤقتة أُغلقت محليًا — لا تحصيل بعد الإغلاق المؤقت');
  const amount=moneyCents($('collectionAmount').value);
  const custId=$('collectionCustomer').value;
  const local=!!state.localShift;
  const shiftRef=state.shift||(state.localShift&&state.localShift.id);
  const r=await pendingOperation('collection','rfq_pilot_collect_debt_v2',{
    p_shift:shiftRef,p_device:state.device,p_event:crypto.randomUUID(),
    p_customer:custId,p_amount_cents:amount,
    p_method:$('collectionMethod')?.value||'cash',
    p_reference:$('collectionReference')?.value.trim()||null});
  e.target.reset();
  const prov=!!(r&&r.provisional);
  collectionReceiptDom({provisional:prov,amount_cents:amount,customer:(state.customers.find(c=>c.id===custId)||{}).name||custId,local});
  showMessage(prov?'حُفظ التحصيل على الهاتف — وصل مؤقت «بانتظار المزامنة» حتى إقرار الخادم.':'قُبل التحصيل في الخادم.','ok');
  await refresh();
});});
$('ownerDebtForm').addEventListener('submit',e=>{e.preventDefault();handle(async()=>{
  assertWritable();
  if(state.role!=='owner')throw Error('المالك فقط');
  const rDebt=await pendingOperation('owner_debt','rfq_pilot_owner_add_debt',{
    p_store:state.store,p_customer:$('debtCustomer').value,p_event:crypto.randomUUID(),
    p_amount_cents:moneyCents($('debtAmount').value),p_reason:$('debtReason').value});
  e.target.reset();showMessage(rDebt&&rDebt.provisional?'حُفظ دين المالك على الهاتف — مستند مؤقت «بانتظار المزامنة» حتى إقرار الخادم.':'قُيد دين المالك في الخادم.','ok');await refresh();
});});
$('retryCollection').onclick=()=>handle(async()=>{
  const r=await retryOperation('collection');showMessage(r&&r.provisional?'التحصيل في طابور المزامنة — مستند مؤقت.':'أُقرت محاولة التحصيل نفسها دون مضاعفة.','ok');await refresh();
});
$('retryOwnerDebt').onclick=()=>handle(async()=>{
  const r=await retryOperation('owner_debt');showMessage(r&&r.provisional?'دين المالك في طابور المزامنة — مستند مؤقت.':'أُقر دين المالك بنفس المعرف دون مضاعفة.','ok');await refresh();
});
$('ownerCashForm').addEventListener('submit',e=>{e.preventDefault();handle(async()=>{
  assertWritable();
  if(state.role!=='owner')throw Error('المالك فقط');
  const rCash=await pendingOperation('owner_cash','rfq_pilot_owner_cash_adjust',{
    p_shift:$('cashShift').value,p_event:crypto.randomUUID(),p_kind:$('cashKind').value,
    p_amount_cents:moneyCents($('cashAmount').value),p_reason:$('cashReason').value});
  e.target.reset();showMessage(rCash&&rCash.provisional?'حُفظت حركة الصندوق على الهاتف — «بانتظار المزامنة» حتى إقرار الخادم.':'سُجلت حركة الصندوق في الخادم.','ok');await refresh();
});});
$('retryOwnerCash').onclick=()=>handle(async()=>{
  const r=await retryOperation('owner_cash');showMessage(r&&r.provisional?'حركة الصندوق في طابور المزامنة — مستند مؤقت.':'أُقرت حركة الصندوق نفسها دون مضاعفة.','ok');await refresh();
});
$('productForm').addEventListener('submit',e=>{e.preventDefault();handle(async()=>{
  assertWritable();
  if(state.role!=='owner')throw Error('المالك فقط');
  const pid=crypto.randomUUID(),stockInput=$('productStock').value.trim();
  const pp={p_store:state.store,p_id:pid,p_name:$('productName').value.trim(),
    p_barcode:$('productBarcode').value.trim(),p_unit:($('productUnit2')?.value||'حبة'),p_category:($('productCategory')?.value||'').trim(),
    p_price_cents:moneyCents($('productPrice').value),p_cost_cents:moneyCents($('productCost').value),
    p_initial_stock_milli:Number(stockInput)===0?0:qtyMilli(stockInput)};
  try{await state.api.rpc('rfq_pilot_save_product',pp);
    const exp=$('productExpiry')?.value;if(exp)await state.api.rpc('rfq_pilot_set_product_expiry',{p_store:state.store,p_product:pid,p_expiry:exp});}
  catch(err){const stpr=(err&&Number(err.status))||0;if(stpr||!/aborted|Failed to fetch|fetch failed|network|timeout/i.test(String(err&&err.message||err)))throw err; // شرط المالك (الجولة 10): رد أعمال برمز = خطأ صريح لا طابور
    ofxQueue('product',pp,pid);showMessage('حُفظ الصنف محليًا «بانتظار المزامنة» — يظهر للمتجر بعد إقرار الخادم.','ok');e.target.reset();await refresh();return;}
  e.target.reset();showMessage('أُضيف صنف للمتجر.','ok');await refresh();
});});
$('stockAdjustmentForm').addEventListener('submit',e=>{e.preventDefault();handle(async()=>{
  assertWritable();if(state.role!=='owner')throw Error('المالك فقط يستطيع تزويد المخزون أو تصحيحه');
  const product=state.products.find(p=>p.id===$('adjustProduct').value&&p.active!==false);
  if(!product)throw Error('اختر صنفاً من المتجر');
  const qty=qtyMilli($('stockQty').value),action=$('stockAction').value;
  if(!Number.isSafeInteger(qty)||qty<=0||qty>1000000000||!['receive','loss'].includes(action))
    throw Error('كمية المخزون غير صالحة');
  const reason=$('stockReason').value.trim();
  if(reason.length<3||reason.length>200)throw Error('اكتب سبباً واضحاً لحركة المخزون');
  const payload={p_store:state.store,p_product:product.id,p_event:crypto.randomUUID(),
    p_delta_milli:action==='receive'?qty:-qty,p_reason:reason};
  if(embedded){
    // Save exactly one owner-authorized, store-bound event to Room before network.
    ofxQueue('stock_adjust',payload,payload.p_event);
    if(navigator.onLine&&!state.serverDown)try{await syncAll();}catch{}
    const r=JSON.parse(bridge().ofxGet(payload.p_event)||'null');
    if(!r)throw Error('لم تثبت حركة المخزون على الهاتف؛ لا تُعد إنشاء حركة جديدة');
    if(r.status==='conflict')throw Error('رفض الخادم حركة المخزون؛ راجع سجل التعارض قبل إعادة المحاولة');
    showMessage(r.status==='confirmed'?'أقر الخادم حركة المخزون.':
      'حُفظت حركة المخزون على الهاتف بانتظار المزامنة؛ لا يعتبر الرصيد مؤكداً.','ok');
  }else{
    if(!navigator.onLine)throw Error('الحفظ دون نت متاح داخل تطبيق الهاتف فقط');
    await state.api.rpc('rfq_pilot_adjust_stock',payload);
    showMessage('أقر الخادم حركة المخزون.','ok');
  }
  e.target.reset();if(navigator.onLine)await safeRefresh();else renderCatalog();
});});

// ===== Mobile workspace revision 127: real forms and one shared data path =====
function updateDeviceNotice(status){
  const box=$('deviceNotice');if(!box)return;
  box.replaceChildren();box.hidden=state.role!=='owner'||status==='approved';
  if(box.hidden){if(status==='approved')state.deviceLimit=false;return;}
  box.append(el('span',state.deviceLimit?'الجهاز ينتظر الاعتماد: حدّ الأجهزة مكتمل. بيانات متجرك متاحة، لكن البيع من هذا الهاتف يحتاج اعتمادًا.':'هذا الهاتف بانتظار الاعتماد. تصفّح متجرك الآن، واعتمد الجهاز قبل البيع.'));
  const b=el('button','إدارة الأجهزة','btn sm');b.type='button';b.onclick=()=>goTo('settings','devicePanel');box.append(b);
}
async function loadOwnerDevices(){
  if(state.role!=='owner'||!state.api?.signedIn||!state.store)return;
  let host=$('ownerDevices');if(!host){const panel=$('devicePanel');if(!panel)return;host=el('div',null,'device-management');host.id='ownerDevices';panel.append(host);}
  const store=state.store,user=state.user?.id,current=state.device;
  const [devices,stores]=await Promise.all([
    state.api.table('rfq_pilot_devices',{store_id:`eq.${store}`,select:'id,user_id,kind,status,created_at,approved_at',order:'created_at.desc',limit:'100'}),
    state.api.table('rfq_pilot_stores',{id:`eq.${store}`,select:'id,seat_limit',limit:'1'})
  ]);
  if(state.store!==store||state.user?.id!==user||state.role!=='owner'||host!==$('ownerDevices'))return;
  host.replaceChildren();const approved=devices.filter(d=>d.status==='approved');
  host.append(el('h3','أجهزة المالك والاعتماد','h2'),el('p',`${approved.length} جهاز معتمد من ${stores[0]?.seat_limit??'—'} · لا نحذف أي جهاز تلقائيًا.`,'muted small'));
  const now=devices.find(d=>d.id===current),kind=now?.kind||(embedded?'owner_phone':'web');
  for(const d of devices){
    const label=d.id===current?'هذا الجهاز':d.kind==='cashier_phone'?'جهاز عامل':d.kind==='web'?'متصفح ويب':'جهاز مالك';
    const item=el('div',null,'device-row'),info=el('div');info.append(el('strong',label),el('small',`${String(d.id).slice(0,8)} · أُضيف ${d.created_at?stamp(d.created_at):'—'}`,'muted'));
    item.append(info,el('span',d.status==='approved'?'معتمد':d.status==='pending'?'بانتظار الاعتماد':'ملغى الاعتماد','status-chip '+(d.status==='approved'?'good':'')));host.append(item);
  }
  if(now?.status!=='pending')return;
  const available=devices.filter(d=>d.id!==current&&d.user_id===user&&d.kind===kind&&d.status==='approved');
  const transfer=el('div',null,'transfer-panel');
  transfer.append(el('strong','نقل اعتماد جهاز مالك قديم إلى هذا الهاتف'),el('p','اختر جهازك القديم الذي لم تعد تستخدمه. سيتوقف اعتماده فقط، ولن تُحذف بياناته أو أجهزة العامل. يجب إغلاق أي وردية أو جلسة بيع عليه أولًا.','muted small'));
  if(!available.length){transfer.append(el('p','لا يوجد جهاز قديم من حسابك ونوع جهازك يمكن نقل اعتماده. لا نغيّر حد الترخيص أو أجهزة الآخرين.','muted small'));host.append(transfer);return;}
  const label=el('label','جهاز المالك القديم');label.htmlFor='replaceDeviceSelect';
  const select=el('select');select.id='replaceDeviceSelect';select.append(el('option','اختر الجهاز القديم…'));select.firstChild.value='';
  for(const d of available){const o=el('option',`${String(d.id).slice(0,8)} · ${stamp(d.created_at)}`);o.value=d.id;select.append(o);}
  const agreeLabel=el('label',null,'confirm-line'),agree=el('input');agree.type='checkbox';agree.id='replaceDeviceConsent';agreeLabel.append(agree,el('span','أوافق على إيقاف اعتماد الجهاز الذي اخترته ونقله إلى هذا الهاتف.'));
  const b=el('button','نقل الاعتماد إلى هذا الهاتف','btn p wide');b.type='button';b.id='replaceDeviceSubmit';b.disabled=true;
  const valid=()=>{b.disabled=!select.value||!agree.checked;};select.onchange=valid;agree.onchange=valid;
  b.onclick=()=>handle(async()=>{
    if(!select.value||!agree.checked)throw Error('اختر الجهاز القديم وأكّد موافقتك أولًا');
    const old=select.value;b.disabled=true;
    try{
      const id=await state.api.rpc('rfq_pilot_replace_own_device',{p_store:store,p_old:old,p_new:current});
      if(id!==current)throw Error('لم يصل إقرار مطابق لنقل الاعتماد؛ حدّث الأجهزة ولا تكرر النقل إلى جهاز آخر');
      state.approved=true;state.deviceLimit=false;renderDevice('approved');await safeRefresh();
      showMessage('تم نقل الاعتماد بتوثيق كامل. هذا الهاتف معتمد؛ لا بيانات حُذفت ولا زيادة في عدد الأجهزة.','ok');
    }finally{if(b.isConnected)valid();}
  });
  transfer.append(label,select,agreeLabel,b);host.append(transfer);
}
function organizeWorkspace(){
  function collapse(formId){
    const form=$(formId),card=form?.closest('.card');if(!card||card.dataset.organized)return;
    const heading=card.querySelector('h2');if(!heading)return;
    card.dataset.organized='1';card.classList.add('fold-card');
    const details=el('details'),summary=el('summary',heading.textContent);heading.remove();details.append(summary);
    while(card.firstChild)details.append(card.firstChild);card.append(details);
  }
  function toolbar(view,actions){
    const section=$(view+'View');if(!section)return;
    const bar=el('div',null,'view-toolbar');bar.setAttribute('aria-label','اختصارات '+view);
    for(const [label,field,owner] of actions){const b=el('button',label,'btn sm'+(owner?' owner-only':''));b.type='button';b.onclick=()=>goTo(view,field);bar.append(b);}
    const intro=section.querySelector('.section-intro');if(intro)intro.after(bar);else section.prepend(bar);
  }
  const catalog=$('catalogList')?.closest('.card'),products=$('productsView');if(catalog&&products)products.querySelector('.section-intro').after(catalog);
  const clients=$('customerList')?.closest('.card'),customers=$('customersView');if(clients&&customers)customers.querySelector('.section-intro').after(clients);
  const suppliers=$('supplierList')?.closest('.card'),suppliersView=$('suppliersView');if(suppliers&&suppliersView)suppliersView.querySelector('.section-intro').after(suppliers);
  for(const f of ['productForm','stockAdjustmentForm','customerForm','ownerDebtForm','supplierForm','purchaseForm','supplierPayForm','supplierReturnForm','ownerCashForm'])collapse(f);
  {const sv=$('settingsView');if(sv)for(const f of sv.querySelectorAll('form[id]'))collapse(f.id);}
  toolbar('products',[['＋ صنف جديد','productName',true],['الاحتياجات','demandName',false],['الجرد','stocktakeBody',true],['حركة مخزون','adjustProduct',true]]);
  toolbar('customers',[['＋ زبون جديد','customerName',false],['إضافة دين','debtCustomer',true]]);
  toolbar('suppliers',[['＋ مورّد','supName',true],['فاتورة شراء','purSupplier',false],['دفعة لمورّد','paySupplier',false],['مرتجع','retSupplier',false]]);
}

let ownerResumeFlight=null;
function resumeOwnerSeller(){
  if(document.visibilityState==='hidden'||!navigator.onLine||!state.api?.signedIn||state.role!=='owner'||!state.sellerMode||state.readOnly)return;
  if(ownerResumeFlight)return ownerResumeFlight;
  ownerResumeFlight=handle(async()=>{await ensureOwnerSellerSession();await syncAll();}).finally(()=>{ownerResumeFlight=null;});
  return ownerResumeFlight;
}
document.addEventListener('visibilitychange',resumeOwnerSeller);
window.addEventListener('pageshow',resumeOwnerSeller);
window.addEventListener('focus',resumeOwnerSeller);

window.addEventListener('online',()=>{$('networkBadge').classList.remove('offline');state.offlineNow=false;handle(async()=>{await syncAll();await safeRefresh();});});
window.addEventListener('offline',()=>{$('networkBadge').classList.add('offline');state.offlineNow=true;showMessage('انقطع الاتصال: كل عملية جديدة تُحفظ محليًا «بانتظار المزامنة» — مستنداتها مؤقتة حتى إقرار الخادم.');renderFromMirror();renderOfflineCenter();updateSaleButtons();});
$('networkBadge').classList.toggle('offline',!navigator.onLine);
setInterval(()=>{if(state.api?.signedIn&&document.visibilityState==='visible'&&navigator.onLine)handle(refresh);},25000);
organizeWorkspace();
// ===== واجهة النموذج: فلاتر + مداخل الدرج + تحميل الأرصدة عند الطلب =====
async function loadCustomerDebts(){
  if(state.__debtsLoaded)return;
  showMessage('نقرأ أرصدة الزبائن من الخادم…','ok');
  const list=state.customers.filter(x=>x.active).slice(0,80);
  await Promise.all(list.map(c=>state.api.rpc('rfq_pilot_customer_balance',{p_store:state.store,p_device:state.device,p_customer:c.id})
    .then(v=>{state.customerDebt=state.customerDebt||{};state.customerDebt[c.id]=Number(v)||0;}).catch(()=>{})));
  state.__debtsLoaded=true;
}
{const cChips=$('customerFilterChips');
  if(cChips)for(const b of cChips.querySelectorAll('button'))b.onclick=async()=>{
    state.debtFilter=b.dataset.cfilter;
    for(const x of cChips.querySelectorAll('button'))x.classList.toggle('on',x===b);
    if(state.debtFilter!=='all')await loadCustomerDebts();
    renderCustomers();};
  const iChips=$('catalogFilterChips');
  if(iChips)for(const b of iChips.querySelectorAll('button'))b.onclick=()=>{
    state.catalogFilter=b.dataset.ifilter;
    for(const x of iChips.querySelectorAll('button'))x.classList.toggle('on',x===b);
    renderCatalog();};
  const reportChips=$('reportFilterChips');
  if(reportChips)for(const b of reportChips.querySelectorAll('button'))b.onclick=()=>{
    const filter=b.dataset.rfilter;
    for(const x of reportChips.querySelectorAll('button'))x.classList.toggle('on',x===b);
    for(const card of document.querySelectorAll('#reportsView [data-report-group]'))
      card.classList.toggle('hide',filter!=='all'&&card.dataset.reportGroup!==filter);
  };
  const dn=$('demandNav');if(dn)dn.onclick=()=>{closeDrawer();goTo('products','demandName');};
  const on=$('ocrNav');if(on)on.onclick=()=>{closeDrawer();goTo('suppliers');
    setTimeout(()=>{const b=$('ocrRunBtn')||$('ocrCaptureBtn');if(b)b.scrollIntoView({block:'center'});},140);};
  // شاشة البيع — النموذج
  {const ss=$('saleSearch');if(ss)ss.addEventListener('input',()=>{renderSaleGrid();});
   const sc=$('saleScanBtn');if(sc)sc.onclick=()=>{const s2=$('saleSearch');if(s2){s2.focus();s2.select();}showMessage('اكتب الباركود أو اسم الصنف','ok');};
   const rc=$('saleReviewClose');if(rc)rc.onclick=closeSaleReview;
   const mc=$('modeCash');if(mc)mc.onclick=()=>setSaleMode('cash');
   const md=$('modeCredit');if(md)md.onclick=()=>setSaleMode('credit');
   const sh=$('saleReview');if(sh)sh.onclick=(e)=>{if(e.target===sh)closeSaleReview();};
   const cp=$('cashPaid');if(cp)cp.addEventListener('input',()=>{if(!modeIsCredit())renderCart();});
  }
}
// (الإقلاع الآن عبر bootLaunch أدناه — بوابة التفعيل + وضع الدخول)
function deviceCodePretty(){return (deviceCodeFrom(launchDeviceId()).match(/.{4}/g)||['————']).join('-');}
function showActivationScreen(){
  $('launchDeviceCode').textContent=deviceCodePretty();
  const a=launchActivation();
  $('activationStatus').textContent=launchExpired(a)?'انتهت مدة التفعيل — أدخل كود تجديد من الموزّع.':'';
  screen('activation');
}
function showModeScreen(){
  const a=launchActivation()||{};
  $('modeOnline').disabled=a.mode==='offline';
  $('modeOffline').disabled=a.mode==='online';
  screen('mode');
}
function showPinScreen(){
  const acc=localAccount();
  $('pinStoreName').textContent=(acc?.name||'متجري')+' • وضع محلي — بدون إنترنت';
  const f=$('pinInput');if(f)f.value='';
  screen('pin');
}
function enterLocalSession(){
  const acc=localAccount();
  if(!acc){screen('localSetup');return;}
  state.mode='offline';
  state.api=makeLocalApi();
  // اسم المحل في اللوحة الجانبية يأتي من الحساب المحلي حتى بلا خادم
  { const dsnL=document.getElementById('drawerStoreName'); if(dsnL) dsnL.textContent=acc.name||'متجر رفيق'; }
  enterSession({id:'local-owner',email:(acc.name||'متجري')+' — وضع محلي'},{store_id:'local-store',role:'owner'})
    .then(()=>{showMessage('دخلت الوضع المحلي — كل شيء محفوظ على هذا الجهاز.','ok');
    setTimeout(applyFolds,200);})
    .catch(e=>showMessage(e.message||'تعذر فتح المتجر المحلي'));
}
function bootLaunch(){
  if(!launchActivated()){showActivationScreen();return;}
  const mode=kvGet('rafiq-test-device:v2:android:launch-mode');
  if(mode!=='online'&&mode!=='offline'){state.mode=null;showModeScreen();return;}
  if(mode==='offline'){
    state.mode='offline';
    if(!localAccount()){screen('localSetup');return;}
    showPinScreen();return;
  }
  state.mode='online';
  if(embedded){screen('setup');}
  else try{
    const raw=JSON.parse(localStorage.getItem('rafiq-test-web-config')||'null');
    if(raw){state.api=new PilotApi(raw.url,raw.key);$('projectUrl').value=state.api.url;screen('login');tryRestoreSession();}
    else screen('setup');
  }catch{screen('setup');}
}
$('activationForm').addEventListener('submit',e=>{e.preventDefault();handle(async()=>{
  const code=$('activationCode').value.trim();
  const r=verifyActivationCode(deviceCodeFrom(launchDeviceId()),code);
  if(!r.ok)throw Error(r.reason==='code'?'كود التفعيل غير صحيح لهذا الجهاز':
    r.reason==='format'?'اكتب الكود بالصيغة الصحيحة: RFQ-XXXX-XXXX':'كود التفعيل غير صالح');
  const prev=launchActivation();
  const from=(prev&&prev.until&&new Date(prev.until)>new Date())?prev.until:new Date().toISOString();
  saveActivation({code:code.toUpperCase(),type:r.type,mode:r.mode,months:r.months,
    until:activationUntil(r.months,from),at:new Date().toISOString()});
  $('activationCode').value='';
  showMessage('تم التفعيل بنجاح.','ok');
  const mode=kvGet('rafiq-test-device:v2:android:launch-mode');
  if(mode==='offline'&&localAccount())enterLocalSession();
  else if(mode==='online'){bootLaunch();bootCloudConfig();}
  else showModeScreen();
});});
$('modeOnline').onclick=()=>{kvSet('rafiq-test-device:v2:android:launch-mode','online');state.mode='online';bootLaunch();bootCloudConfig();};
$('modeOffline').onclick=()=>{kvSet('rafiq-test-device:v2:android:launch-mode','offline');state.mode='offline';
  if(!localAccount())screen('localSetup');else showPinScreen();};
$('localSetupForm').addEventListener('submit',e=>{e.preventDefault();handle(async()=>{
  const name=$('localStoreName').value.trim();
  const pin=$('localPin').value.trim(),pin2=$('localPin2').value.trim();
  if(!name)throw Error('اكتب اسم المحل');
  if(!/^[0-9]{4,6}$/.test(pin))throw Error('الرقم السري من 4 إلى 6 أرقام');
  if(pin!==pin2)throw Error('الرقمان السريان غير متطابقين');
  const salt=bytesHex(sha256Bytes('rafiq-salt|'+launchDeviceId()+'|'+name)).slice(0,16);
  kvSet('rafiq-test-device:v2:android:local-account',JSON.stringify({name,pinHash:pinHash(pin,salt),salt,at:new Date().toISOString()}));
  $('localPin').value='';$('localPin2').value='';
  enterLocalSession();
});});
$('pinForm').addEventListener('submit',e=>{e.preventDefault();handle(async()=>{
  const acc=localAccount();
  if(!acc){screen('localSetup');return;}
  const pin=$('pinInput').value.trim();
  if(pinHash(pin,acc.salt)!==acc.pinHash)throw Error('الرقم السري غير صحيح');
  $('pinInput').value='';
  enterLocalSession();
});});
$('pinChangeMode').onclick=()=>{kvSet('rafiq-test-device:v2:android:launch-mode','');state.mode=null;showModeScreen();};
$('launchRenewBtn').addEventListener('click',()=>{showActivationScreen();});
$('launchModeBtn').addEventListener('click',()=>{
  kvSet('rafiq-test-device:v2:android:launch-mode','');state.mode=null;
  ownerSessionEpoch++;state.sellerMode=false;state.ownerSessionState=null;
  state.api=null;state.user=null;state.store=null;state.role=null;state.lease=false;state.shift=null;state.cart=[];
  $('who').hidden=true;$('logout').hidden=true;$('menuToggle').hidden=true;closeDrawer();
  showModeScreen();
});
bootLaunch();

/* ================= بناء 146 — طبقة النموذج التفاعلي (فوق كل شيء — لا تُغيّر المحرّك) ================= */
(function modelLayer(){
  try{
    const $m=(id)=>document.getElementById(id);
    const mEl=(tag,text,cls)=>{const e=document.createElement(tag);if(text!=null)e.textContent=text;if(cls)e.className=cls;return e;};
    const nav=(view)=>{const b=document.querySelector('#tabs [data-view="'+view+'"]');if(b)b.click();else if(typeof goTo==='function')goTo(view);};

    /* ---- الدرج: أصناف النموذج ---- */
    document.querySelectorAll('#tabs > button').forEach(b=>b.classList.add('d-item'));
    document.querySelectorAll('#tabs .drawer-group').forEach(g=>g.classList.add('d-group'));
    const dh=document.querySelector('#tabs .drawer-head');if(dh)dh.classList.add('d-head');

    /* ---- شريط علوي: العنوان + الحرف ---- */
    const pt=$m('pageTitle'),vt=$m('viewTitle');
    if(pt&&vt){try{new MutationObserver(()=>{vt.textContent=pt.textContent;}).observe(pt,{childList:true,characterData:true,subtree:true});vt.textContent=pt.textContent;}catch{}}
    const ta=$m('topAvatar'),un=$m('drawerUserName');
    if(ta&&un){try{new MutationObserver(()=>{const n=(un.textContent||'ر').trim();ta.textContent=n?n[0]:'ر';}).observe(un,{childList:true,characterData:true,subtree:true});}catch{}}

    /* ---- الدخول: حسب النموذج ---- */
    const seg=$m('loginModeSeg');
    if(seg)seg.querySelectorAll('button').forEach(b=>b.onclick=()=>{
      seg.querySelectorAll('button').forEach(x=>x.classList.remove('on'));
      b.classList.add('on');
      const sw=$m('modeSwitchLogin');if(sw)sw.click();
    });
    const pe=$m('passEye');
    if(pe)pe.onclick=()=>{const inp=$m('password');if(inp)inp.type=inp.type==='password'?'text':'password';};
    const fl=$m('forgotLink');
    if(fl)fl.onclick=()=>showMessage('استعادة كلمة المرور — تتم عبر إعدادات المتجر','ok');
    const nab=$m('newAccountBtn');
    if(nab)nab.onclick=()=>showMessage('إنشاء حساب جديد — يفعّله مالك المتجر من الإعدادات','ok');
    const bb=$m('bioBtn');
    if(bb)bb.onclick=()=>{const q=$m('quickUnlockBtn');if(q&&!q.classList.contains('hide'))q.click();else showMessage('الدخول السريع يتفعّل بعد أول دخول على هذا الجهاز','ok');};
    document.querySelectorAll('#setupFold .fold > button, #setupFold > button').forEach(b=>b.onclick=()=>{
      const f=b.closest('.fold');if(f)f.classList.toggle('open');
    });

    /* ---- الرئيسية = النموذج ---- */
    const buildModelHome=()=>{
      const home=$m('homeView');if(!home)return;
      if($m('modelHome'))return;
      const wrap=mEl('div','','');wrap.id='modelHome';
      // بطاقة الإحصاء
      const stat=mEl('div','','stat-card');
      stat.append(mEl('div','مبيعات اليوم','s-label'));
      const sv=mEl('div','','s-value');sv.append(mEl('span','—','') ,document.createTextNode(' '));
      const unit=mEl('span','ريال','');unit.style.cssText='font-size:.95rem;font-weight:700';sv.append(unit);
      stat.append(sv);
      const row1=mEl('div','','s-row');
      const pInv=mEl('span','','pill');pInv.append(mEl('span','🧾 ',''),mEl('span','—','modelInvCount'),document.createTextNode(' فاتورة'));
      const pCash=mEl('span','','pill');pCash.append(document.createTextNode('💰 الدرج: '),mEl('span','—','modelCashNow'));
      const ref=mEl('button','','refresh-btn');ref.type='button';
      ref.append(mEl('span','↻',''),document.createTextNode(' تحديث'));
      ref.onclick=()=>{ref.classList.add('spin');
        try{
          if(state.api&&state.api.rpc)state.api.rpc('rfq_pilot_owner_summary',{}).then((sum)=>{
            try{
              const s1=document.querySelector('#modelHome .s-value span');
              const c=document.querySelector('#modelHome .modelCashNow');
              if(s1&&sum)s1.textContent=Math.round(Number(sum.sales_cents||0)/100).toLocaleString('en-US');
              if(c&&sum)c.textContent=Math.round(Number(sum.cash_received_on_sales_cents||0)/100).toLocaleString('en-US');
            }catch{}
          }).catch(()=>{});
        }catch{}
        setTimeout(()=>{ref.classList.remove('spin');fillNumbers();showMessage('حالة المتجر محدثة','ok');},600);};
      row1.append(pInv,pCash,ref);stat.append(row1);
      wrap.append(stat);
      // أزرار سريعة
      const qr=mEl('div','','quick-row');
      [['🛒','بيع جديد','var(--green-bg)','pos'],['🤝','تسديد دين','var(--red-bg)','customers'],['📤','مصروف','var(--amber-bg)','shifts'],['📦','أصناف','#e8eef6','products']].forEach(([ic,tx,bg,v])=>{
        const q=mEl('button','','quick');q.type='button';
        const qi=mEl('span',ic,'q-ico');qi.style.background=bg;
        q.append(qi,document.createTextNode(tx));
        q.onclick=()=>nav(v);
        qr.append(q);
      });
      wrap.append(qr);
      // يحتاج انتباهك
      wrap.append(mEl('div','⚡ يحتاج انتباهك','section-title'));
      const att=mEl('div','','att-item-wrap');att.id='modelAttention';
      wrap.append(att);
      // نوافذ العمل
      wrap.append(mEl('div','🗂 نوافذ العمل','section-title'));
      [['🛒','البيع','بحث، باركود، سلة عائمة، مراجعة ودفع','var(--green-bg)','pos'],
       ['🤝','الديون والزبائن','الأرصدة، المتابعة، التسديد','var(--red-bg)','customers'],
       ['💰','الصندوق والورديات','فتح الوردية، المصروفات، السحوبات','var(--amber-bg)','shifts'],
       ['📦','الأصناف والمخزون','البحث، قارب النفاد، صلاحية قريبة','#e8eef6','products']].forEach(([ic,t,s,bg,v])=>{
        const w=mEl('button','','world');w.type='button';
        const head=mEl('div','','w-head');
        const ico=mEl('div',ic,'w-ico');ico.style.background=bg;
        const mid=mEl('div','','');mid.style.flex='1';
        mid.append(mEl('h2',t,''),mEl('div',s,'w-sub'));
        head.append(ico,mid,mEl('div','›','chev'));
        w.append(head);w.onclick=()=>nav(v);
        wrap.append(w);
      });
      home.prepend(wrap);
      fillNumbers();fillAttention();
    };
    const fillNumbers=()=>{ // قراءة من الحالة فقط — بلا طلبات شبكة (عقود الاختبارات)
      try{
        const s1=document.querySelector('#modelHome .s-value span');
        const c=document.querySelector('#modelHome .modelCashNow');
        const inv=document.querySelector('#modelHome .modelInvCount');
        const sum=state.ownerSummary||state.summary||null;
        if(s1)sum?s1.textContent=Math.round(Number(sum.sales_cents||sum.sales||0)/100).toLocaleString('en-US'):(s1.textContent='0');
        if(c)sum?c.textContent=Math.round(Number(sum.cash_received_on_sales_cents||sum.cash||0)/100).toLocaleString('en-US'):(c.textContent='0');
        if(inv)inv.textContent=String(Number(state.todayCount||0));
      }catch{}
    };
    window.__modelFillNumbers=fillNumbers;
    const fillAttention=()=>{
      try{
        const att=$m('modelAttention');if(!att)return;
        att.replaceChildren();
        const lowL=Number((state.msgSettings&&state.msgSettings.low_stock_milli)||1000);
        const low=(state.products||[]).filter(p=>p&&p.active!==false&&Number(p.stock_milli||0)<=lowL);
        const items=[];
        if(low.length)items.push(['var(--amber)','أصناف قاربت النفاد',low.length+' أصناف تحت الحد الأدنى','products']);
        if(state.shift)items.push(['var(--green)','وردية مفتوحة','يمكنك البيع وتسجيل الحركات الآن','shifts']);
        if((state.pending))items.push(['var(--red)','عمليات بانتظار المزامنة','راجعها قبل بيع جديد','home']);
        if(!items.length)items.push(['var(--green)','كل شيء تحت السيطرة ✅','لا تنبيهات الآن','']);
        for(const [dot,t,s,v] of items){
          const b=mEl('button','','att-item');b.type='button';
          b.append(mEl('span','','att-dot'));
          b.children[0].style.background=dot;
          const mid=mEl('div','','a-t');mid.append(document.createTextNode(t),mEl('div',s,'a-s'));
          b.append(mid,mEl('span','‹','chev'));
          if(v)b.onclick=()=>nav(v);
          att.append(b);
        }
      }catch{}
    };
    // حقن تلقائي مهما كتب المحرّك
    try{
      const home=$m('homeView');
      if(home){
        new MutationObserver(()=>{try{buildModelHome();}catch{}}).observe(home,{childList:true,subtree:true});
        buildModelHome();
      }
    }catch{}
    // تحديث الإحصاء عند تغيّر الجلسة/المنتجات
    try{new MutationObserver(()=>{try{fillAttention();}catch{}}).observe(document.body,{childList:false,subtree:false,attributes:true,attributeFilter:['class']});}catch{}
  }catch(e){try{console.warn('model layer',e);}catch{}}
})();

// ===== بناء 148: صوت خفيف + اهتزاز لكل نقرة (فوق الموجود، بدون تعديل أي دالة موجودة) =====
(function addGlobalTapFeedback(){
  let _tapCtx=null;
  function tapBeep(){
    try{
      if(!_tapCtx)_tapCtx=new (window.AudioContext||window.webkitAudioContext)();
      const osc=_tapCtx.createOscillator();const g=_tapCtx.createGain();
      osc.type='sine';osc.frequency.setValueAtTime(880,_tapCtx.currentTime);osc.frequency.exponentialRampToValueAtTime(1760,_tapCtx.currentTime+0.06);
      g.gain.setValueAtTime(0.12,_tapCtx.currentTime);g.gain.exponentialRampToValueAtTime(0.001,_tapCtx.currentTime+0.12);
      osc.connect(g);g.connect(_tapCtx.destination);osc.start();osc.stop(_tapCtx.currentTime+0.12);
    }catch{}
  }
  document.addEventListener('click',(e)=>{
    const btn=e.target.closest('button');
    if(!btn||btn.matches('[data-no-tap]'))return;
    try{haptic();tapBeep();}catch{}
  },{passive:true});
})();

/* واجهة قراءة وتحديث محدودة لوحدات الإضافات (تعديل الأسعار والكميات والتواريخ) — لا تكشف الجلسة ولا المفاتيح */
window.RafiqApp={
  get products(){return state.products;},
  get customers(){return state.customers;},
  get storeName(){return state.storeName;},
  shiftOpen(){return !!(state.shift||(state.localShift&&!state.localShift.closing));},
  get store(){return state.store;},
  get role(){return state.role;},
  get api(){return state.api;},
  get mode(){return state.mode;},
  get cart(){return state.cart;},
  openReview(){if(typeof openSaleReview==='function')openSaleReview();},
  isOwner(){return state.role==='owner';},
  rerenderProducts(){const b=document.querySelector('[data-view="products"]');if(b)b.click();}
};
