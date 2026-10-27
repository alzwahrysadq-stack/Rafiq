// Two ORIGINAL Android cash views in jsdom, with a synthetic in-memory REST server.
// No real Supabase, no Android build, no phone evidence. The mocked bridge NEVER writes Room.
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {JSDOM,ResourceLoader} from 'jsdom';
const WEB=new URL('../../app/src/main/assets/web/',import.meta.url);
const read=file=>readFileSync(new URL(file,WEB),'utf8');
const STORE='11111111-1111-4111-8111-111111111111';
const OWNER='22222222-2222-4222-8222-222222222222';
const WORKER='33333333-3333-4333-8333-333333333333';
const KEY=`sb_publishable_${'A'.repeat(30)}`;
const PROJECT_URL='https://syntheticprojectref.supabase.co';
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn,what){for(let n=0;n<80;n++){if(fn())return;await sleep(15);}throw Error('timed out: '+what);}
class Assets extends ResourceLoader{
  fetch(url){const rel=url.split('/assets/web/')[1];if(!rel||rel.includes('..'))return null;
    const p=join(WEB.pathname,rel);return existsSync(p)?Promise.resolve(readFileSync(p)):null;}
}
const server={devices:new Map(),requests:[],shifts:[],events:[],n:0,timeoutNextRequest:false};
function nextId(){return String(++server.n).padStart(8,'0')+'-aaaa-4aaa-8aaa-aaaaaaaaaaaa';}
function dataFor(role,localId){const owner=role==='owner';return {S:{currency:'ريال',store_name:'محل تجريبي'},
  u:{id:localId,name:owner?'صاحب المتجر':'أحمد',role},cloud_shift_only:true,
  shift:{id:localId,opened_at:'2026-10-16T00:00:00',opening_cents:owner?100000:1000000},
  expected:owner?355000:1000000,
  totals:{in_all:owner?255000:0,out_all:0},
  movements:[{kind:'open',amount_cents:owner?100000:1000000,reason:'بداية الوردية',created_at:'2026-10-16T00:00:00',uname:owner?'صاحب المتجر':'أحمد'}],
  last:null,K:{open:'بداية وردية'},REASON_IN:[],REASON_OUT:[],REASON_DIFF:[],DENOM:[]};}
