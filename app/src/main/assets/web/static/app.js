/* أدوات مشتركة للواجهة — عربي RTL */
const CUR = window.CURRENCY || '';

function money(cents){
  // الريال وحدة كاملة — بلا فواصل عشرية (قرار المالك)
  const neg = cents < 0; cents = Math.abs(Math.round(cents||0));
  const s = (cents/100).toLocaleString('en-US',{minimumFractionDigits:0, maximumFractionDigits:0});
  return (neg?'-':'') + s + (CUR? ' '+CUR : '');
}
function cents(str){
  if(str===null||str===undefined) return 0;
  str = String(str).trim().replace(/[٠-٩]/g, d=>'٠١٢٣٤٥٦٧٨٩'.indexOf(d))
       .replace(/,/g,'').replace(/[^\d.\-]/g,'');
  if(!str) return 0;
  const c = Math.round(parseFloat(str)*100)||0;
  return Math.round(c/100)*100;   // تقريب إلى ريال كامل
}
async function api(url, data, method){
  const opt = {method: method || (data!==undefined?'POST':'GET'), headers:{'Content-Type':'application/json'}};
  if(data!==undefined) opt.body = JSON.stringify(data);
  const r = await fetch(url, opt);
  let j; try{ j = await r.json(); }catch(e){ j = {ok:false, error:'خطأ في الاتصال'}; }
  if(r.status===401){ location.href='/login'; }
  return j;
}
let toastTimer;
function toast(msg, type){
  let t = document.getElementById('toast');
  if(!t){ t = document.createElement('div'); t.id='toast'; t.className='toast'; document.body.appendChild(t); }
  t.textContent = msg; t.className = 'toast '+(type||'');
  t.style.display='block';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(()=>{ t.style.display='none'; }, 2600);
}
function beep(ok){
  try{
    const C = new (window.AudioContext||window.webkitAudioContext)();
    const o = C.createOscillator(), g = C.createGain();
    o.connect(g); g.connect(C.destination);
    o.frequency.value = ok===false? 220 : 950; o.type='square';
    g.gain.value = .06;
    o.start(); o.stop(C.currentTime + (ok===false? .25 : .09));
  }catch(e){}
}
function vib(ms){ try{ navigator.vibrate && navigator.vibrate(ms||35); }catch(e){} }
function openModal(id){ document.getElementById(id).classList.add('open'); }
function closeModal(id){ document.getElementById(id).classList.remove('open'); }
function printArea(){ window.print(); }

/* مراقبة قارئ الباركود: القارئ يكتب سريعاً وينهي بـ Enter.
   نلتقط أي كتابة سريعة (<40ms بين الحروف) حتى لو لم يكن الحقل مركّزاً. */
function watchScanner(onCode){
  let buf = '', last = 0;
  document.addEventListener('keydown', (e)=>{
    const now = Date.now();
    if(now - last > 90){ buf = ''; }
    last = now;
    if(e.key === 'Enter'){
      if(buf.length >= 5){ onCode(buf); }
      buf = '';
      return;
    }
    if(e.key.length === 1){ buf += e.key; }
  });
}

/* كاميرا الجوال + BarcodeDetector حيث يدعمها المتصفح، وإلا رسالة واضحة */
async function openCameraScanner(onCode){
  const MD = document.getElementById('camModal');
  const V  = document.getElementById('camVideo');
  MD.classList.add('open');
  if(!('BarcodeDetector' in window)){
    document.getElementById('camNote').textContent =
      'متصفح هذا الجهاز لا يدعم القراءة بالكاميرا. استخدم قارئ الباركود أو اكتب الاسم/الرقم.';
    return;
  }
  try{
    const stream = await navigator.mediaDevices.getUserMedia({video:{facingMode:'environment'}});
    V.srcObject = stream; await V.play();
    const det = new BarcodeDetector({formats:['ean_13','ean_8','code_128','code_39','upc_a','upc_e','qr_code','itf']});
    let stop = false;
    const tick = async ()=>{
      if(stop || !MD.classList.contains('open')) return;
      try{
        const codes = await det.detect(V);
        if(codes && codes.length){
          beep(); vib();
          stop = true;
          stream.getTracks().forEach(t=>t.stop());
          MD.classList.remove('open');
          onCode(codes[0].rawValue);
          return;
        }
      }catch(e){}
      setTimeout(tick, 220);
    };
    document.getElementById('camStop').onclick = ()=>{
      stop = true; stream.getTracks().forEach(t=>t.stop()); MD.classList.remove('open');
    };
    tick();
  }catch(e){
    document.getElementById('camNote').textContent = 'لم نتمكن من فتح الكاميرا: تأكد من الصلاحية. ('+e.message+')';
  }
}

/* واتساب: يبني رابطاً صحيحاً من الرقم — يدعم الأرقام المحلية (تبدأ بـ 0) بمفتاح الدولة */
function waHref(phone, text){
  let ph = String(phone==null? '' : phone).replace(/[^\d+]/g, '').replace(/\+/g, '');
  if(ph.startsWith('00')) ph = ph.slice(2);                     // 00967… ← 967…
  const cc = String(window.COUNTRY_CODE || '').replace(/\D/g, '');
  if(cc && ph.startsWith('0')) ph = cc + ph.replace(/^0+/, ''); // 0501… ← 967501…
  else if(cc && ph.length && ph.length <= 9) ph = cc + ph;      // 501… بلا مفتاح ولا صفر
  else if(!cc && ph.startsWith('0')) ph = ph.replace(/^0+/, '');
  return 'https://wa.me/' + ph + (text ? '?text=' + encodeURIComponent(text) : '');
}
function waOpen(phone, text){
  const digits = String(phone||'').replace(/\D/g, '');
  if(!digits){ toast('لا يوجد رقم واتساب لهذا الطرف — أضف الرقم أولاً', 'err'); return false; }
  if(digits.length < 7){ toast('رقم الواتساب غير مكتمل — راجعه', 'err'); return false; }
  window.open(waHref(phone, text), '_blank');
  return true;
}
