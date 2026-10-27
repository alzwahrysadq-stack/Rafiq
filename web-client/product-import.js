/* استيراد الأصناف من ملف Excel (.xlsx) أو CSV.
   - يقرأ العناوين العربية أو الإنجليزية، ويعرض معاينة قبل الحفظ.
   - الأصناف التي اسمها موجود مسبقاً تُتجاوز ولا تُكرَّر.
   - الحفظ يمر عبر نموذج الصنف نفسه في الصفحة (نفس التحقق ونفس المسار المجرَّب). */
(function(){
  var MAP={
    name:['اسم الصنف','الاسم','name','product'],
    barcode:['الباركود','barcode','code'],
    price:['سعر البيع','السعر','price','sale price'],
    cost:['سعر الشراء','التكلفة','cost','purchase price'],
    stock:['الكمية','المخزون','stock','qty','quantity'],
    expiry:['تاريخ الصلاحية','الصلاحية','expiry','expiry date'],
    unit:['الوحدة','unit']
  };
  function norm(s){return String(s||'').trim().toLowerCase();}
  function colIndex(headers){
    var idx={};
    Object.keys(MAP).forEach(function(k){
      idx[k]=headers.findIndex(function(h){return MAP[k].indexOf(norm(h))>=0;});
    });
    return idx;
  }
  function el(tag,cls,txt){var e=document.createElement(tag);if(cls)e.className=cls;if(txt!=null)e.textContent=txt;return e;}

  function parseRows(rows){
    if(!rows||rows.length<2)return {error:'الملف لا يحتوي على صفوف بيانات'};
    var headers=rows[0].map(String);
    var idx=colIndex(headers);
    if(idx.name<0)return {error:'لم أجد عمود اسم الصنف (اسم الصنف أو name)'};
    var out=[];
    for(var i=1;i<rows.length;i++){
      var r=rows[i]||[];
      var name=String(r[idx.name]??'').trim();
      if(!name)continue;
      out.push({
        name:name,
        barcode:idx.barcode>=0?String(r[idx.barcode]??'').trim():'',
        price:idx.price>=0?window.RafiqXlsx.num(r[idx.price]):NaN,
        cost:idx.cost>=0?window.RafiqXlsx.num(r[idx.cost]):NaN,
        stock:idx.stock>=0?window.RafiqXlsx.num(r[idx.stock]):0,
        expiry:idx.expiry>=0?String(r[idx.expiry]??'').trim():'',
        unit:idx.unit>=0?String(r[idx.unit]??'').trim():'',
        line:i+1
      });
    }
    return {rows:out};
  }

  function validate(item,existing){
    var errs=[];
    if(!isFinite(item.price)||item.price<0)errs.push('السعر غير صحيح');
    if(!isFinite(item.cost)||item.cost<0)errs.push('التكلفة غير صحيحة');
    if(!isFinite(item.stock)||item.stock<0)errs.push('الكمية غير صحيحة');
    if(existing.indexOf(norm(item.name))>=0)errs.push('موجود مسبقاً (يُتجاوز)');
    return errs;
  }

  function setField(id,val){var e=document.getElementById(id);if(!e)return false;e.value=val;e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));return true;}
  function wait(ms){return new Promise(function(r){setTimeout(r,ms);});}

  // حفظ صنف واحد عبر نموذج الصنف، والتحقق من ازدياد عدد الأصناف
  async function saveOne(item){
    var A=window.RafiqApp;var before=A.products.length;
    setField('productName',item.name);setField('productBarcode',item.barcode||'');
    setField('productPrice',isFinite(item.price)?String(item.price):'');
    setField('productCost',isFinite(item.cost)?String(item.cost):'');
    setField('productStock',String(item.stock||0));
    if(item.expiry)setField('productExpiry',item.expiry);
    var form=document.getElementById('productForm');
    form.dataset.dupOk='1';
    form.dispatchEvent(new Event('submit',{cancelable:true,bubbles:true}));
    for(var i=0;i<30;i++){await wait(250);if(A.products.length>before)return true;}
    return false;
  }

  function openPanel(){
    var old=document.getElementById('importPanel');if(old)old.remove();
    var panel=el('div','card');panel.id='importPanel';panel.style.margin='8px 0';
    panel.appendChild(el('div','',"استيراد الأصناف من ملف Excel أو CSV"));
    var file=el('input');file.type='file';file.accept='.xlsx,.csv';file.id='importFile';
    var info=el('div','muted','');info.id='importInfo';
    var list=el('div','');list.id='importList';
    var go=el('button','btn p sm','استيراد الأصناف الجديدة');go.type='button';go.disabled=true;go.style.marginTop='8px';
    var close=el('button','btn ghost sm','إغلاق');close.type='button';close.style.marginInlineStart='6px';
    var parsed=null;
    close.onclick=function(){panel.remove();};
    file.onchange=async function(){
      var f=file.files&&file.files[0];if(!f)return;
      info.textContent='جارٍ قراءة الملف…';list.replaceChildren();
      try{
        var rows;
        if(/\.csv$/i.test(f.name)){rows=window.RafiqXlsx.csv(await f.text());}
        else{rows=window.RafiqXlsx.read(new Uint8Array(await f.arrayBuffer()));}
        parsed=parseRows(rows);
        if(parsed.error){info.textContent=parsed.error;go.disabled=true;return;}
        var A=window.RafiqApp;
        var existing=(A.products||[]).map(function(p){return norm(p.name);});
        var ok=0,skip=0;
        var t=el('table','tbl');
        t.innerHTML='<tr><th>سطر</th><th>الاسم</th><th>السعر</th><th>الكمية</th><th>الحالة</th></tr>';
        parsed.rows.forEach(function(it){
          var errs=validate(it,existing);
          var bad=errs.filter(function(x){return x.indexOf('يُتجاوز')<0;}).length>0;
          var tr=el('tr');
          [it.line,it.name,isFinite(it.price)?it.price:'—',it.stock,(bad?'خطأ: '+errs.join('، '):(errs.length?errs.join('، '):'جاهز'))].forEach(function(v){tr.appendChild(el('td','',String(v)));});
          t.appendChild(tr);
          if(!bad&&!errs.length)ok++;else skip++;
          it.ready=!bad&&!errs.length;
        });
        info.textContent='عدد الصفوف: '+parsed.rows.length+' • جاهز للاستيراد: '+ok+' • يُتجاوز: '+skip;
        list.appendChild(t);
        go.disabled=ok===0;
        go.onclick=async function(){
          go.disabled=true;var done=0,failed=[];
          var ready=parsed.rows.filter(function(x){return x.ready;});
          for(var i=0;i<ready.length;i++){
            info.textContent='جارٍ الحفظ '+(i+1)+' من '+ready.length+'…';
            var okSave=await saveOne(ready[i]);
            if(okSave)done++;else failed.push(ready[i].name);
          }
          info.textContent='تم استيراد '+done+' صنفاً'+(failed.length?' — فشل: '+failed.join('، '):' ✓');
          if(window.RafiqApp)window.RafiqApp.rerenderProducts();
        };
      }catch(e){info.textContent='تعذّر قراءة الملف: '+(e&&e.message?e.message:e);go.disabled=true;}
    };
    panel.appendChild(file);panel.appendChild(info);panel.appendChild(list);
    var row=el('div','');row.style.marginTop='6px';row.appendChild(go);row.appendChild(close);panel.appendChild(row);
    var view=document.getElementById('productsView');
    if(view)view.insertBefore(panel,view.firstChild);
  }

  function addButton(){
    var view=document.getElementById('productsView');
    if(!view||document.getElementById('importBtn'))return;
    var b=document.createElement('button');b.id='importBtn';b.type='button';
    b.className='btn ghost wide';b.style.margin='6px 0';
    b.textContent='📥 استيراد الأصناف من Excel';
    b.addEventListener('click',openPanel);
    view.insertBefore(b,view.firstChild);
  }
  setInterval(addButton,2000);
})();
