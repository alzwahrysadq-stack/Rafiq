/* طباعة فواتير حرارية (58 مم و80 مم) للكاشير الصغيرة المحمولة والمتوسطة.
   الفكرة: يُرسم الإيصال كصورة بالخط العربي الصحيح، ثم يُرسل كصورة نقطية بأمر ESC/POS (GS v 0)،
   فيعمل مع أي موديل دون الحاجة إلى صفحات ترميز عربية تختلف بين الطابعات.
   النقل الفعلي للطابعة يمر عبر الجسر الأصلي RafiqThermalNative.printRaw(base64, profile) إن وُجد. */
(function(){
  var PROFILES={
    '58':{label:'58 مم (محمولة صغيرة)',dots:384},
    '80':{label:'80 مم (متوسطة)',dots:576}
  };
  var FONT_B='Tajawal,"Segoe UI",Tahoma,sans-serif';

  // يقسم النص إلى أسطر تناسب عرض الصورة، مع الحفاظ على الفقرات
  function wrap(ctx,text,maxW){
    var out=[];
    String(text).split('\n').forEach(function(para){
      var words=para.split(' '),line='';
      words.forEach(function(w){
        var t=line?line+' '+w:w;
        if(ctx.measureText(t).width>maxW&&line){out.push(line);line=w;}else line=t;
      });
      out.push(line);
    });
    return out;
  }

  // يرسم الإيصال: lines = [{t:'نص',b:true,c:true,s:18}] أو نص عادي
  function render(lines,profile){
    var W=PROFILES[profile].dots;
    var c=document.createElement('canvas');c.width=W;c.height=10;
    var ctx=c.getContext('2d');
    var pad=12,rows=[];
    lines.forEach(function(ln){
      if(typeof ln==='string')ln={t:ln};
      if(ln.rule){rows.push({rule:true});return;}
      var size=ln.s||(ln.b?26:22);
      ctx.font=(ln.b?'800 ':'500 ')+size+'px '+FONT_B;
      wrap(ctx,ln.t,W-pad*2).forEach(function(t){rows.push({t:t,b:ln.b,size:size,c:ln.c,lr:ln.lr});});
    });
    var lh=34,H=pad*2;
    rows.forEach(function(r){H+=r.rule?14:(r.size*1.45|0);});
    c.height=Math.ceil(H);
    ctx=c.getContext('2d');
    ctx.fillStyle='#fff';ctx.fillRect(0,0,W,c.height);
    ctx.fillStyle='#000';ctx.textBaseline='top';
    var y=pad;
    rows.forEach(function(r){
      if(r.rule){ctx.fillRect(pad,y+5,W-pad*2,2);y+=14;return;}
      ctx.font=(r.b?'800 ':'500 ')+r.size+'px '+FONT_B;
      ctx.direction='rtl';
      if(r.c){ctx.textAlign='center';ctx.fillText(r.t,W/2,y);}
      else{ctx.textAlign='right';ctx.fillText(r.t,W-pad,y);}
      y+=r.size*1.45|0;
    });
    return c;
  }

  // يحوّل الصورة إلى بتات أحادية اللون ويجهّز أمر ESC/POS GS v 0 (طباعة نقطية)
  function raster(canvas){
    var w=canvas.width,h=canvas.height,ctx=canvas.getContext('2d');
    var px=ctx.getImageData(0,0,w,h).data;
    var bytesPerRow=(w+7)>>3;
    var out=new Uint8Array(bytesPerRow*h);
    for(var y=0;y<h;y++){
      for(var x=0;x<w;x++){
        var i=(y*w+x)*4;
        var lum=(px[i]*0.3+px[i+1]*0.59+px[i+2]*0.11);
        if(lum<150) out[y*bytesPerRow+(x>>3)]|=(0x80>>(x&7));
      }
    }
    var hdr=[0x1D,0x76,0x30,0x00,bytesPerRow&0xFF,(bytesPerRow>>8)&0xFF,h&0xFF,(h>>8)&0xFF];
    var all=new Uint8Array(hdr.length+out.length);
    all.set(hdr,0);all.set(out,hdr.length);
    return all;
  }

  // مهمة الطباعة الكاملة: تهيئة + صورة + تغذية + قطع جزئي إن كانت الطابعة تدعمه
  function job(canvas,opts){
    opts=opts||{};
    var img=raster(canvas);
    var init=[0x1B,0x40];
    var feed=[0x1B,0x64,0x04];
    var cut=opts.cut===false?[]:[0x1D,0x56,0x42,0x00];
    var parts=[new Uint8Array(init),img,new Uint8Array(feed),new Uint8Array(cut)];
    var len=parts.reduce(function(a,p){return a+p.length;},0);
    var all=new Uint8Array(len),o=0;
    parts.forEach(function(p){all.set(p,o);o+=p.length;});
    return all;
  }

  function toBase64(bytes){
    var s='';for(var i=0;i<bytes.length;i+=0x8000){s+=String.fromCharCode.apply(null,bytes.subarray(i,i+0x8000));}
    return btoa(s);
  }

  // يرسل إلى الطابعة عبر الجسر الأصلي إن وُجد، وإلا يُعيد سبب التعذّر بوضوح
  function send(base64,profile){
    var b=window.RafiqThermalNative;
    if(b&&typeof b.printRaw==='function'){
      try{var res=b.printRaw(base64,profile);return {ok:true,res:res};}
      catch(e){return {ok:false,reason:'تعذّر إرسال الأمر للطابعة: '+e.message};}
    }
    return {ok:false,reason:'الطباعة المباشرة للطابعة الحرارية تحتاج جسر الطابعة في تطبيق أندرويد، ولم يُدمج بعد. الطباعة من زر الطباعة العادي ما زالت تعمل.'};
  }

  window.RafiqThermal={
    profiles:PROFILES,
    render:render, raster:raster, job:job, toBase64:toBase64, send:send,
    // يبني الإيصال من نص الفاتورة الظاهر ويرسله للطابعة المحددة
    printLines:function(lines,profile,opts){
      var canvas=render(lines,profile);
      var bytes=job(canvas,opts);
      return send(toBase64(bytes),profile);
    }
  };
})();

