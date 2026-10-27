/* فلاتر ترتيب أعلى قائمة الأصناف والديون.
   - الأصناف: الأكثر ربحاً، الأكثر مبيعاً، الأحدث، الأقدم، الأقل مخزوناً، الأعلى سعراً.
   - الديون: الأكثر ديناً، الأقل ديناً، الأحدث نشاطاً، الأقدم نشاطاً.
   الترتيب يُطبَّق على المصفوفة نفسها التي تبني منها الواجهة القائمة، فيبقى بعد كل إعادة رسم.
   الربح والمبيعات تُحسب من بنود الفواتير غير الملغاة فقط. */
(function(){
  var PRODUCT_SORTS=[
    ['profit','الأكثر ربحاً'],['sold','الأكثر مبيعاً'],['newest','الأحدث'],['oldest','الأقدم'],
    ['lowstock','الأقل مخزوناً'],['price','الأعلى سعراً']
  ];
  var DEBT_SORTS=[
    ['debt_high','الأكثر ديناً'],['debt_low','الأقل ديناً'],['newest','الأحدث نشاطاً'],['oldest','الأقدم نشاطاً']
  ];
  var state={products:null,debts:null};
  var metrics={},metricsAt=0,debtRows={},debtAt=0;

  function get(k,def){try{return localStorage.getItem('rafiq-sort-'+k)||def;}catch(e){return def;}}
  function set(k,v){try{localStorage.setItem('rafiq-sort-'+k,v);}catch(e){}}
  function num(x){var n=Number(x);return isFinite(n)?n:0;}
  function ts(x){var t=Date.parse(x||'');return isFinite(t)?t:0;}

  // حساب الربح والمبيعات لكل صنف من بنود الفواتير غير الملغاة
  async function loadMetrics(){
    if(Date.now()-metricsAt<60000&&Object.keys(metrics).length)return metrics;
    var A=window.RafiqApp;if(!A||!A.api)return metrics;
    try{
      var invs=await A.api.table('rfq_pilot_invoices',{store_id:'eq.'+A.store,select:'id,voided_at'});
      var voided={};(invs||[]).forEach(function(i){if(i.voided_at)voided[i.id]=true;});
      var lines=await A.api.table('rfq_pilot_invoice_lines',{store_id:'eq.'+A.store,select:'invoice_id,product_id,qty_milli,price_cents,cost_cents'});
      var m={};
      (lines||[]).forEach(function(l){
        if(voided[l.invoice_id])return;
        var q=num(l.qty_milli)/1000,rev=num(l.price_cents)*q,cost=num(l.cost_cents)*q;
        var x=m[l.product_id]||(m[l.product_id]={sold:0,profit:0});
        x.sold+=q;x.profit+=rev-cost;
      });
      metrics=m;metricsAt=Date.now();
    }catch(e){/* يبقى الترتيب بالبيانات الأخرى إن تعذّرت القراءة */}
    return metrics;
  }

  // أرصدة الزبائن ونشاطهم الأخير من تقرير الزبائن نفسه
  async function loadDebts(){
    if(Date.now()-debtAt<30000&&Object.keys(debtRows).length)return debtRows;
    var A=window.RafiqApp;if(!A||!A.api)return debtRows;
    try{
      var rows=await A.api.rpc('rfq_pilot_customers_report',{p_store:A.store});
      var m={};(rows||[]).forEach(function(r){m[r.id]={balance:num(r.balance_cents),last:r.last_activity||'',name:r.name};});
      debtRows=m;debtAt=Date.now();
    }catch(e){}
    return debtRows;
  }

  function sortProducts(key){
    var A=window.RafiqApp;var list=A&&A.products;if(!list||!list.length)return;
    var m=metrics;
    var cmp={
      profit:function(a,b){return num((m[b.id]||{}).profit)-num((m[a.id]||{}).profit);},
      sold:function(a,b){return num((m[b.id]||{}).sold)-num((m[a.id]||{}).sold);},
      newest:function(a,b){return ts(b.created_at||b.updated_at)-ts(a.created_at||a.updated_at);},
      oldest:function(a,b){return ts(a.created_at||a.updated_at)-ts(b.created_at||b.updated_at);},
      lowstock:function(a,b){return num(a.stock_milli)-num(b.stock_milli);},
      price:function(a,b){return num(b.price_cents)-num(a.price_cents);}
    }[key];
    if(cmp)list.sort(cmp);
  }
  function sortDebts(key){
    var A=window.RafiqApp;var list=A&&A.customers;
    if(!list||!list.length)return;
    var d=debtRows;
    var cmp={
      debt_high:function(a,b){return num((d[b.id]||{}).balance)-num((d[a.id]||{}).balance);},
      debt_low:function(a,b){var x=num((d[a.id]||{}).balance),y=num((d[b.id]||{}).balance);var px=x>0?x:Infinity,py=y>0?y:Infinity;return px-py;},
      newest:function(a,b){return ts((d[b.id]||{}).last)-ts((d[a.id]||{}).last);},
      oldest:function(a,b){return ts((d[a.id]||{}).last)-ts((d[b.id]||{}).last);}
    }[key];
    if(cmp)list.sort(cmp);
  }

  function bar(view,sorts,stateKey,apply,anchorId){
    var anchor=document.getElementById(anchorId);
    if(!anchor||document.getElementById('sortbar-'+view))return;
    var wrap=document.createElement('div');wrap.id='sortbar-'+view;wrap.className='sortbar';
    var cur=get(view,sorts[0][0]);
    sorts.forEach(function(s){
      var b=document.createElement('button');b.type='button';b.className='sort-chip'+(s[0]===cur?' on':'');
      b.textContent=s[1];b.dataset.key=s[0];
      b.addEventListener('click',async function(){
        set(view,s[0]);
        wrap.querySelectorAll('.sort-chip').forEach(function(x){x.classList.toggle('on',x===b);});
        if(view==='products'){await loadMetrics();sortProducts(s[0]);window.RafiqApp.rerenderProducts();}
        else{await loadDebts();sortDebts(s[0]);var c=document.querySelector('[data-view="customers"]');if(c)c.click();}
      });
      wrap.appendChild(b);
    });
    anchor.parentNode.insertBefore(wrap,anchor);
  }

  function ensure(){
    if(!window.RafiqApp)return;
    var pv=document.getElementById('productsView');
    if(pv&&pv.offsetParent!==null||pv&&document.getElementById('catalogList'))bar('products',PRODUCT_SORTS,'products',sortProducts,'catalogList');
    if(document.getElementById('customerList'))bar('debts',DEBT_SORTS,'debts',sortDebts,'customerList');
  }

  // عند كل إعادة رسم أو تحديث للبيانات: أعيد تطبيق الترتيب المختار
  setInterval(function(){
    ensure();
    var k=get('products','');
    if(k&&window.RafiqApp&&window.RafiqApp.products&&window.RafiqApp.products.length){
      sortProducts(k);
    }
    var dk=get('debts','');
    if(dk&&window.RafiqApp&&window.RafiqApp.customers&&window.RafiqApp.customers.length&&Object.keys(debtRows).length){
      sortDebts(dk);
    }
  },1500);
  // تحديث أرقام الترتيب بعد فتح الشاشة
  document.addEventListener('click',function(e){
    var b=e.target.closest&&e.target.closest('[data-view="products"],[data-view="customers"]');
    if(!b)return;
    setTimeout(async function(){
      if(b.getAttribute('data-view')==='products'){await loadMetrics();var k=get('products','');if(k)sortProducts(k);}
      else{await loadDebts();var dk=get('debts','');if(dk)sortDebts(dk);}
    },700);
  },true);
})();
