/* شاشة البيع بشكل الفاتورة الورقية:
   - الأصناف لا تظهر منثورة، وتظهر فقط عند البحث أو قراءة الباركود.
   - الفاتورة تُعرض في المنتصف كورقة فاتورة حقيقية، وتُقرأ من السلة مباشرة.
   - زر «تأكيد» يفتح نافذة البيع الموجودة (طريقة الدفع والطباعة). */
(function(){
  var lastKey='';
  function el(tag,cls,txt){var e=document.createElement(tag);if(cls)e.className=cls;if(txt!=null)e.textContent=txt;return e;}
  function money(c){return (Number(c||0)/100).toLocaleString('en-US');}
  function qty(m){var n=Number(m||0)/1000;return Number.isInteger(n)?String(n):n.toFixed(3).replace(/0+$/,'').replace(/\.$/,'');}
  function posView(){return document.getElementById('saleGrid')&&document.getElementById('saleGrid').closest('.view');}
  function isPosOn(){var v=posView();return !!(v&&v.offsetParent);}

  function build(){
    var box=el('div','paper-wrap');box.id='paperInvoice';
    var paper=el('div','paper');paper.id='paperSheet';
    box.appendChild(paper);
    var bar=el('div','paper-bar');
    var conf=el('button','paper-confirm','تأكيد الفاتورة');conf.type='button';
    conf.addEventListener('click',function(){var A=window.RafiqApp;if(A)A.openReview();});
    bar.appendChild(conf);box.appendChild(bar);
    var grid=document.getElementById('saleGrid');
    if(grid&&grid.parentNode)grid.parentNode.insertBefore(box,grid);
  }

  function render(){
    var A=window.RafiqApp;if(!A)return;
    var cart=A.cart||[];
    var key=JSON.stringify(cart);
    if(key===lastKey&&document.getElementById('paperSheet'))return;
    lastKey=key;
    var paper=document.getElementById('paperSheet');if(!paper)return;
    paper.replaceChildren();
    var store=(document.getElementById('storeLine')||{}).textContent||'';
    store=store.split('•')[0].trim()||'متجر';
    paper.appendChild(el('div','p-store',store));
    paper.appendChild(el('div','p-sub','فاتورة بيع — '+new Date().toLocaleDateString('ar-u-ca-gregory',{day:'numeric',month:'short',year:'numeric'})));
    paper.appendChild(el('div','p-rule'));
    if(!cart.length){
      paper.appendChild(el('div','p-empty','ابدأ بقراءة الباركود أو البحث عن صنف، فيظهر هنا.'));
      return;
    }
    var head=el('div','p-row p-head');
    head.appendChild(el('span','p-n','الصنف'));head.appendChild(el('span','p-q','الكمية'));head.appendChild(el('span','p-t','المجموع'));
    paper.appendChild(head);
    var total=0;
    cart.forEach(function(l){
      var line=Math.round(Number(l.price_cents||0)*Number(l.qty_milli||0)/1000);
      total+=line;
      var r=el('div','p-row');
      r.appendChild(el('span','p-n',l.name));
      r.appendChild(el('span','p-q',qty(l.qty_milli)+' × '+money(l.price_cents)));
      r.appendChild(el('span','p-t',money(line)));
      paper.appendChild(r);
    });
    paper.appendChild(el('div','p-rule'));
    var tot=el('div','p-row p-total');
    tot.appendChild(el('span','p-n','الإجمالي'));tot.appendChild(el('span','p-q',''));tot.appendChild(el('span','p-t',money(total)+' ريال'));
    paper.appendChild(tot);
    paper.appendChild(el('div','p-rule'));
    paper.appendChild(el('div','p-thanks','شكراً لزيارتكم'));
  }

  function tick(){
    if(!isPosOn()){document.body.classList.remove('pos-paper-on');return;}
    document.body.classList.add('pos-paper-on');
    if(!document.getElementById('paperInvoice'))build();
    render();
    var q=(document.getElementById('saleSearch')||{}).value||'';
    document.body.classList.toggle('pos-searching',q.trim().length>0);
    var A=window.RafiqApp;document.body.classList.toggle('shift-open',!!(A&&A.shiftOpen&&A.shiftOpen()));
    // بعد تأكيد البيع تُفرَّغ السلة؛ نغلق نافذة المراجعة فوراً حتى لا تبقى بيانات قديمة يمكن تأكيدها ثانية
    var rv=document.getElementById('saleReview');
    if(A&&Array.isArray(A.cart)&&A.cart.length===0&&rv&&!rv.classList.contains('hide')){rv.classList.add('hide');}
  }
  setInterval(tick,400);
})();
