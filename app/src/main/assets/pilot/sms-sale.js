/* رسالة البيع الآجل للزبون: مبلغ الدين، والرصيد المستحق بعد الفاتورة، ورقم الفاتورة.
   تُرسل عبر الصندوق الصادر المحلي (شريحة الهاتف) ولا تحتاج إنترنتاً. */
(function(){
  // منزلتان عشريتان دائماً، بحسب قرار المالك
  function fmt(cents){return (Number(cents||0)/100).toFixed(2);}
  var sent={};
  function balanceOf(customerId){
    var A=window.RafiqApp;
    return A&&A.api?A.api.rpc('rfq_pilot_customers_report',{p_store:A.store}).then(function(rows){
      var r=(rows||[]).find(function(x){return x.id===customerId;});
      return r?Number(r.balance_cents||0):null;
    }).catch(function(){return null;}):Promise.resolve(null);
  }
  window.RafiqSaleEvent=async function(inv,meta){
    if(!meta||!meta.customer||!inv)return;
    var owed=Number(meta.total||0)-Number(meta.paid||0)-Number(meta.other||0);
    if(owed<=0)return; // بيع مدفوع بالكامل: لا رسالة آجل
    var num=inv.number||inv.id||'';
    var key='credit-sale-'+(inv.id||num);
    if(sent[key])return; sent[key]=true;
    var A=window.RafiqApp;
    var cust=(A.customers||[]).find(function(c){return c.id===meta.customer;})||{};
    if(!cust.phone){return;} // لا يوجد رقم هاتف للزبون: لا إرسال
    // قد تكون الفاتورة مؤقتة (أوفلاين): ننتظر قليلاً ليُحدَّث الرصيد
    await new Promise(function(r){setTimeout(r,1200);});
    var bal=await balanceOf(meta.customer);
    var balText=bal==null?'—':fmt(bal);
    var text='متجر '+(A.storeName||'')+'\n'+
      'بيع آجل: '+fmt(owed)+' ريال\n'+
      'رصيدك المستحق: '+balText+' ريال\n'+
      'رقم الفاتورة: '+num;
    if(window.RafiqSmsOutbox)window.RafiqSmsOutbox.enqueue(cust.phone,text,key);
  };
})();
