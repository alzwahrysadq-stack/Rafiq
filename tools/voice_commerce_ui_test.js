// فحوص واجهة صوتية مالية/طباعة/مشاركة ببيانات وهمية؛ لا بيع حقيقي ولا واتساب فعلي.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {JSDOM, ResourceLoader} = require('jsdom');
const WEB = path.resolve(__dirname, '../app/src/main/assets/web');
class Assets extends ResourceLoader {
  fetch(url) {
    const prefix = '/assets/web/';
    if (!url.includes(prefix)) return null;
    const name = url.split(prefix)[1];
    if (!name || name.includes('..')) return null;
    const file = path.join(WEB, name);
    return fs.existsSync(file) ? Promise.resolve(fs.readFileSync(file)) : null;
  }
}
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, description) {
  for(let i=0;i<100;i++){ if(fn()) return; await wait(20); }
  assert.fail('timeout waiting for '+description);
}
async function app(route='/pos') {
  const windowDom = new JSDOM('<!doctype html><html><body></body></html>', {
    url:'https://appassets.androidplatform.net/assets/web/index.html?p='+encodeURIComponent(route),
    runScripts:'dangerously', resources:new Assets(), pretendToBeVisual:true,
  });
  const w=windowDom.window, calls=[], queries=[], shares=[], prints=[], listens=[];
  w.scrollTo=()=>{}; w.Response=Response; w.confirm=()=>true;
  w.RafiqDevice={version:()=> 'test', listen:()=>listens.push(1),
    shareInvoicePdf:id=>shares.push(id), print:()=>prints.push(1)};
  const products=[{id:1,name:'حليب',barcode:'111',unit:'حبة',price_cents:1000,stock:10,loc:'رف 2'}];
  const customer={id:42,code:'#00042',name:'خالد',phone:'777123456',balance_cents:3500};
  const inv={id:55,number:55,created_at:'2026-10-14 13:00:00',payment_type:'credit',status:'open',
    subtotal_cents:2000,discount_cents:0,total_cents:2000,paid_cents:0,due_cents:2000,
    received_cents:null,change_cents:null};
  const common={u:{id:1,name:'مالك وهمي',role:'owner'},
    S:{currency:'ريال',store_name:'متجر وهمي',invoice_footer:'شكراً',store_phone:'',store_logo:'',low_stock_default:2}};
  w.RafiqNative={
    page(method,pathname){
      calls.push([method,pathname]);
      assert.equal(method,'GET','voice may only read pages');
      const p=pathname.split('?')[0], invoice=p.startsWith('/invoice/'), productForm=p==='/products/new';
      const ctx={...common,shift:{id:1},users:[common.u],logs:[],p:null,share_choices:[],
        inv, customer, worker:{name:'مالك وهمي'}, items:[{name:'حليب',unit:'حبة',qty:2,price_cents:1000,total_cents:2000}],
        payments:[],a4:pathname.includes('a4=1'),autoprint:pathname.includes('print=1')};
      return JSON.stringify({status:200,path:p,endpoint:invoice?'invoice':productForm?'product_new':p==='/login'?'login':'pos',
        template:invoice?'invoice.html':productForm?'product_form.html':p==='/login'?'login.html':'pos.html',ctx,flashes:[]});
    },
    api(method,url,body){
      queries.push([method,url,body]);
      assert.equal(method,'GET','speech must never call POST /api/sale or any financial write');
      const q=decodeURIComponent((url.split('q=')[1]||'').replace(/\+/g,' '));
      if(url.startsWith('/api/search?q=')){
        return JSON.stringify({status:200,body:JSON.stringify({ok:true,products:products.filter(p=>p.name.includes(q)||p.barcode.includes(q))})});
      }
      if(url.startsWith('/api/customers?q=')){
        return JSON.stringify({status:200,body:JSON.stringify({ok:true,customers:customer.code===q||customer.name.includes(q)?[customer]:[]})});
      }
      throw new Error('unexpected API '+url);
    },
  };
  for(const file of ['vendor/nunjucks.min.js','routes.js','templates.js','engine.js']){
    w.eval(fs.readFileSync(path.join(WEB,file),'utf8'));
  }
  await until(()=> !!w.document.querySelector(route.startsWith('/invoice')?'.invoice-tools':route==='/login'?'.login-card':'.pos-wrap'), 'page');
  if(route==='/pos') await until(()=>!!w.rafiqVoicePos,'POS hooks');
  if(route.startsWith('/invoice')) await until(()=>typeof w.printInvoice==='function','invoice scripts');
  await wait(60); // اكتمال تحميل أصول الصفحة قبل إغلاق نافذة jsdom.
  return {windowDom,w,products,customer,inv,calls,queries,shares,prints,listens,
    by:id=>w.document.getElementById(id)};
}
function hear(a,words){
  a.by('rafiqMic').click();
  assert.ok(a.by('rafiqVoiceShade'));
  a.w.__rafiqVoiceCandidates(Array.isArray(words)?words:[words]);
}
(async()=>{
  const a=await app();
  const c=a.w.rafiqVoiceCommand;
  assert.deepEqual([c('أضف حليب عدد ٢').type,c('أضف حليب عدد ٢').qty,c('أضف حليب عدد ٢').query],['cart',2,'حليب']);
  assert.equal(c('أضف 3 حليب').qty,3);
  assert.equal(c('أضف صنف جديد').path,'/products/new');
  assert.deepEqual([c('أضف صنف جديد قهوة بسعر ٣٠').type,c('أضف صنف جديد قهوة بسعر ٣٠').productDraft.price],['new_product',30]);
  assert.equal(c('بيع نقدي').kind,'cash');
  assert.equal(c('بع آجل للزبون خالد').customerQuery,'خالد');
  assert.equal(c('سجل بيع').type,'manual','never guess cash vs credit');
  assert.equal(c('بيع حليب').type,'manual','product sale without payment is not auto posted');
  assert.equal(c('أضف حليب عدد ١٠١'),null,'quantity limit');
  assert.equal(c('اطبع الفاتورة').type,'print');
  assert.equal(c('شارك الفاتورة للزبون خالد').type,'share');
  assert.equal(c('أرسل الفاتورة للزبون خالد عبر واتساب').recipient,'خالد');
  assert.equal(c('احذف دين خالد').type,'manual');
  assert.equal(c('نفذ كل شيء'),null,'unsupported open-ended instruction must have no action');

  hear(a,'أضف حليب عدد ٢');
  assert.equal(a.w.cart.length,0,'no cart mutation from recognition');
  await until(()=>a.by('rafiqVoiceGo').style.display==='','product quote');
  assert.ok(a.by('rafiqVoicePreview').textContent.includes('العدد: 2'));
  assert.ok(a.by('rafiqVoicePreview').textContent.includes('سعر الواحد'));
  assert.equal(a.queries.every(row=>row[0]==='GET'),true);
  a.by('rafiqVoiceGo').click();
  await until(()=>a.w.cart.length===1,'voice cart add');
  assert.equal(a.w.cart[0].qty,2);
  assert.equal(a.queries.every(row=>row[0]==='GET'),true,'no sale POST after adding to cart');

  hear(a,'بيع نقدي');
  assert.ok(a.by('rafiqVoicePreview').textContent.includes('الإجمالي'));
  assert.equal(a.by('cashModal').classList.contains('open'),false,'voice recognition is not payment');
  a.by('rafiqVoiceGo').click();
  assert.ok(a.by('cashModal').classList.contains('open'),'only open payment review');
  assert.equal(a.by('cashConfirm').disabled,false,'user must still tap the original confirmation button');
  assert.equal(a.queries.every(row=>row[0]==='GET'),true);
  a.w.closeModal('cashModal');

  hear(a,'بيع آجل للزبون خالد');
  assert.equal(a.by('creditModal').classList.contains('open'),false);
  a.by('rafiqVoiceGo').click();
  assert.ok(a.by('creditModal').classList.contains('open'));
  assert.equal(a.by('custSearch').value,'خالد');
  assert.equal(a.w.chosenCustomer,null,'spoken customer name is never auto-assigned');
  assert.equal(a.queries.every(row=>row[0]==='GET'),true);
  a.w.closeModal('creditModal');

  a.products.push({id:2,name:'حليب',barcode:'222',unit:'حبة',price_cents:1500,stock:4});
  hear(a,'أضف حليب');
  await until(()=>a.by('rafiqVoiceChoices').querySelectorAll('button').length===2,'product ambiguity choices');
  assert.equal(a.by('rafiqVoiceGo').style.display,'none');
  assert.equal(a.w.cart[0].qty,2);
  a.by('rafiqVoiceChoices').querySelectorAll('button')[1].click();
  assert.ok(a.by('rafiqVoicePreview').textContent.includes('1,500') || a.by('rafiqVoicePreview').textContent.includes('15'));
  a.by('rafiqVoiceClose').click();
  assert.equal(a.w.cart.length,1,'closing never adds the guessed variant');

  a.products.pop();
  hear(a,'أضف حليب');
  await until(()=>a.by('rafiqVoiceGo').style.display==='','second product preview');
  a.products[0].price_cents=2000; // تغير السعر بين القراءة والضغط.
  a.by('rafiqVoiceGo').click();
  await until(()=>a.by('rafiqVoiceStatus').textContent.includes('لم أضف'),'stale product rejected');
  assert.equal(a.w.cart[0].qty,2);
  a.by('rafiqVoiceClose').click();
  a.products[0].price_cents=1000;
  a.products[0].stock=2;
  hear(a,'أضف حليب');
  await until(()=>a.by('rafiqVoiceGo').style.display==='','insufficient stock preview');
  a.by('rafiqVoiceGo').click();
  await until(()=>a.by('rafiqVoiceStatus').textContent.includes('لم أضف'),'stock shortage rejected');
  assert.equal(a.w.cart[0].qty,2);
  a.by('rafiqVoiceClose').click();
  a.products[0].stock=10;

  hear(a,['أضف حليب','بيع نقدي']);
  assert.equal(a.by('rafiqVoiceGo').style.display,'none','different commands must require manual choice');
  a.by('rafiqVoiceClose').click();
  hear(a,['سدد دين خالد','بيع نقدي']);
  assert.equal(a.by('rafiqVoiceGo').style.display,'none','financial ambiguous hypothesis blocks safe alternative');
  a.by('rafiqVoiceClose').click();

  // آخر فاتورة محفوظة في هذه الجلسة: راجع بياناتها قبل مشاركة PDF أو طباعة أصلية.
  a.w.lastInvoice={invoice_id:55,number:55};
  a.inv.status='cancelled';
  hear(a,'شارك الفاتورة');
  assert.equal(a.by('rafiqVoiceGo').style.display,'none','cancelled invoice cannot be shared by voice');
  a.by('rafiqVoiceClose').click();
  a.inv.status='open';
  a.customer.phone='';
  hear(a,'شارك الفاتورة');
  assert.equal(a.by('rafiqVoiceGo').style.display,'none','missing customer phone blocks share');
  a.by('rafiqVoiceClose').click();
  a.customer.phone='777123456';
  hear(a,'أرسل الفاتورة للزبون سالم');
  assert.equal(a.by('rafiqVoiceGo').style.display,'none','do not share to mismatched spoken customer');
  assert.equal(a.shares.length,0);
  a.by('rafiqVoiceClose').click();
  hear(a,'شارك الفاتورة للزبون خالد');
  assert.ok(a.by('rafiqVoicePreview').textContent.includes('هاتفه 777123456'));
  assert.equal(a.shares.length,0,'recognition alone never starts sending');
  a.by('rafiqVoiceGo').click();
  assert.deepEqual(a.shares,[55],'only opens Android PDF chooser after explicit review');
  assert.equal(a.queries.every(row=>row[0]==='GET'),true);
  hear(a,'اطبع الفاتورة');
  assert.ok(a.by('rafiqVoicePreview').textContent.includes('رقم 55'));
  assert.equal(a.prints.length,0);
  a.by('rafiqVoiceGo').click();
  await until(()=>a.prints.length===1,'system print UI on reviewed invoice');
  hear(a,['أضف صنف جديد قهوة بسعر ٣٠','أضف صنف جديد قهوة بسعر ٤٠']);
  assert.equal(a.by('rafiqVoiceChoices').querySelectorAll('button').length,2,
    'two spoken prices for a new product must not be merged');
  a.by('rafiqVoiceChoices').querySelector('button').click();
  assert.ok(a.by('rafiqVoicePreview').textContent.includes('30'));
  a.by('rafiqVoiceGo').click();
  await until(()=>!!a.by('productName'),'new product draft');
  assert.equal(a.by('productName').value,'قهوة'); // يحتفظ بإملاء التفريغ الأصلي ويمكن تعديله.
  assert.equal(a.by('productPrice').value,'30');
  assert.ok(a.by('productName').closest('.product-card').textContent.includes('راجع الاسم والسعر'));
  assert.equal(a.queries.every(row=>row[0]==='GET'),true,'catalog draft is not saved automatically');
  a.windowDom.window.close();

  const invoice=await app('/invoice/55');
  assert.ok(invoice.by('shareInvoicePdf'),'manual invoice PDF share button');
  hear(invoice,'شارك الفاتورة');
  assert.equal(invoice.shares.length,0);
  invoice.by('rafiqVoiceGo').click();
  assert.deepEqual(invoice.shares,[55]);
  let sharePrompt='';
  invoice.w.confirm=text=>{ sharePrompt=text; return false; };
  invoice.by('shareInvoicePdf').click();
  assert.ok(sharePrompt.includes('خالد') && sharePrompt.includes('777123456') && sharePrompt.includes('35'),
    'manual share confirmation must show the customer, phone, and current debt');
  assert.deepEqual(invoice.shares,[55],'cancelling share confirmation does not open chooser');
  invoice.w.confirm=()=>true;
  invoice.by('shareInvoicePdf').click();
  assert.deepEqual(invoice.shares,[55,55],'invoice share button only opens chooser after confirmation');
  invoice.windowDom.window.close();

  const guard=await app('/pos');
  guard.w.cart.push({id:1,name:'حليب',qty:1,price_cents:1000,stock:10,unit:'حبة'});
  guard.w.renderCart();
  const readApi=guard.w.RafiqNative.api;
  let posts=0;
  guard.w.RafiqNative.api=(method,url,body)=>{
    if(method==='POST' && url==='/api/sale'){
      posts++;
      return JSON.stringify({status:200,body:JSON.stringify({ok:true,number:55,invoice_id:55,total:'10',change:null})});
    }
    return readApi(method,url,body);
  };
  const s1=guard.w.submitSale({payment_type:'cash',received_cents:1000});
  const s2=guard.w.submitSale({payment_type:'cash',received_cents:1000});
  await Promise.all([s1,s2]);
  assert.equal(posts,1,'double tap while a sale is pending must send one POST only');
  assert.equal(guard.w.cart.length,0);
  guard.windowDom.window.close();

  const retry=await app('/pos');
  retry.w.cart.push({id:1,name:'حليب',qty:1,price_cents:1000,stock:10,unit:'حبة'});
  retry.w.renderCart();
  let attempts=0;
  const lookup=retry.w.RafiqNative.api;
  retry.w.RafiqNative.api=(method,url,body)=>{
    if(method==='POST' && url==='/api/sale'){
      attempts++;
      return JSON.stringify({status:attempts===1?400:200,
        body:JSON.stringify(attempts===1?{ok:false,error:'فشل وهمي'}:{ok:true,number:56,invoice_id:56,total:'10'})});
    }
    return lookup(method,url,body);
  };
  await retry.w.submitSale({payment_type:'cash',received_cents:1000});
  assert.equal(retry.w.cart.length,1,'failed sale keeps draft for retry');
  assert.equal(retry.by('cashConfirm').disabled,false,'confirmation button re-enabled after failure');
  await retry.w.submitSale({payment_type:'cash',received_cents:1000});
  assert.equal(attempts,2);
  assert.equal(retry.w.cart.length,0);
  retry.windowDom.window.close();
  console.log('Voice commerce UI: draft cart, ambiguous catalog, reviewed sale, print, PDF chooser, double-tap guard PASS (fake data)');
})().catch(e=>{console.error(e);process.exitCode=1;});