async function phone(role,localId){
  const dom=new JSDOM('<!doctype html><html><body></body></html>',{
    url:'https://appassets.androidplatform.net/assets/web/index.html?p=/cash',
    runScripts:'dangerously',resources:new Assets(),pretendToBeVisual:true});
  const w=dom.window,d=w.document,uid=role==='owner'?OWNER:WORKER,requests=[];
  w.scrollTo=()=>{};w.Response=Response;w.AbortController=AbortController;
  w.RafiqDevice={version:()=> 'test',scan:()=>{}};
  w.RafiqNative={
    cloudShiftPublicConfig:()=>JSON.stringify({url:PROJECT_URL,key:KEY}),
    page(method,path){assert.equal(method,'GET','cash mock never commits local pages');
      if(path==='/logout')return JSON.stringify({redirect:'/login'});
      const template=path==='/cash'?'cash.html':path==='/pos'?'pos.html':'login.html';
      return JSON.stringify({status:200,path,endpoint:path.slice(1),template,ctx:dataFor(role,localId),flashes:[]});},
    api(method,path){assert.equal(method,'POST');assert.equal(path,'/api/sale');
      return JSON.stringify({status:409,body:JSON.stringify({ok:false,error:'لا بيع محلي'})});},
  };
  w.fetch=async function(url,options={}){
    assert.equal(this,w,'WebView fetch must retain its Window receiver');
    assert.ok(String(url).startsWith(PROJECT_URL+'/'),'no third-party endpoint');
    assert.equal(options.credentials,'omit');assert.equal(options.redirect,'error');
    const parsed=new globalThis.URL(url),path=parsed.pathname;
    requests.push({path,options});server.events.push({role,path,options});
    let status=200,response=null;
    const args=options.body?JSON.parse(options.body):{};
    if(path==='/auth/v1/token'){
      response={access_token:'fake-access-'+role,refresh_token:'fake-refresh-'+role,
        expires_in:3600,user:{id:uid,email:role+'@invalid.test'}};
    }else if(path==='/auth/v1/logout')response={};
    else if(path==='/rest/v1/rfq_pilot_members')response=[{store_id:STORE,role}];
    else if(path==='/rest/v1/rfq_pilot_devices'){
      const statusFilter=parsed.searchParams.get('status'),idFilter=parsed.searchParams.get('id');
      response=[...server.devices.values()].filter(x=>x.store_id===STORE &&
        (!statusFilter||x.status===statusFilter.slice(3)) && (!idFilter||x.id===idFilter.slice(3)) &&
        (role==='owner'||x.user_id===WORKER));
    }else if(path==='/rest/v1/rfq_pilot_shift_requests'){
      const statusFilter=parsed.searchParams.get('status'),workerFilter=parsed.searchParams.get('worker_id');
      response=server.requests.filter(x=>x.store_id===STORE &&
        (!statusFilter||x.status===statusFilter.slice(3)) &&
        (!workerFilter||x.worker_id===workerFilter.slice(3))).slice().reverse();
    }else if(path==='/rest/v1/rfq_pilot_shifts'){
      response=server.shifts.filter(x=>x.store_id===STORE&&x.status==='open');
    }else if(path==='/rest/v1/rpc/rfq_pilot_request_device'){
      const id=args.p_device,device=server.devices.get(id)||{store_id:STORE,id,user_id:uid,
        kind:args.p_kind,status:role==='owner'?'approved':'pending'};
      server.devices.set(id,device);response=device.status;
    }else if(path==='/rest/v1/rpc/rfq_pilot_approve_device'){
      assert.equal(role,'owner');server.devices.get(args.p_device).status='approved';
    }else if(path==='/rest/v1/rpc/rfq_pilot_claim_worker'){
      assert.equal(role,'worker');
      if(server.devices.get(args.p_device)?.status!=='approved'){
        status=400;response={message:'approved_cashier_session_required'};}
      else response='2026-10-16T02:00:00Z';
    }else if(path==='/rest/v1/rpc/rfq_pilot_my_open_shift'){
      response=server.shifts.find(x=>x.worker_id===uid&&x.cashier_device_id===args.p_device&&x.status==='open')?.id||null;
    }else if(path==='/rest/v1/rpc/rfq_pilot_request_shift'){
      assert.equal(role,'worker');
      const open=server.shifts.some(s=>s.worker_id===uid&&s.status==='open');
      if(open){status=400;response={message:'open_shift_already_exists'};}
      else{let existing=server.requests.find(x=>x.worker_id===uid&&x.status==='pending');
        if(!existing){existing={id:nextId(),store_id:STORE,worker_id:uid,
          cashier_device_id:args.p_device,status:'pending',created_at:'2026-10-16T02:00:00Z'};
          server.requests.push(existing);}response=existing.id;
        if(server.timeoutNextRequest){server.timeoutNextRequest=false;
          const error=Error('lost response');error.name='AbortError';throw error;}}
    }else if(path==='/rest/v1/rpc/rfq_pilot_reject_shift'){
      assert.equal(role,'owner');const req=server.requests.find(x=>x.id===args.p_request&&x.status==='pending');
      if(!req){status=400;response={message:'owner_and_pending_request_required'};}
      else req.status='rejected';
    }else if(path==='/rest/v1/rpc/rfq_pilot_approve_shift'){
      assert.equal(role,'owner');const req=server.requests.find(x=>x.id===args.p_request&&x.status==='pending');
      if(!req||args.p_opening_cents<0){status=400;response={message:'invalid_opening_balance'};}
      else{req.status='approved';const s={id:nextId(),store_id:STORE,worker_id:req.worker_id,
        cashier_device_id:req.cashier_device_id,opening_cents:args.p_opening_cents,status:'open'};
        server.shifts.push(s);response=s.id;}
    }else if(path==='/rest/v1/rpc/rfq_pilot_close_shift'){
      assert.equal(role,'owner');const s=server.shifts.find(x=>x.id===args.p_shift&&x.status==='open');
      if(!s||args.p_counted_cents<0){status=400;response={message:'invalid_count'};}
      else{s.status='closed';response={expected_cents:s.opening_cents,
        counted_cents:args.p_counted_cents,difference_cents:args.p_counted_cents-s.opening_cents};}
    }else throw Error('Unexpected cloud path '+path);
    return {ok:status<300,status,text:async()=>JSON.stringify(response)};
  };
  for(const file of ['vendor/nunjucks.min.js','routes.js','templates.js','engine.js'])w.eval(read(file));
  await until(()=>!!d.querySelector('#serverShiftSignIn')?.onclick,'original cash script mounted');
  assert.equal(d.querySelector('form[action*="cash/"]'),null,'no local cash form in original cash cutover');
  assert.ok(d.body.textContent.includes('أرشيف هذا الهاتف — للقراءة فقط'));
  assert.ok(d.body.textContent.includes(role==='owner'?'3,550':'10,000'));
  assert.equal(d.querySelector('#serverShiftSession').hidden,true);
  async function login(){d.querySelector('#serverShiftEmail').value=role+'@invalid.test';
    d.querySelector('#serverShiftPassword').value='test-password';d.querySelector('#serverShiftSignIn').click();
    await until(()=>!d.querySelector('#serverShiftSession')?.hidden,'signed-in original cash '+role);
    await until(()=>!!d.querySelector('#serverShiftBody')?.textContent.includes('الجهاز:'),'device state '+role);
    assert.equal(d.querySelector('#serverShiftPassword').value,'');
    assert.ok(!Object.values(w.localStorage).some(value=>String(value).includes('test-password')));}
  return {dom,w,d,requests,login,close:()=>w.close()};
}
function button(p,text){return [...p.d.querySelectorAll('#serverShiftBody button')].find(x=>x.textContent.includes(text));}
function amount(p){return p.d.querySelector('#serverShiftBody input');}
const worker=await phone('worker',2),owner=await phone('owner',1);
try{
  const w=worker.w;
  assert.equal(w.RafiqCloudShift.amountCents('١٬٠٠٠٫٥٠'),100050);
  assert.equal(w.RafiqCloudShift.amountCents('0'),0);
  for(const bad of ['', '  ', '-1','1,00','١٬٠٠','NaN','1000000000','٢٫١١١'])
    assert.throws(()=>w.RafiqCloudShift.amountCents(bad));
  await worker.login();
  assert.equal(button(worker,'اطلب فتح وردية'),undefined,'unapproved worker cannot request');
  await owner.login();
  await until(()=>!!button(owner,'اعتماد الجهاز'),'owner sees worker device in ORIGINAL screen');
  button(owner,'اعتماد الجهاز').click();
  await until(()=>server.devices.get(w.localStorage.getItem(`rafiq-test-device:v2:android:${WORKER}`))?.status==='approved',
    'owner approves worker device');
  worker.d.querySelector('#serverShiftRefresh').click();
  await until(()=>!!button(worker,'اطلب فتح وردية'),'worker device approved');
  const req=button(worker,'اطلب فتح وردية');server.timeoutNextRequest=true;req.click();req.click();
  await until(()=>server.requests.length===1,'first request persisted despite lost reply');
  await until(()=>worker.d.querySelector('#serverShiftMessage').textContent.includes('غير مؤكدة'),
    'lost reply must be disclosed');
  req.click();await sleep(10);
  assert.equal(server.events.filter(e=>e.path==='/rest/v1/rpc/rfq_pilot_request_shift').length,1,
    'uncertain write cannot be repeated before a successful refresh');
  worker.d.querySelector('#serverShiftRefresh').click();
  await until(()=>worker.d.querySelector('#serverShiftBody').textContent.includes('بانتظار المالك'),
    'server reconciles uncertain request');
  assert.equal(button(worker,'اطلب فتح وردية'),undefined,'pending request hides worker button');
  owner.d.querySelector('#serverShiftRefresh').click();
  await until(()=>!!button(owner,'رفض الطلب'),'owner sees pending shift request');
  assert.equal(server.events.filter(e=>e.path==='/rest/v1/rpc/rfq_pilot_request_shift').length,1,
    'double tap only emits one worker request');
  button(owner,'رفض الطلب').click();
  await until(()=>server.requests[0].status==='rejected','owner rejected on server');
  worker.d.querySelector('#serverShiftRefresh').click();
  await until(()=>worker.d.querySelector('#serverShiftBody').textContent.includes('رفضه المالك'),'worker sees rejection');
  assert.ok(!worker.d.querySelector('#serverShiftBody').textContent.includes('وردية معتمدة'));
  button(worker,'اطلب فتح وردية').click();
  await until(()=>server.requests.length===2,'new request after rejection');
  owner.d.querySelector('#serverShiftRefresh').click();
  await until(()=>!!button(owner,'تأكيد وفتح وردية'),'owner approval available');
  button(owner,'تأكيد وفتح وردية').click();
  await until(()=>owner.d.querySelector('#serverShiftMessage').textContent.includes('اكتب مبلغاً صحيحاً'),'empty opening rejected visibly');
  assert.equal(server.shifts.length,0,'empty opening must not become zero shift');
  amount(owner).value='١٬٠٠٠';button(owner,'تأكيد وفتح وردية').click();
  await until(()=>server.shifts.length===1,'owner approved valid opening on server');
  assert.equal(server.shifts[0].opening_cents,100000);
  worker.d.querySelector('#serverShiftRefresh').click();
  await until(()=>worker.d.querySelector('#serverShiftBody').textContent.includes('وردية معتمدة من الخادم'),
    'worker sees server decision, not the local shift');
  assert.equal(button(worker,'اطلب فتح وردية'),undefined,'cannot request again while open');
  await until(()=>!!button(owner,'تأكيد إغلاق الوردية'),'owner close available');
  button(owner,'تأكيد إغلاق الوردية').click();
  await until(()=>owner.d.querySelector('#serverShiftMessage').textContent.includes('اكتب مبلغاً صحيحاً'),
    'empty count rejected');
  assert.equal(server.shifts[0].status,'open');
  amount(owner).value='١٬٠٠٠';button(owner,'تأكيد إغلاق الوردية').click();
  await until(()=>server.shifts[0].status==='closed','owner closed on server');
  worker.d.querySelector('#serverShiftRefresh').click();
  await until(()=>!worker.d.querySelector('#serverShiftBody').textContent.includes('وردية معتمدة من الخادم'),
    'worker sees close on server');
  worker.d.querySelector('a[href="/pos"]').click();
  await until(()=>worker.d.body.textContent.includes('توقّف البيع والآجل من الشاشة المحلية'),'local POS disabled');
  assert.equal(worker.d.querySelector('.pay-action'),null,'no local sale button even with old Room shift');
  assert.equal(worker.d.querySelector('#scan'),null,'local Room products not used as cloud products');
  assert.ok(!worker.requests.some(x=>x.path==='/rest/v1/rpc/rfq_pilot_post_invoice'));
  worker.d.querySelector('a[href="/logout"]').click();
  await until(()=>worker.requests.some(x=>x.path==='/auth/v1/logout'),
    'local account switch clears and revokes the cloud session');
  assert.equal(worker.requests.filter(x=>x.path==='/auth/v1/logout').length,1);
  owner.d.querySelector('#serverShiftSignOut').click();
  await until(()=>owner.requests.some(x=>x.path==='/auth/v1/logout'),'logout revokes owner cloud session');
  await until(()=>owner.d.querySelector('#serverShiftSession').hidden,'cloud session hidden after logout');
  assert.equal(owner.requests.find(x=>x.path==='/auth/v1/logout').options.headers.Authorization,'Bearer fake-access-owner');
  console.log('PASS ORIGINAL Android cash views (synthetic owner/worker): approval, rejection, open/close, logout, duplicate guard, local POS disabled.');
}finally{owner.close();worker.close();}
