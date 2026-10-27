// Two synthetic ORIGINAL WebViews. Neither Supabase nor Android phones contacted.
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {JSDOM,ResourceLoader} from 'jsdom';
const WEB=new URL('../../app/src/main/assets/web/',import.meta.url);
const read=f=>readFileSync(new URL(f,WEB),'utf8');
const STORE='11111111-1111-4111-8111-111111111111';
const OWNER='22222222-2222-4222-8222-222222222222';
const WORKER='33333333-3333-4333-8333-333333333333';
const PROJECT_URL='https://syntheticprojectref.supabase.co';
const KEY=`sb_publishable_${'Z'.repeat(30)}`;
const sleep=ms=>new Promise(done=>setTimeout(done,ms));
async function until(fn,what){for(let i=0;i<160;i++){if(fn())return;await sleep(15);}throw Error('timed out: '+what);}
class Assets extends ResourceLoader {fetch(url){const rel=url.split('/assets/web/')[1];if(!rel||rel.includes('..'))return null;
  const p=join(WEB.pathname,rel);return existsSync(p)?Promise.resolve(readFileSync(p)):null;}}
const server={n:0,devices:new Map(),requests:[],shifts:[],products:[],customers:[],invoices:[],
  debts:[],cash:[],events:[],dropInvoiceReply:false,dropInvoiceBeforeCommit:false,badInvoiceResponse:null};
