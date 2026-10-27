/* صندوق صادر محلي للرسائل النصية: يُرسل عبر شريحة الهاتف مباشرة (SmsManager)، ولا يحتاج إنترناً.
   - الرسائل تُحفظ على الجهاز أولاً، ثم تُرسل تلقائياً، وتُعاد المحاولة عند الفشل.
   - لا يُرسل شيء إلا بإذن إرسال الرسائل في أندرويد.
   - لا تُكرَّر الرسالة: لكل رسالة مفتاح (key) يمنع الإرسال مرتين لنفس الحدث. */
(function(){
  var KEY='rafiq-sms-outbox-v1', SET='rafiq-sms-settings-v1', MAX_TRY=5, MAX_LEN=480;

  function load(){try{return JSON.parse(localStorage.getItem(KEY)||'[]');}catch(e){return [];}}
  function save(list){try{localStorage.setItem(KEY,JSON.stringify(list.slice(-500)));}catch(e){}}
  function settings(){try{return Object.assign({auto:true,slot:1},JSON.parse(localStorage.getItem(SET)||'{}'));}catch(e){return {auto:true,slot:1};}}
  function setSettings(s){try{localStorage.setItem(SET,JSON.stringify(Object.assign(settings(),s)));}catch(e){}}
  function bridge(){return window.NativeApi&&typeof window.NativeApi.smsSend==='function'?window.NativeApi:null;}
  // الأرقام اليمنية المحلية (9 أرقام تبدأ بـ7) تُضاف لها مفتاح الدولة 967 تلقائياً
  function normPhone(p){var s=String(p||'').replace(/[\s\-()]/g,'');s=s.replace(/^\+/,'');s=s.replace(/^00/,'');if(/^7\d{8}$/.test(s))s='967'+s;return /^\d{7,15}$/.test(s)?s:null;}
  function rid(){return 'sms-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,8);}

  // إضافة رسالة إلى الصندوق الصادر (مع منع التكرار بالمفتاح)
  function enqueue(phone,body,key){
    var p=normPhone(phone);
    if(!p)return {ok:false,reason:'رقم الهاتف غير صحيح'};
    var text=String(body||'').trim();
    if(!text)return {ok:false,reason:'نص الرسالة فارغ'};
    if(text.length>MAX_LEN)text=text.slice(0,MAX_LEN);
    var list=load();
    if(key&&list.some(function(m){return m.key===key;}))return {ok:true,dup:true};
    list.push({id:rid(),key:key||null,phone:p,body:text,status:'queued',tries:0,err:'',created:new Date().toISOString(),sent:null});
    save(list);
    schedule(0);
    return {ok:true};
  }

  // إرسال واحدة عبر الشريحة
  function sendOne(b,m){
    var r;
    try{r=JSON.parse(b.smsSend(JSON.stringify({slot:settings().slot||1,dest:m.phone,body:m.body,task:m.id}))||'{}');}
    catch(e){return {ok:false,err:String(e&&e.message||e)};}
    var ok=['sent','submitted','delivered'].indexOf(r.status)>=0;
    return {ok:ok,err:ok?'':(r.error||r.status||'فشل الإرسال')};
  }

  var pumping=false,timer=null;
  function pump(){
    if(pumping||!settings().auto)return;
    var b=bridge();if(!b)return;
    var list=load();
    var pend=list.filter(function(m){return m.status==='queued'&&m.tries<MAX_TRY;});
    if(!pend.length)return;
    pumping=true;
    try{
      for(var i=0;i<pend.length;i++){
        var m=pend[i];
        var res=sendOne(b,m);
        m.tries++;
        if(res.ok){m.status='sent';m.sent=new Date().toISOString();m.err='';}
        else{m.err=res.err;if(m.tries>=MAX_TRY)m.status='failed';}
        save(list);
      }
    }finally{pumping=false;}
  }
  function schedule(ms){if(timer)clearTimeout(timer);timer=setTimeout(function(){pump();schedule(20000);},ms);}

  // حالة للعرض: عدد المعلّقة والمرسلة والفاشلة وآخر خطأ
  function stats(){
    var l=load();
    return {queued:l.filter(function(m){return m.status==='queued';}).length,
      sent:l.filter(function(m){return m.status==='sent';}).length,
      failed:l.filter(function(m){return m.status==='failed';}).length,
      lastErr:(l.slice().reverse().find(function(m){return m.err;})||{}).err||'',
      hasBridge:!!bridge()};
  }

  window.RafiqSmsOutbox={enqueue:enqueue,pump:pump,stats:stats,list:load,settings:settings,setSettings:setSettings,normPhone:normPhone};
  schedule(3000);
  // حلقة احتياطية: إن تعذّر أي إرسال تُعاد المحاولة تلقائياً
  setInterval(function(){pump();},60000);
})();

/* لوحة «الرسائل النصية» داخل شاشة الإعدادات: الحالة، والتشغيل/الإيقاف، وإذن الإرسال، وإرسال يدوي، وإعادة محاولة الفاشلة */
(function(){
  function el(tag,cls,txt){var e=document.createElement(tag);if(cls)e.className=cls;if(txt!=null)e.textContent=txt;return e;}
  function native(){return window.NativeApi||null;}
  function permText(){
    var n=native();if(!n||typeof n.smsPermissionState!=='function')return 'غير متاح خارج تطبيق الهاتف';
    try{var s=JSON.parse(n.smsPermissionState()||'{}');return s.granted?'الإذن ممنوح ✓':'الإذن غير ممنوح — اضغط «منح إذن الإرسال»';}catch(e){return 'تعذّر قراءة حالة الإذن';}
  }
  function build(){
    var card=el('div','sms-card');card.id='smsCard';
    card.appendChild(el('h3',null,'الرسائل النصية عبر شريحة الهاتف'));
    var stat=el('div','muted');stat.id='smsStat';card.appendChild(stat);
    var perm=el('div','muted');perm.id='smsPerm';card.appendChild(perm);
    var row=el('label','check');var cb=el('input');cb.type='checkbox';cb.id='smsAuto';
    row.appendChild(cb);row.appendChild(el('span',null,'إرسال تلقائي عبر الشريحة (يعمل دون إنترنت)'));card.appendChild(row);
    var btns=el('div','row wrap');btns.style.marginTop='8px';
    var bPerm=el('button','btn ghost sm','منح إذن الإرسال');bPerm.type='button';
    var bRetry=el('button','btn ghost sm','إعادة محاولة الفاشلة');bRetry.type='button';
    btns.appendChild(bPerm);btns.appendChild(bRetry);card.appendChild(btns);
    var f=el('div');f.style.marginTop='12px';
    f.appendChild(el('div','muted','إرسال رسالة يدوية'));
    var ph=el('input');ph.placeholder='رقم الهاتف (مثال 772092700)';ph.id='smsPhone';ph.style.cssText='width:100%;margin:6px 0;min-height:44px';
    var tx=el('textarea');tx.placeholder='نص الرسالة';tx.id='smsText';tx.rows=3;tx.style.cssText='width:100%;min-height:72px';
    var bSend=el('button','btn p sm','أرسل الآن');bSend.type='button';bSend.style.marginTop='6px';
    var msg=el('div','muted');msg.id='smsMsg';
    f.appendChild(ph);f.appendChild(tx);f.appendChild(bSend);f.appendChild(msg);card.appendChild(f);

    function refresh(){
      var X=window.RafiqSmsOutbox,s=X.stats();
      stat.textContent='بانتظار الإرسال: '+s.queued+' • أُرسلت: '+s.sent+' • فشلت: '+s.failed+(s.lastErr?' • آخر خطأ: '+s.lastErr:'');
      perm.textContent=permText()+(s.hasBridge?'':' — الإرسال بالشريحة يعمل داخل تطبيق الهاتف فقط');
      cb.checked=!!X.settings().auto;
    }
    cb.addEventListener('change',function(){window.RafiqSmsOutbox.setSettings({auto:cb.checked});refresh();});
    bPerm.addEventListener('click',function(){var n=native();if(n&&typeof n.smsRequestPermission==='function'){try{n.smsRequestPermission();}catch(e){}}setTimeout(refresh,800);});
    bRetry.addEventListener('click',function(){var k='rafiq-sms-outbox-v1';var l;try{l=JSON.parse(localStorage.getItem(k)||'[]');}catch(e){l=[];}l.forEach(function(m){if(m.status==='failed'){m.status='queued';m.tries=0;m.err='';}});try{localStorage.setItem(k,JSON.stringify(l));}catch(e){}window.RafiqSmsOutbox.pump();setTimeout(refresh,600);});
    bSend.addEventListener('click',function(){
      var r=window.RafiqSmsOutbox.enqueue(ph.value,tx.value,null);
      msg.textContent=r.ok?'أُضيفت إلى الصندوق الصادر وجارٍ الإرسال…':r.reason;
      if(r.ok){tx.value='';window.RafiqSmsOutbox.pump();setTimeout(refresh,900);}
    });
    refresh();
    setInterval(refresh,4000);
    return card;
  }
  function place(){
    var v=document.getElementById('settingsView');
    if(!v||document.getElementById('smsCard'))return;
    v.appendChild(build());
  }
  setInterval(place,1500);
})();