/* زر «طباعة حرارية» بجانب زر الطباعة الموجود، مع اختيار عرض الورق (58 أو 80 مم) */
(function(){
  function linesFromReceipt(){
    var root=document.querySelector('.receipt');
    if(!root)return [];
    var out=[];
    root.querySelectorAll('h3,h2,p,tr,div.line,.grand').forEach(function(el){
      if(el.closest('tr')&&el.tagName!=='TR')return;
      if(el.classList.contains('line')){out.push({rule:true});return;}
      var t=(el.innerText||el.textContent||'').replace(/\s+/g,' ').trim();
      if(!t)return;
      var big=el.tagName==='H3'||el.classList.contains('grand');
      out.push({t:t,b:big,c:el.tagName==='H3'||el.getAttribute('align')==='center',s:big?30:22});
    });
    return out;
  }
  function ensureUi(){
    var anchor=document.getElementById('printInvoice');
    if(!anchor||document.getElementById('thermalPrint'))return;
    var wrap=document.createElement('span');
    wrap.style.cssText='display:inline-flex;gap:6px;align-items:center;margin-inline-start:6px';
    var sel=document.createElement('select');sel.id='thermalWidth';
    sel.setAttribute('aria-label','عرض الورق');
    sel.style.cssText='min-height:44px;border-radius:10px;padding:6px;border:1.5px solid #e3e9f1';
    sel.innerHTML='<option value="80">80 مم</option><option value="58">58 مم</option>';
    sel.value=localStorage.getItem('rafiq-thermal-width')||'80';
    sel.addEventListener('change',function(){localStorage.setItem('rafiq-thermal-width',sel.value);});
    var btn=document.createElement('button');btn.id='thermalPrint';btn.type='button';
    btn.className='btn p sm';btn.textContent='🧾 طباعة حرارية';
    btn.addEventListener('click',function(){
      var lines=linesFromReceipt();
      if(!lines.length){alert('لا توجد فاتورة للطباعة. اعرض الفاتورة أولاً.');return;}
      var r=RafiqThermal.printLines(lines,sel.value);
      alert(r.ok?'أُرسلت الفاتورة إلى الطابعة.':r.reason);
    });
    wrap.appendChild(btn);wrap.appendChild(sel);
    anchor.insertAdjacentElement('afterend',wrap);
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',ensureUi);else ensureUi();
  setTimeout(ensureUi,1500);
})();
