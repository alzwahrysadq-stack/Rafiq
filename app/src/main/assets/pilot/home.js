/* الشاشة الرئيسية المختصرة: ثلاث بطاقات متحركة في الأعلى (البيع، الديون، المخزون)
   وشبكة مربعات تفتح كل شاشة في نافذتها. الأقسام الطويلة تُخفى من الرئيسية فقط، ولا تُحذف.
   تُعاد إضافة اللوحة تلقائياً كلما أعاد التطبيق رسم الشاشة الرئيسية. */
(function(){
  var TILES=[
    {v:'pos',t:'البيع',i:'🛒',c:'#e7f6ee'},
    {v:'customers',t:'الزبائن والديون',i:'🤝',c:'#fdeeea'},
    {v:'shifts',t:'الصندوق',i:'💰',c:'#fff6e0'},
    {v:'products',t:'الأصناف',i:'📦',c:'#e8eef6'},
    {v:'monitor',t:'المتابعة',i:'📊',c:'#eef0fb'},
    {v:'suppliers',t:'الموردون',i:'🚚',c:'#eaf5f8'},
    {v:'reports',t:'التقارير',i:'🧾',c:'#f3edf8'},
    {v:'settings',t:'الإعدادات',i:'⚙️',c:'#eef2f5'}
  ];
  // المالك يبيع عبر «بيع المالك» (زر ownerSellerNav)، والعامل عبر شاشة البيع نفسها
  function go(v){
    var b=[...document.querySelectorAll('[data-view]')].find(function(e){return e.getAttribute('data-view')===v&&e.offsetParent;});
    if(b){b.click();return;}
    if(v==='pos'){var s=document.getElementById('ownerSellerNav')||document.querySelector('[data-nav-action="owner-sale"]');if(s){s.click();return;}}
  }
  function stockStats(){
    var A=window.RafiqApp,list=(A&&A.products)||[];
    var low=list.filter(function(p){return Number(p.stock_milli||0)<=10000;}).length;
    return {total:list.length,low:low};
  }
  function el(tag,cls,txt){var e=document.createElement(tag);if(cls)e.className=cls;if(txt!=null)e.textContent=txt;return e;}
  function build(){
    var s=stockStats();
    var wrap=el('div','hdash');wrap.id='homeDash';
    var stats=el('div','hdash-stats');
    var defs=[
      {t:'البيع',v:'pos',val:'افتح',cls:'s1'},
      {t:'الديون',v:'customers',val:'افتح',cls:'s2'},
      {t:'المخزون',v:'products',val:s.total+' صنف'+(s.low?' • '+s.low+' قارب النفاد':''),cls:'s3'}
    ];
    defs.forEach(function(d,k){
      var b=el('button','hdash-stat '+d.cls);b.type='button';b.style.animationDelay=(k*90)+'ms';
      b.appendChild(el('span','hs-t',d.t));b.appendChild(el('span','hs-v',d.val));
      b.addEventListener('click',function(){go(d.v);});stats.appendChild(b);
    });
    var grid=el('div','hdash-grid');
    TILES.forEach(function(t,k){
      var b=el('button','hdash-tile');b.type='button';b.style.animationDelay=(180+k*60)+'ms';
      var ic=el('span','ht-ic',t.i);ic.style.background=t.c;
      b.appendChild(ic);b.appendChild(el('span','ht-t',t.t));
      b.addEventListener('click',function(){go(t.v);});grid.appendChild(b);
    });
    wrap.appendChild(stats);wrap.appendChild(grid);
    return wrap;
  }
  // ===== أعلى وأسفل الشاشة قابلان للتخصيص؛ الوسط ثابت (البطاقات والمربعات) =====
  var LKEY='rafiq-home-slots-v1';
  var DEFAULT={top:['pos','shifts','customers','products'],bottom:['reports','monitor','suppliers','settings']};
  function slotsLoad(){try{var s=JSON.parse(localStorage.getItem(LKEY)||'null');if(s&&Array.isArray(s.top)&&Array.isArray(s.bottom))return s;}catch(e){}return JSON.parse(JSON.stringify(DEFAULT));}
  function slotsSave(s){try{localStorage.setItem(LKEY,JSON.stringify(s));}catch(e){}}
  function tileOf(v){return TILES.find(function(t){return t.v===v;});}
  function renderSlot(kind){
    var box=document.getElementById(kind==='top'?'homeSlotTop':'homeSlotBottom');
    if(!box)return;
    var s=slotsLoad();
    box.replaceChildren();
    s[kind].forEach(function(v,k){
      var t=tileOf(v);if(!t)return;
      var b=el('button','slot-tile');b.type='button';b.style.animationDelay=(k*70)+'ms';
      var ic=el('span','ht-ic',t.i);ic.style.background=t.c;
      b.appendChild(ic);b.appendChild(el('span','ht-t',t.t));
      b.addEventListener('click',function(){go(t.v);});
      box.appendChild(b);
    });
    if(!s[kind].length)box.appendChild(el('div','muted','لا توجد اختصارات — اضغط «تخصيص» لإضافة شاشات'));
  }
  function openCustomize(){
    var old=document.getElementById('slotEditor');if(old){old.remove();return;}
    var ed=el('div','card');ed.id='slotEditor';ed.style.margin='8px 0';
    ed.appendChild(el('div','', 'اختر اختصارات أعلى الشاشة وأسفلها (حتى 4 لكل جهة). اضغط الشاشة لإضافتها أو إزالتها.'));
    var where=el('div','row');where.style.margin='8px 0';
    var rTop=el('button','btn sm p','أضف للأعلى');rTop.type='button';
    var rBot=el('button','btn sm ghost','أضف للأسفل');rBot.type='button';
    var target='top';
    rTop.onclick=function(){target='top';rTop.className='btn sm p';rBot.className='btn sm ghost';};
    rBot.onclick=function(){target='bottom';rBot.className='btn sm p';rTop.className='btn sm ghost';};
    where.appendChild(rTop);where.appendChild(rBot);ed.appendChild(where);
    var grid=el('div','hdash-grid');
    TILES.forEach(function(t){
      var b=el('button','hdash-tile');b.type='button';b.style.minHeight='84px';
      b.appendChild(el('span','ht-t',t.i+' '+t.t));
      b.addEventListener('click',function(){
        var s=slotsLoad();
        var inTop=s.top.indexOf(t.v),inBot=s.bottom.indexOf(t.v);
        if(inTop>=0)s.top.splice(inTop,1);
        else if(inBot>=0)s.bottom.splice(inBot,1);
        else{
          var arr=s[target];
          if(arr.length>=4){alert('الحد الأقصى 4 اختصارات لكل جهة. أزل واحداً أولاً.');return;}
          arr.push(t.v);
        }
        slotsSave(s);renderSlot('top');renderSlot('bottom');
      });
      grid.appendChild(b);
    });
    ed.appendChild(grid);
    var back=el('button','btn ghost sm','إغلاق');back.type='button';back.style.marginTop='8px';
    back.onclick=function(){ed.remove();};ed.appendChild(back);
    var home=document.getElementById('homeView');
    var dash=document.getElementById('homeDash');
    if(home&&dash)home.insertBefore(ed,dash.nextSibling);
  }
  function ensureSlots(){
    var home=document.getElementById('homeView');if(!home)return;
    var dash=document.getElementById('homeDash');if(!dash)return;
    if(!document.getElementById('homeSlotTop')){
      var top=el('div','slot-wrap');top.id='homeSlotTop';
      var head=el('div','slot-head');head.appendChild(el('span','slot-title','اختصاراتي'));
      var gear=el('button','btn ghost sm','⚙️ تخصيص');gear.type='button';gear.addEventListener('click',openCustomize);head.appendChild(gear);
      top.parentNode||null;
      home.insertBefore(top,dash);
      top.parentNode.insertBefore(head,top);
      renderSlot('top');
    }
    if(!document.getElementById('homeSlotBottom')){
      var bot=el('div','slot-wrap');bot.id='homeSlotBottom';
      dash.parentNode.insertBefore(bot,dash.nextSibling);
      renderSlot('bottom');
    }
  }

  function place(){
    var home=document.getElementById('homeView');
    if(!home)return;
    document.body.classList.add('home-dash-on');
    if(!document.getElementById('homeDash')){home.insertBefore(build(),home.firstChild);}
    ensureSlots();
    // تحديث أرقام المخزون عند تغيّر القائمة
    var st=stockStats(),v=document.querySelector('#homeDash .s3 .hs-v');
    if(v)v.textContent=st.total+' صنف'+(st.low?' • '+st.low+' قارب النفاد':'');
  }
  // أرقام المبيعات والديون من ملخص المالك نفسه (يعمل محلياً وعلى الخادم)
  function money(c){return (Number(c||0)/100).toLocaleString('en-US')+' ريال';}
  function setVal(cls,txt){var v=document.querySelector('#homeDash .'+cls+' .hs-v');if(v)v.textContent=txt;}
  var lastLoad=0,loading=false;
  async function loadSummary(){
    var A=window.RafiqApp;
    if(!A||!A.api||!A.store||!A.isOwner||!A.isOwner()||loading)return;
    if(Date.now()-lastLoad<15000)return;
    loading=true;
    try{
      var s=await A.api.rpc('rfq_pilot_owner_summary',{p_store:A.store});
      if(s){setVal('s1','المبيعات: '+money(s.sales_cents));setVal('s2','الديون: '+money(s.outstanding_debt_cents));}
      lastLoad=Date.now();
    }catch(e){setVal('s1','تعذّر تحميل المبيعات');}
    loading=false;
  }
  setInterval(loadSummary,3000);

  var obsTarget=null;
  function arm(){
    var home=document.getElementById('homeView');
    if(!home||obsTarget===home)return;
    obsTarget=home;
    new MutationObserver(function(){place();}).observe(home,{childList:true});
  }
  setInterval(function(){arm();place();},800);
})();