function id(){const part=(++server.n).toString(16).padStart(8,'0');return `${part}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;}
const fail=message=>({status:400,body:{code:'P0001',message}});
const debtFor=cid=>server.debts.filter(e=>e.customer_id===cid).reduce((n,e)=>n+e.amount_cents,0);
const tillFor=sid=>server.shifts.find(s=>s.id===sid).opening_cents+
  server.cash.filter(e=>e.shift_id===sid).reduce((n,e)=>n+e.amount_cents,0);
const event=(topic,reference_id,amount_cents=null)=>server.events.push({id:server.events.length+1,topic,
  reference_id,amount_cents,store_id:STORE,created_at:new Date().toISOString()});
function rpc(role,user,name,a){let status=200,body=null;
  if(name==='rfq_pilot_request_device'){
    let d=server.devices.get(a.p_device);
    if(!d){d={store_id:STORE,id:a.p_device,user_id:user,kind:a.p_kind,
      status:role==='owner'?'approved':'pending',created_at:new Date().toISOString()};
      server.devices.set(d.id,d);if(d.status==='pending')event('device_requested',d.id);}
    body=d.status;
  }else if(name==='rfq_pilot_approve_device'){
    if(role!=='owner')return fail('owner_required');server.devices.get(a.p_device).status='approved';
  }else if(name==='rfq_pilot_claim_worker'||name==='rfq_pilot_heartbeat'){
    if(role!=='worker'||server.devices.get(a.p_device)?.status!=='approved')return fail('worker_session_expired');
    body=new Date().toISOString();
  }else if(name==='rfq_pilot_my_open_shift'){
    body=server.shifts.find(s=>s.status==='open'&&s.worker_id===user&&s.cashier_device_id===a.p_device)?.id||null;
  }else if(name==='rfq_pilot_request_shift'){
    if(role!=='worker'||server.devices.get(a.p_device)?.status!=='approved')return fail('approved_cashier_session_required');
    let r=server.requests.find(x=>x.worker_id===user&&x.status==='pending');
    if(!r){r={id:id(),store_id:STORE,worker_id:user,cashier_device_id:a.p_device,
      status:'pending',created_at:new Date().toISOString()};server.requests.push(r);event('shift_requested',r.id);}
    body=r.id;
  }else if(name==='rfq_pilot_approve_shift'){
    if(role!=='owner')return fail('owner_required');const r=server.requests.find(x=>x.id===a.p_request&&x.status==='pending');
    if(!r)return fail('owner_and_pending_request_required');r.status='approved';
    const s={id:id(),store_id:STORE,worker_id:r.worker_id,cashier_device_id:r.cashier_device_id,
      status:'open',opening_cents:a.p_opening_cents,opened_at:new Date().toISOString()};
    server.shifts.push(s);event('shift_approved',r.id);body=s.id;
  }else if(name==='rfq_pilot_shift_cash_snapshot'){
    const s=server.shifts.find(x=>x.id===a.p_shift);
    if(!s||role==='worker'&&(s.worker_id!==user||s.cashier_device_id!==a.p_device))return fail('authorized_shift_required');
    const entries=server.cash.filter(e=>e.shift_id===s.id).slice().reverse();
    const sum=kind=>entries.filter(e=>e.kind===kind).reduce((n,e)=>n+e.amount_cents,0);
    body={shift_id:s.id,status:s.status,opening_cents:s.opening_cents,sale_cents:sum('sale'),
      collection_cents:sum('collection'),cash_advance_cents:sum('cash_advance'),
      other_net_cents:sum('expense')+sum('income')+sum('withdraw'),
      expected_cents:tillFor(s.id),entries,shown_limit:60};
  }else if(name==='rfq_pilot_customer_overview'){
    if(role==='worker'&&!server.shifts.some(s=>s.worker_id===user&&s.status==='open'))return fail('authorized_session_required');
    body={outstanding_cents:server.debts.reduce((n,e)=>n+e.amount_cents,0),
      customer_count:server.customers.length,
      customers:server.customers.map(c=>({...c,balance_cents:debtFor(c.id)})),shown_limit:300};
  }else if(name==='rfq_pilot_customer_statement'){
    const c=server.customers.find(c=>c.id===a.p_customer);if(!c)return fail('customer_not_found');
    const entries=server.debts.filter(e=>e.customer_id===c.id).slice().reverse();
    body={customer_id:c.id,customer_name:c.name,balance_cents:debtFor(c.id),entries,
      entry_count:entries.length,shown_limit:150};
  }else if(name==='rfq_pilot_owner_summary'){
    if(role!=='owner')return fail('owner_required');
    body={sales_cents:server.invoices.reduce((n,i)=>n+i.total_cents,0),
      cash_received_on_sales_cents:server.invoices.reduce((n,i)=>n+i.cash_paid_cents,0),
      goods_credit_cents:server.invoices.reduce((n,i)=>n+i.due_cents,0),
      outstanding_debt_cents:server.debts.reduce((n,e)=>n+e.amount_cents,0),
      cash_advances_cents:server.debts.filter(e=>e.kind==='cash_advance').reduce((n,e)=>n+e.amount_cents,0),
      gross_margin_estimate_cents:server.invoices.reduce((n,i)=>n+i.total_cents,0)};
  }else if(name==='rfq_pilot_create_product_once'){
    if(role!=='owner')return fail('owner_required');let p=server.products.find(p=>p.id===a.p_id);
    if(!p){p={id:a.p_id,store_id:STORE,name:a.p_name,barcode:a.p_barcode,unit:a.p_unit,
      price_cents:a.p_price_cents,cost_cents:a.p_cost_cents,stock_milli:0,active:true};server.products.push(p);}
    body=p.id;
  }else if(name==='rfq_pilot_adjust_stock'){
    if(role!=='owner')return fail('owner_required');const p=server.products.find(p=>p.id===a.p_product);
    if(!p)return fail('product_not_found');if(!p.events)p.events=new Set();
    if(!p.events.has(a.p_event)){p.events.add(a.p_event);p.stock_milli+=a.p_delta_milli;}body=p.stock_milli;
  }else if(name==='rfq_pilot_create_customer'){
    if(!server.customers.some(c=>c.id===a.p_id))server.customers.push({id:a.p_id,store_id:STORE,
      name:a.p_name,phone:a.p_phone,active:true});body=a.p_id;
  }else if(name==='rfq_pilot_post_invoice_checked'){
    if(role!=='worker'||!server.shifts.some(s=>s.id===a.p_shift&&s.status==='open'))return fail('approved_open_shift_required');
    const old=server.invoices.find(i=>i.id===a.p_invoice);
    if(old){if(JSON.stringify(old.request_args)!==JSON.stringify(a))return fail('idempotency_event_conflict');
      body={invoice_id:old.id,number:old.number,total_cents:old.total_cents,
        due_cents:old.due_cents,already_committed:true};}
    else{let total=0;for(const line of a.p_lines){const p=server.products.find(p=>p.id===line.product_id);
        if(!p||p.stock_milli<line.qty_milli)return fail('insufficient_stock');
        if(!Number.isSafeInteger(line.quoted_price_cents))return fail('invalid_invoice_quote');
        if(p.price_cents!==line.quoted_price_cents)return fail('price_changed_refresh_cart');
        total+=Math.round(p.price_cents*line.qty_milli/1000);}
      if(total!==a.p_quoted_total_cents)return fail('invalid_invoice_quote');
      const due=total-a.p_cash_cents;if(due<0||due>0&&!a.p_customer)return fail('invalid_payment');
      const invoice={id:a.p_invoice,number:server.invoices.length+1,store_id:STORE,
        shift_id:a.p_shift,worker_id:user,total_cents:total,cash_paid_cents:a.p_cash_cents,
        due_cents:due,customer_id:a.p_customer,created_at:new Date().toISOString(),request_args:a};
      server.invoices.push(invoice);for(const line of a.p_lines)
        server.products.find(p=>p.id===line.product_id).stock_milli-=line.qty_milli;
      if(due)server.debts.push({id:id(),customer_id:a.p_customer,kind:'invoice_due',
        amount_cents:due,invoice_id:invoice.id,note:'',created_at:new Date().toISOString()});
      if(a.p_cash_cents)server.cash.push({id:id(),shift_id:a.p_shift,kind:'sale',
        amount_cents:a.p_cash_cents,reason:'',created_at:new Date().toISOString()});
      event('sale',invoice.id,total);
      body={invoice_id:invoice.id,number:invoice.number,total_cents:total,due_cents:due,already_committed:false};}
  }else if(name==='rfq_pilot_cash_advance'){
    if(role!=='owner')return fail('owner_required_for_cash_advance');
    const s=server.shifts.find(x=>x.id===a.p_shift),old=server.debts.some(d=>d.id===a.p_event);
    if(!s)return fail('owner_required_for_cash_advance');
    if(!old){if(s.status!=='open'||tillFor(s.id)<a.p_amount_cents)return fail('insufficient_till_cash');
      server.debts.push({id:a.p_event,customer_id:a.p_customer,kind:'cash_advance',
        amount_cents:a.p_amount_cents,note:a.p_reason,created_at:new Date().toISOString()});
      const c={id:id(),shift_id:s.id,kind:'cash_advance',amount_cents:-a.p_amount_cents,
        reason:a.p_reason,created_at:new Date().toISOString()};server.cash.push(c);
      event('cash_advance',c.id,-a.p_amount_cents);}
    body={event_id:a.p_event,customer_balance_cents:debtFor(a.p_customer),
      till_cents:tillFor(s.id),already_committed:old};
  }else if(name==='rfq_pilot_collect_debt'){
    if(role!=='worker')return fail('approved_open_shift_required');
    if(!server.debts.some(d=>d.id===a.p_event)){
      if(debtFor(a.p_customer)<a.p_amount_cents)return fail('collection_exceeds_debt');
      server.debts.push({id:a.p_event,customer_id:a.p_customer,kind:'collection',
        amount_cents:-a.p_amount_cents,note:'',created_at:new Date().toISOString()});
      const c={id:id(),shift_id:a.p_shift,kind:'collection',amount_cents:a.p_amount_cents,
        reason:'',created_at:new Date().toISOString()};server.cash.push(c);event('collection',c.id,a.p_amount_cents);}
    body=debtFor(a.p_customer);
  }else if(name==='rfq_pilot_owner_add_debt'){
    if(role!=='owner')return fail('owner_required');
    if(!server.debts.some(d=>d.id===a.p_event)){
      server.debts.push({id:a.p_event,customer_id:a.p_customer,kind:'owner_debit',
        amount_cents:a.p_amount_cents,note:a.p_reason,created_at:new Date().toISOString()});
      event('owner_debt',a.p_event,a.p_amount_cents);}body=debtFor(a.p_customer);
  }else if(name==='rfq_pilot_owner_cash_adjust'){
    if(role!=='owner')return fail('owner_required');const s=server.shifts.find(s=>s.id===a.p_shift);
    if(!s||s.status!=='open')return fail('active_owner_open_shift_required');
    const signed=a.p_kind==='income'?a.p_amount_cents:-a.p_amount_cents;
    if(signed<0&&tillFor(s.id)+signed<0)return fail('insufficient_till_cash');
    if(!server.cash.some(e=>e.id===a.p_event)){
      server.cash.push({id:a.p_event,shift_id:s.id,kind:a.p_kind,amount_cents:signed,
        reason:a.p_reason,created_at:new Date().toISOString()});
      event('cash_'+a.p_kind,a.p_event,signed);}body=tillFor(s.id);
  }else throw Error('Unknown fake RPC '+name);
  return {status,body};}
async function phone(role,localUid){
  const dom=new JSDOM('<!doctype html><html><body></body></html>',{
    url:'https://appassets.androidplatform.net/assets/web/index.html?p=/cash',
    runScripts:'dangerously',resources:new Assets(),pretendToBeVisual:true});
  const w=dom.window,d=w.document,user=role==='owner'?OWNER:WORKER,requests=[],localPages=[],tones=[];
  w.AudioContext=class {constructor(){this.currentTime=0;this.destination={};}
    async resume(){}async close(){}
    createOscillator(){return {frequency:{value:0},connect(){},start(){tones.push('foreground');},stop(){}};}
    createGain(){return {gain:{value:0},connect(){}};}};
  w.scrollTo=()=>{};w.confirm=()=>true;w.Response=Response;w.AbortController=AbortController;
  w.RafiqDevice={version:()=> 'fake-build',scan:()=>{},listen:()=>{}};
  w.RafiqNative={cloudShiftPublicConfig:()=>JSON.stringify({url:PROJECT_URL,key:KEY}),
    page(method,path){localPages.push({method,path});if(path==='/logout')return JSON.stringify({redirect:'/login'});
      if(path==='/login')return JSON.stringify({status:200,path,template:'login.html',endpoint:'login',
        ctx:{S:{currency:'ريال'},u:null},flashes:[]});
      const map={'/cash':'cash.html','/pos':'cloud_pos.html','/customers':'cloud_customers.html',
        '/':'cloud_dashboard.html','/remote-eye':'cloud_remote_eye.html'};
      assert.ok(map[path],`unexpected original route ${path}`);
      return JSON.stringify({status:200,path,endpoint:path.slice(1),template:map[path],
        ctx:{cloud_shift_only:true,S:{currency:'ريال',store_name:'متجر وهمي'},
          u:{id:localUid,name:role,role},shift:null,last:null,movements:[],totals:{},K:{}},flashes:[]});},
    api(){throw Error('cloud financial UI must never call local Room API');}};
  w.fetch=async function(url,opts={}){
    assert.equal(this,w,'window.fetch receiver');assert.ok(String(url).startsWith(PROJECT_URL+'/'));
    assert.equal(opts.credentials,'omit');assert.equal(opts.redirect,'error');
    const parsed=new globalThis.URL(url),path=parsed.pathname,a=opts.body?JSON.parse(opts.body):{};
    requests.push({role,path,args:a});let status=200,body=null;
    if(path==='/auth/v1/token')body={access_token:'fake-'+role,refresh_token:'fake-refresh-'+role,
      expires_in:3600,user:{id:user,email:role+'@invalid.test'}};
    else if(path==='/auth/v1/logout')body={};
    else if(path==='/rest/v1/rfq_pilot_members')body=[{store_id:STORE,role}];
    else if(path==='/rest/v1/rfq_pilot_devices'){
      const filter=parsed.searchParams.get('status'),one=parsed.searchParams.get('id');
      body=[...server.devices.values()].filter(x=>x.store_id===STORE&&
        (!filter||x.status===filter.slice(3))&&(!one||x.id===one.slice(3))&&
        (role==='owner'||x.user_id===user));
    }else if(path==='/rest/v1/rfq_pilot_shift_requests'){
      const filter=parsed.searchParams.get('status'),who=parsed.searchParams.get('worker_id');
      body=server.requests.filter(x=>(!filter||x.status===filter.slice(3))&&
        (!who||x.worker_id===who.slice(3))).slice().reverse();
    }else if(path==='/rest/v1/rfq_pilot_shifts')body=server.shifts.filter(s=>s.status==='open');
    else if(path==='/rest/v1/rfq_pilot_invoices')body=server.invoices.slice().reverse();
    else if(path==='/rest/v1/rfq_pilot_products')body=server.products;
    else if(path==='/rest/v1/rfq_pilot_customers')body=server.customers;
    else if(path==='/rest/v1/rfq_pilot_owner_events'){
      assert.equal(role,'owner');body=server.events.slice().reverse();
    }else if(path.startsWith('/rest/v1/rpc/')){
      if(path.endsWith('/rfq_pilot_post_invoice_checked')&&server.dropInvoiceBeforeCommit){
        server.dropInvoiceBeforeCommit=false;const err=Error('lost BEFORE commit');err.name='AbortError';throw err;}
      const result=rpc(role,user,path.split('/').at(-1),a);status=result.status;body=result.body;
      if(path.endsWith('/rfq_pilot_post_invoice_checked')&&status===200&&server.badInvoiceResponse){
        const bad=server.badInvoiceResponse;server.badInvoiceResponse=null;
        return {ok:true,status:200,text:async()=>bad==='invalid_json'?'{not json':
          JSON.stringify({...body,invoice_id:'55555555-5555-4555-8555-555555555555'})};}
      if(path.endsWith('/rfq_pilot_post_invoice_checked')&&status===200&&server.dropInvoiceReply){
        server.dropInvoiceReply=false;await sleep(40);
        const err=Error('lost reply AFTER commit');err.name='AbortError';throw err;}
    }else throw Error('Unknown fake endpoint '+path);
    return {ok:status<300,status,text:async()=>JSON.stringify(body)};};
  for(const file of ['vendor/nunjucks.min.js','routes.js','templates.js','engine.js'])w.eval(read(file));
  await until(()=>!!d.querySelector('#serverShiftSignIn')?.onclick,`cash loaded ${role}`);
  const login=async()=>{d.querySelector('#serverShiftEmail').value=role+'@invalid.test';
    d.querySelector('#serverShiftPassword').value='fake-only';d.querySelector('#serverShiftSignIn').click();
    await until(()=>!d.querySelector('#serverShiftSession')?.hidden,`Auth ${role}`);
    await until(()=>d.querySelector('#serverShiftBody')?.textContent.includes('الجهاز:'),`device ${role}`);};
  const navigate=async path=>{const a=d.createElement('a');a.href=path;d.body.append(a);a.click();a.remove();
    const key={'/':'cloudDashboard','/pos':'cloudPos','/customers':'cloudCustomers',
      '/cash':'serverShift','/remote-eye':'cloudEye'}[path];
    await until(()=>!!d.getElementById(key)?.isConnected,`route ${path} for ${role}`);};
  const input=(name,value)=>{const e=d.getElementById(name);assert.ok(e,name);e.value=value;
    e.dispatchEvent(new w.Event('input',{bubbles:true}));e.dispatchEvent(new w.Event('change',{bubbles:true}));};
  const submit=id=>{const form=d.getElementById(id);assert.ok(form,id);
    form.dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));};
  return {dom,w,d,requests,localPages,tones,login,navigate,input,submit,close:()=>w.close()};}
const owner=await phone('owner',1),worker=await phone('worker',2);
try{
  await owner.login();await worker.login();
  owner.d.getElementById('serverShiftRefresh').click();
  const ownerBtn=text=>[...owner.d.querySelectorAll('#serverShiftBody button')].find(b=>b.textContent.includes(text));
  const workerBtn=text=>[...worker.d.querySelectorAll('#serverShiftBody button')].find(b=>b.textContent.includes(text));
  await until(()=>!!ownerBtn('اعتماد الجهاز'),'owner sees worker device');ownerBtn('اعتماد الجهاز').click();
  await until(()=>server.devices.get(worker.w.localStorage.getItem(`rafiq-test-device:v2:android:${WORKER}`))?.status==='approved',
    'owner approved worker device');worker.d.getElementById('serverShiftRefresh').click();
  await until(()=>owner.d.getElementById('cloudOwnerSound')?.disabled===false&&
    owner.requests.some(x=>x.path==='/rest/v1/rfq_pilot_owner_events'),'owner cash has event baseline');
  await sleep(30);owner.d.getElementById('cloudOwnerSound').click();
  await until(()=>owner.d.getElementById('cloudOwnerSound').textContent.includes('إيقاف'),'foreground sound opted in');
  await until(()=>!!workerBtn('اطلب فتح وردية'),'worker ready to request');workerBtn('اطلب فتح وردية').click();
  await until(()=>server.requests.length===1,'worker requests shift');
  owner.d.getElementById('serverShiftRefresh').click();
  await until(()=>owner.tones.length>=1&&owner.d.getElementById('cloudOwnerEventNotice')?.textContent.includes('طلب وردية'),
    'cash screen rings and badges a NEW request only');
  await until(()=>!!ownerBtn('تأكيد وفتح وردية'),'owner approves shift');
  owner.d.querySelector('#serverShiftBody input').value='100';ownerBtn('تأكيد وفتح وردية').click();
  await until(()=>server.shifts.length===1,'one server shift');
  worker.d.getElementById('serverShiftRefresh').click();
  await until(()=>worker.w.RafiqCloudShift.session()?.shift===server.shifts[0].id,'worker shift from server');
  await owner.navigate('/');
  await until(()=>owner.d.getElementById('cloudProductSubmit')?.disabled===false&&
    typeof owner.d.getElementById('cloudProductForm')?.onsubmit==='function','owner dashboard ready');
  await sleep(120);await until(()=>owner.d.getElementById('cloudProductSubmit').disabled===false,'dashboard settled after shift');
  owner.input('cloudProductName','حليب وهمي');owner.input('cloudProductBarcode','0000123');
  owner.input('cloudProductPrice','12');owner.input('cloudProductCost','8');
  const oldPages=owner.localPages.length;owner.submit('cloudProductForm');
  await until(()=>server.products.length===1,'server product created');
  assert.equal(owner.localPages.length,oldPages,'engine does not POST cloud form to Room');
  await until(()=>owner.d.getElementById('cloudStockSubmit')?.disabled===false,'stock ready');
  owner.input('cloudStockProduct',server.products[0].id);owner.input('cloudStockQty','5');
  owner.input('cloudStockReason','مخزون اختبار');owner.submit('cloudStockForm');
  await until(()=>server.products[0].stock_milli===5000,'stock audited');
  await worker.navigate('/customers');
  await until(()=>worker.d.getElementById('cloudCustomerSubmit')?.disabled===false,'customers ready');
  worker.input('cloudCustomerName','سالم اختبار');worker.input('cloudCustomerPhone','');worker.submit('cloudCustomerForm');
  await until(()=>server.customers.length===1,'new customer');
  await worker.navigate('/pos');
  await until(()=>worker.d.getElementById('cloudSaleProduct')?.options.length===2,'server product visible to worker');
  worker.input('cloudSaleProduct',server.products[0].id);worker.input('cloudSaleQty','2');
  if(worker.d.getElementById('cloudPending')){
    await until(()=>worker.d.querySelector('#cloudPending button')?.disabled===false,'first customer intent finished');
    worker.d.querySelector('#cloudPending button').click();
    await until(()=>!worker.d.getElementById('cloudPending'),'same customer UUID confirmed after navigation');
    assert.equal(server.customers.length,1,'customer not duplicated');}
  await until(()=>worker.d.getElementById('cloudSaleAdd')?.disabled===false,'sale ready');
  const voice=worker.w.rafiqVoicePos;assert.equal(voice.cloud,true);
  assert.equal(voice.findProducts('حليب وهمي')[0]?.id,server.products[0].id);
  assert.equal(voice.addProduct(voice.findProducts('حليب وهمي')[0],1),true);
  assert.equal(voice.quote().totalCents,1200);assert.equal(server.invoices.length,0);
  worker.d.querySelector('#cloudSaleCart button').click();
  await until(()=>worker.d.getElementById('cloudSaleCart')?.textContent.includes('السلة فارغة'),'voice draft removed');
  worker.d.getElementById('cloudSaleAdd').click();
  await until(()=>worker.d.getElementById('cloudSaleCart')?.textContent.includes('حليب وهمي'),'sale draft');
  worker.input('cloudSalePaid','4');worker.input('cloudSaleCustomer',server.customers[0].id);
  // A price edit AFTER the cashier's draft is a definite server refusal, not a
  // sale at the new price. It may release ONLY this first, never-ambiguous UUID.
  server.products[0].price_cents=1300;worker.submit('cloudSaleForm');
  await until(()=>worker.d.getElementById('cloudLedgerMessage')?.textContent.includes('رفض الخادم الطلب دون قيد')&&
    worker.d.getElementById('cloudSaleReload')?.disabled===false,'confirmed quote refusal unblocks without invoice');
  const refusedId=worker.requests.filter(x=>x.path.endsWith('/rfq_pilot_post_invoice_checked')).at(-1).args.p_invoice;
  assert.equal(server.invoices.length,0);assert.equal(server.products[0].stock_milli,5000);
  assert.equal(worker.d.getElementById('cloudPending'),null,'first structured rollback releases its own intent');
  worker.d.getElementById('cloudSaleReload').click();
  await until(()=>worker.d.getElementById('cloudSaleCart')?.textContent.includes('السلة فارغة')&&
    worker.d.getElementById('cloudLedgerMessage')?.textContent.includes('تغيّر سعر/رصيد'),
    'changed price removes old draft with warning');
  await until(()=>worker.d.getElementById('cloudSaleAdd')?.disabled===false,'new price loaded');
  worker.input('cloudSaleProduct',server.products[0].id);worker.input('cloudSaleQty','2');
  worker.d.getElementById('cloudSaleAdd').click();
  await until(()=>worker.d.getElementById('cloudSaleCart')?.textContent.includes('حليب وهمي'),'new quote draft');
  assert.equal(worker.w.rafiqVoicePos.quote().totalCents,2600);
  worker.input('cloudSalePaid','4');worker.input('cloudSaleCustomer',server.customers[0].id);
  server.dropInvoiceReply=true;worker.submit('cloudSaleForm');
  await until(()=>server.invoices.length===1,'invoice committed despite dropped response');
  await until(()=>!!worker.d.getElementById('cloudPending'),'UUID saved on handset');
  assert.equal(worker.d.querySelector('#cloudPending button').disabled,true,'retry disabled during first network attempt');
  assert.equal(server.invoices[0].due_cents,2200);assert.equal(server.products[0].stock_milli,3000);
  assert.equal(worker.d.getElementById('cloudSaleSubmit').disabled,true,'no new invoice while uncertain');
  await until(()=>worker.d.querySelector('#cloudPending button')?.disabled===false&&
    worker.d.getElementById('cloudLedgerMessage')?.textContent.includes('نتيجة الاتصال غير مؤكدة'),
    'network completed before retry enabled');
  worker.d.querySelector('#cloudPending button').click();
  await until(()=>!worker.d.getElementById('cloudPending')&&
    worker.d.getElementById('cloudSaleReceipt')?.textContent.includes('الفاتورة #1'),'same UUID acknowledged');
  assert.equal(server.invoices.length,1);assert.equal(server.products[0].stock_milli,3000);
  assert.equal(worker.requests.filter(x=>x.path.endsWith('/rfq_pilot_post_invoice_checked')).length,3);
  assert.notEqual(server.invoices[0].id,refusedId,'new UUID only after explicit server rollback');
  assert.equal(debtFor(server.customers[0].id),2200);
  await owner.navigate('/customers');
  await until(()=>owner.d.getElementById('cloudAdvanceSubmit')?.disabled===false,'owner customers ready');
  owner.input('cloudSelectedCustomer',server.customers[0].id);
  await until(()=>owner.d.getElementById('cloudCustomerBalance')?.textContent.includes('سالم اختبار')&&
    owner.d.getElementById('cloudAdvanceSubmit')?.disabled===false,'owner statement loaded before advance');
  owner.input('cloudAdvanceShift',server.shifts[0].id);owner.input('cloudAdvanceAmount','3');
  owner.input('cloudAdvanceReason','سلفة اختبار');owner.submit('cloudAdvanceForm');
  await until(()=>server.debts.some(e=>e.kind==='cash_advance'),'owner cash advance');
  assert.equal(debtFor(server.customers[0].id),2500);assert.equal(tillFor(server.shifts[0].id),10100);
  assert.equal(server.products[0].stock_milli,3000);assert.equal(server.invoices.length,1);
  await worker.navigate('/customers');
  await until(()=>worker.d.getElementById('cloudCollectionSubmit')?.disabled===false,'worker collection ready');
  worker.input('cloudSelectedCustomer',server.customers[0].id);
  await until(()=>worker.d.getElementById('cloudCustomerEntries')?.textContent.includes('سلفة نقدية'),
    'worker sees separate advance in common statement');
  await until(()=>worker.d.getElementById('cloudCollectionSubmit').disabled===false,'statement query completed');
  worker.input('cloudCollectionAmount','5');worker.submit('cloudCollectionForm');
  await until(()=>debtFor(server.customers[0].id)===2000,'collection reduced debt');
  await until(()=>!worker.d.getElementById('cloudPending')&&
    worker.d.getElementById('cloudCollectionSubmit')?.disabled===false,'collection ACK clears its UUID');
  assert.equal(tillFor(server.shifts[0].id),10600);
  await worker.navigate('/cash');
  await until(()=>worker.d.getElementById('cloudCashSummary')?.textContent.includes('١٠٦'),
    'worker sees shared cash 106 YER');
  await owner.navigate('/');
  await until(()=>owner.d.getElementById('cloudDashboardStats')?.textContent.includes('٢٠'),
    'owner sees shared debt 20 YER');
  await owner.navigate('/remote-eye');
  await until(()=>owner.d.getElementById('cloudEyeEvents')?.textContent.includes('سلفة نقدية'),'owner eye audit');
  assert.ok(server.events.some(e=>e.topic==='shift_requested'));
  assert.ok(server.events.some(e=>e.topic==='sale'));
  assert.ok(server.events.some(e=>e.topic==='cash_advance'));
  assert.ok(owner.tones.length>=2,'new financial events produce a foreground-only fake tone');
  assert.equal(owner.d.getElementById('cloudEyeSound').textContent.includes('إيقاف'),true,
    'sound remains opt-in when navigating cash/dashboard/eye');
  assert.equal(worker.requests.some(x=>x.path.includes('/api/sale')),false);
  assert.ok(!Object.values(worker.w.localStorage).some(v=>String(v).includes('fake-only')),
    'no Auth password in localStorage');
  // A 200 with malformed JSON or an alien invoice ID is NOT an ACK. The sale
  // is on the server, but the handset must keep its UUID until a valid retry.
  await worker.navigate('/pos');
  await until(()=>worker.d.getElementById('cloudSaleAdd')?.disabled===false,'worker receipt test ready');
  worker.input('cloudSaleProduct',server.products[0].id);worker.input('cloudSaleQty','1');
  worker.d.getElementById('cloudSaleAdd').click();
  await until(()=>worker.d.getElementById('cloudSaleCart')?.textContent.includes('حليب وهمي'),'receipt draft');
  worker.input('cloudSalePaid','13');server.badInvoiceResponse='invalid_json';worker.submit('cloudSaleForm');
  await until(()=>server.invoices.length===2&&worker.d.querySelector('#cloudPending button')?.disabled===false&&
    worker.d.getElementById('cloudLedgerMessage')?.textContent.includes('رد الخادم غير مكتمل'),
    'bad 200 still retains same UUID after commit');
  const receiptId=server.invoices[1].id;
  server.badInvoiceResponse='wrong_id';worker.d.querySelector('#cloudPending button').click();
  await until(()=>worker.d.getElementById('cloudLedgerMessage')?.textContent.includes('رد الخادم غير مكتمل')&&
    worker.d.querySelector('#cloudPending button')?.disabled===false,
    'wrong ACK invoice ID also retains pending intent');
  assert.equal(server.invoices.length,2);assert.ok(worker.d.getElementById('cloudPending'));
  worker.d.querySelector('#cloudPending button').click();
  await until(()=>!worker.d.getElementById('cloudPending')&&
    worker.d.getElementById('cloudSaleReceipt')?.textContent.includes('الفاتورة #2'),'valid same-UUID ACK');
  assert.equal(server.invoices[1].id,receiptId);assert.equal(server.products[0].stock_milli,2000);
  // A P0001 on a RETRY after a lost network reply is not proof that the
  // original attempt did not commit. Keep the same UUID; never mint a new sale.
  await worker.navigate('/pos');
  await until(()=>worker.d.getElementById('cloudSaleAdd')?.disabled===false,'worker second draft ready');
  worker.input('cloudSaleProduct',server.products[0].id);worker.input('cloudSaleQty','1');
  worker.d.getElementById('cloudSaleAdd').click();
  await until(()=>worker.d.getElementById('cloudSaleCart')?.textContent.includes('حليب وهمي'),'second draft');
  worker.input('cloudSalePaid','13');server.dropInvoiceBeforeCommit=true;worker.submit('cloudSaleForm');
  await until(()=>worker.d.querySelector('#cloudPending button')?.disabled===false&&
    worker.d.getElementById('cloudLedgerMessage')?.textContent.includes('نتيجة الاتصال غير مؤكدة'),
    'network ambiguity retains second UUID');
  const ambiguous=worker.requests.filter(x=>x.path.endsWith('/rfq_pilot_post_invoice_checked')).at(-1).args.p_invoice;
  server.products[0].price_cents=1400;
  worker.d.querySelector('#cloudPending button').click();
  await until(()=>worker.d.getElementById('cloudLedgerMessage')?.textContent.includes('price_changed_refresh_cart')&&
    worker.d.querySelector('#cloudPending button')?.disabled===false,
    'later business refusal cannot clear previously ambiguous UUID');
  assert.equal(server.invoices.length,2);assert.ok(worker.d.getElementById('cloudPending'));
  assert.equal(worker.requests.filter(x=>x.path.endsWith('/rfq_pilot_post_invoice_checked')).at(-1).args.p_invoice,ambiguous);
  const count=worker.requests.length;worker.submit('cloudSaleForm');await sleep(35);
  assert.equal(worker.requests.length,count,'unresolved UUID forbids a fresh financial request');
  await owner.navigate('/cash');
  await until(()=>owner.d.getElementById('cloudOwnerSound')?.disabled===false&&
    !owner.d.getElementById('serverShift')?.classList.contains('rfq-pending'),
    'owner shift refresh finished before tapping sign out');
  owner.d.getElementById('serverShiftSignOut').click();
  await until(()=>!owner.w.RafiqCloudShift.session(),'owner signs out of cloud account');
  await until(()=>owner.d.getElementById('cloudOwnerNotification')?.hidden===true,'sound hidden after logout');
  console.log('PASS two synthetic ORIGINAL WebViews: shift, price rollback, bad-200 ACK guard, lost-reply UUID retry, credit, advance, collection and owner events; no phones.');
}finally{owner.close();worker.close();}
