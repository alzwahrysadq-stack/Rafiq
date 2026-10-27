/* تحذير تكرار الأسماء قبل حفظ صنف أو زبون جديد. لا يمنع الحفظ نهائياً، بل يطلب تأكيداً صريحاً. */
(function(){
  function norm(s){return String(s||'').replace(/\s+/g,' ').trim().toLowerCase();}
  function guard(formId,listKey,inputId,label){
    var form=document.getElementById(formId);if(!form)return;
    form.addEventListener('submit',function(e){
      if(form.dataset.dupOk==='1'){form.dataset.dupOk='';return;}
      var A=window.RafiqApp;if(!A)return;
      var name=norm((document.getElementById(inputId)||{}).value);
      if(!name)return;
      var list=(A[listKey]||[]);
      var hit=list.filter(function(x){return norm(x.name)===name;});
      if(!hit.length)return;
      var ok=window.confirm('يوجد '+label+' باسم «'+name+'» مسبقاً ('+hit.length+'). هل تريد إضافة آخر بالاسم نفسه؟\n\nننصح بتمييز الاسم (مثلاً بالحجم أو الوزن) أو استخدام الباركود للتمييز.');
      if(!ok){e.preventDefault();e.stopImmediatePropagation();return;}
      // تأكيد المالك: نعيد الإرسال مرة واحدة دون فحص إضافي
      e.preventDefault();e.stopImmediatePropagation();
      form.dataset.dupOk='1';
      form.requestSubmit?form.requestSubmit():form.dispatchEvent(new Event('submit',{cancelable:true,bubbles:true}));
    },true);
  }
  function wire(){
    guard('productForm','products','productName','الصنف');
    guard('customerForm','customers','customerName','الزبون');
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',wire);else wire();
  setTimeout(wire,1500);
})();
