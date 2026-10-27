/* كاميرا داخل التطبيق لتصوير فاتورة الشراء: معاينة مباشرة + إطار توجيه.
   إن تعذّرت الكاميرا (إذن مرفوض أو متصفح لا يدعمها) يعود الزر إلى كاميرا الهاتف الأصلية كاحتياط. */
(function(){
  var btn=document.getElementById('ocrCaptureBtn');
  var input=document.getElementById('ocrFile');
  if(!btn||!input||!(navigator.mediaDevices&&navigator.mediaDevices.getUserMedia))return;

  btn.addEventListener('click',function(e){
    e.stopImmediatePropagation();
    e.preventDefault();
    openCam();
  },true);

  var overlay=null,video=null,stream=null;

  function mk(tag,css,text){
    var el=document.createElement(tag);
    if(css)el.style.cssText=css;
    if(text!=null)el.textContent=text;
    return el;
  }

  function build(){
    overlay=mk('div','position:fixed;inset:0;z-index:300;background:#000;display:flex;flex-direction:column;align-items:center;padding:10px;box-sizing:border-box;gap:8px');
    overlay.id='invoiceCam';
    overlay.setAttribute('role','dialog');

    var hint=mk('div','flex:none;color:#fff;font-weight:800;font-size:15px;text-align:center;padding:6px;width:100%','ضع الفاتورة داخل الإطار، واجعل الإضاءة جيدة');

    var stage=mk('div','position:relative;flex:1 1 0;min-height:0;width:100%;max-width:520px;overflow:hidden;border-radius:12px;background:#111');
    video=mk('video','position:absolute;left:0;top:0;width:100%;height:100%;object-fit:contain');
    video.setAttribute('playsinline','');video.setAttribute('autoplay','');video.muted=true;
    var frame=mk('div','position:absolute;left:6%;right:6%;top:8%;bottom:8%;border:3px dashed #fcc43f;border-radius:14px;pointer-events:none');
    stage.appendChild(video);stage.appendChild(frame);

    var bar=mk('div','flex:none;display:flex;gap:10px;width:100%;max-width:520px;padding:6px 0');
    var cancel=mk('button','flex:1;min-height:52px;border-radius:14px;border:1.5px solid #fff;background:transparent;color:#fff;font-weight:800;font-size:16px','إلغاء');
    cancel.type='button';
    var shot=mk('button','flex:2;min-height:52px;border-radius:14px;border:0;background:#fcc43f;color:#002651;font-weight:800;font-size:17px','📷 التقاط');
    shot.type='button';
    cancel.addEventListener('click',closeCam);
    shot.addEventListener('click',takeShot);
    bar.appendChild(cancel);bar.appendChild(shot);

    overlay.appendChild(hint);overlay.appendChild(stage);overlay.appendChild(bar);
    document.body.appendChild(overlay);
  }

  function openCam(){
    if(!overlay)build();
    overlay.style.display='flex';
    navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'},width:{ideal:1920},height:{ideal:1920}},audio:false})
      .then(function(s){stream=s;video.srcObject=s;return video.play();})
      .catch(function(){closeCam();input.click();});
  }

  function closeCam(){
    if(stream){stream.getTracks().forEach(function(t){t.stop();});stream=null;}
    if(video)video.srcObject=null;
    if(overlay)overlay.style.display='none';
  }

  function takeShot(){
    var w=video.videoWidth,h=video.videoHeight;
    if(!w||!h)return;
    var scale=Math.min(1,1600/Math.max(w,h));
    var c=document.createElement('canvas');
    c.width=Math.round(w*scale);c.height=Math.round(h*scale);
    c.getContext('2d').drawImage(video,0,0,c.width,c.height);
    c.toBlob(function(blob){
      if(!blob)return;
      var file=new File([blob],'invoice-'+Date.now()+'.jpg',{type:'image/jpeg'});
      var dt=new DataTransfer();dt.items.add(file);
      input.files=dt.files;
      closeCam();
      input.dispatchEvent(new Event('change',{bubbles:true}));
    },'image/jpeg',0.92);
  }
})();
