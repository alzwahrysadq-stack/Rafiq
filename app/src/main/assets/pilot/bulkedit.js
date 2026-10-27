/* تعديل الأسعار والكميات والتواريخ للأصناف الموجودة بعد استيرادها.
   الاسم والباركود للعرض فقط ولا يتغيّران. كل تغيير يمر عبر نفس دوال الخادم/الجهاز المستخدمة في الصفحة. */
(function(){
  // لا خروج مبكر هنا: web.js وحدة (module) تُنفَّذ بعد هذا السكربت، والوظائف تقرأ RafiqApp عند النقر
  var MAX=1000000000;

  // تعديل الكمية يمر عبر نموذج المخزون نفسه في الصفحة (نفس التحقق ونفس المسار المجرَّب)
  async function viaStockForm(p,delta){
    var sel=document.getElementById('adjustProduct'),act=document.getElementById('stockAction'),
        qty=document.getElementById('stockQty'),reason=document.getElementById('stockReason'),
        form=document.getElementById('stockAdjustmentForm');
    if(!sel||!act||!qty||!form)throw new Error('نموذج المخزون غير متاح في هذه الشاشة');
    sel.value=p.id;act.value=delta>0?'receive':'loss';
    qty.value=String(Math.abs(delta)/1000);reason.value='تعديل من شاشة الأسعار والكميات';
    form.dispatchEvent(new Event('submit',{cancelable:true,bubbles:true}));
    for(var i=0;i<40;i++){
      await new Promise(function(r){setTimeout(r,200);});
      var cur=window.RafiqApp.products.find(function(x){return x.id===p.id;});
      if(cur&&cur.stock_milli===p.stock_milli+delta)return;
    }
    throw new Error('لم يُؤكَّد تحديث الكمية بعد — راجع الرسالة في أعلى الشاشة');
  }

  function num(v){var n=Number(String(v).replace(/,/g,'').trim());return isFinite(n)?n:NaN;}
  function el(tag,css,text){var e=document.createElement(tag);if(css)e.style.cssText=css;if(text!=null)e.textContent=text;return e;}

  function open(){
    var A=window.RafiqApp;
    if(!A.isOwner()){alert('تعديل الأسعار والكميات للمالك فقط.');return;}
    var items=(A.products||[]).slice().sort(function(a,b){return String(a.name).localeCompare(String(b.name),'ar');});
    if(!items.length){alert('لا توجد أصناف للتعديل. أضف أصنافاً أولاً أو استوردها من ملف.');return;}

    var ov=el('div','position:fixed;inset:0;z-index:260;background:rgba(7,22,44,.5);display:flex;align-items:flex-end;justify-content:center');
    ov.id='bulkEditOverlay';
    var box=el('div','background:#fff;width:100%;max-width:560px;max-height:92vh;border-radius:18px 18px 0 0;display:flex;flex-direction:column;box-sizing:border-box;padding:12px');
    var title=el('div','font-weight:800;font-size:17px;color:#002651;margin-bottom:4px','تعديل الأسعار والكميات والتواريخ');
    var note=el('div','font-size:13px;color:#5b6b80;margin-bottom:8px','الاسم والباركود لا يُعدَّلان. عدّل ما تحتاجه ثم اضغط حفظ.');
    var list=el('div','flex:1 1 auto;overflow:auto;min-height:0');
    var rows=[];
    items.forEach(function(p){
      var r=el('div','border:1px solid #e3e9f1;border-radius:12px;padding:8px;margin-bottom:8px');
      r.appendChild(el('div','font-weight:800;font-size:15px','' + p.name));
      r.appendChild(el('div','font-size:12px;color:#5b6b80;margin-bottom:6px','الباركود: ' + (p.barcode||'—')));
      var grid=el('div','display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px');
      var price=el('input','min-height:40px;border:1.5px solid #e3e9f1;border-radius:10px;padding:6px;font-size:15px');
      price.type='number';price.inputMode='decimal';price.min='0';price.placeholder='السعر';price.value=(p.price_cents||0)/100;
      var stock=el('input','min-height:40px;border:1.5px solid #e3e9f1;border-radius:10px;padding:6px;font-size:15px');
      stock.type='number';stock.inputMode='decimal';stock.min='0';stock.placeholder='الكمية';stock.value=(p.stock_milli||0)/1000;
      var exp=el('input','min-height:40px;border:1.5px solid #e3e9f1;border-radius:10px;padding:6px;font-size:14px');
      exp.type='date';exp.value=p.expiry_date?String(p.expiry_date).slice(0,10):'';
      grid.appendChild(price);grid.appendChild(stock);grid.appendChild(exp);
      r.appendChild(grid);
      list.appendChild(r);
      rows.push({p:p,price:price,stock:stock,exp:exp});
    });

    var status=el('div','font-size:13px;min-height:18px;margin:6px 0;color:#b91c1c');
    var bar=el('div','display:flex;gap:8px;padding-top:8px');
    var cancel=el('button','flex:1;min-height:50px;border-radius:14px;border:1.5px solid #002651;background:#fff;color:#002651;font-weight:800;font-size:16px','إلغاء');cancel.type='button';
    var save=el('button','flex:2;min-height:50px;border-radius:14px;border:0;background:#002651;color:#fff;font-weight:800;font-size:16px','حفظ التعديلات');save.type='button';
    cancel.onclick=function(){ov.remove();};
    save.onclick=function(){run(rows,status,save,ov);};
    bar.appendChild(cancel);bar.appendChild(save);
    box.appendChild(title);box.appendChild(note);box.appendChild(list);box.appendChild(status);box.appendChild(bar);
    ov.appendChild(box);document.body.appendChild(ov);
  }

  async function run(rows,status,save,ov){
    var A=window.RafiqApp,api=A.api,store=A.store;
    status.style.color='#b91c1c';status.textContent='';
    // 1) تحقق من المدخلات قبل أي حفظ
    var plan=[],errs=[];
    rows.forEach(function(r){
      var p=r.p,pr=num(r.price.value),st=num(r.stock.value),ex=r.exp.value||'';
      var rowErr=[];
      if(!isFinite(pr)||pr<0||pr>MAX)rowErr.push('السعر غير صحيح');
      if(!isFinite(st)||st<0||st>MAX)rowErr.push('الكمية غير صحيحة');
      if(rowErr.length){errs.push(p.name+': '+rowErr.join('، '));return;}
      var cents=Math.round(pr*100),milli=Math.round(st*1000);
      var item={p:p,priceChanged:cents!==(p.price_cents||0),cents:cents,
        stockChanged:milli!==(p.stock_milli||0),delta:milli-(p.stock_milli||0),milli:milli,
        expChanged:ex!==String(p.expiry_date||'').slice(0,10),ex:ex};
      if(item.priceChanged||item.stockChanged||item.expChanged)plan.push(item);
    });
    if(errs.length){status.textContent=errs.slice(0,3).join(' — ');return;}
    if(!plan.length){status.style.color='#17795e';status.textContent='لا توجد تغييرات للحفظ.';return;}
    if(plan.some(function(i){return i.priceChanged&&(i.p.cost_cents===undefined||i.p.cost_cents===null);})){
      status.textContent='تعذّر تعديل السعر: تكلفة بعض الأصناف غير معروفة على هذا الجهاز. افتح الشاشة وهو متصل بالخادم، أو عدّل التكلفة أولاً.';return;
    }
    // 2) الحفظ: صنف بصنف، ويُبلَّغ بكل نجاح أو فشل
    save.disabled=true;var ok=0,fail=[];
    for(var i=0;i<plan.length;i++){
      var it=plan[i],p=it.p;
      status.style.color='#5b6b80';status.textContent='جارٍ الحفظ '+(i+1)+' من '+plan.length+'…';
      var parts=[];
      try{
        if(it.priceChanged){
          await api.rpc('rfq_pilot_save_product',{p_store:store,p_id:p.id,p_name:p.name,p_barcode:p.barcode||'',p_unit:p.unit||'حبة',p_price_cents:it.cents,p_cost_cents:p.cost_cents,p_initial_stock_milli:0});
          p.price_cents=it.cents;parts.push('السعر');
        }
        if(it.stockChanged){
          await viaStockForm(p,it.delta);
          p.stock_milli=it.milli;parts.push('الكمية');
        }
        if(it.expChanged&&it.ex){
          await api.rpc('rfq_pilot_set_product_expiry',{p_store:store,p_product:p.id,p_expiry:it.ex});
          p.expiry_date=it.ex;parts.push('التاريخ');
        }
        ok++;
      }catch(e){fail.push(p.name+': '+(parts.length?'حُفظ '+parts.join(' و')+'، وفشل الباقي — ':'')+(e&&e.message?e.message:'فشل الحفظ'));}
    }
    save.disabled=false;
    if(fail.length){status.style.color='#b91c1c';status.textContent='حُفظ '+ok+' ، وفشل '+fail.length+': '+fail.slice(0,2).join(' — ');return;}
    status.style.color='#17795e';status.textContent='تم حفظ '+ok+' صنف بنجاح ✓';
    setTimeout(function(){ov.remove();A.rerenderProducts();},900);
  }

  function addButton(){
    var view=document.getElementById('productsView');
    if(!view||document.getElementById('bulkEditBtn'))return;
    var b=document.createElement('button');b.id='bulkEditBtn';b.type='button';
    b.className='btn ghost wide';b.style.cssText='margin:6px 0 10px';
    b.textContent='✏️ تعديل الأسعار والكميات والتواريخ';
    b.addEventListener('click',open);
    view.insertBefore(b,view.firstChild);
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',addButton);else addButton();
  setInterval(addButton,2000);
})();
