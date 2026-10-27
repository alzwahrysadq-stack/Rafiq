// Actual migration + actual UI helper. Synthetic database, no network or live writes.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {PGlite} from '@electric-sql/pglite';
const read=p=>readFileSync(new URL(p,import.meta.url),'utf8');
const js=read('../../web-client/web.js');
assert.equal(js,read('../../app/src/main/assets/pilot/web.js'));
const helper=js.slice(js.indexOf('const CATALOG_PUBLIC_COLUMNS='),js.indexOf('async function refresh(){'));
assert.ok(helper.includes('async function readVisibleCatalog()'));
const publicSelect=helper.match(/CATALOG_PUBLIC_COLUMNS='([^']+)'/)[1];
assert.ok(publicSelect.split(',').includes('category'));
assert.ok(!publicSelect.split(',').includes('cost_cents'));
assert.ok(js.includes("select:tbl==='products'?CATALOG_PUBLIC_COLUMNS:'*'"));
async function ui(role,deny=false,change=false){
  const calls=[];
  const state={role,store:'store-a',user:{id:'user-a'},api:{
    table:async(name,q)=>{calls.push({type:'table',name,q});return [{id:'p1',name:'Tea',category:'Food',price_cents:500}];},
    rpc:async(name,args)=>{calls.push({type:'rpc',name,args});if(deny)throw Error('owner_required');if(change)state.role='worker';return [{id:'p1',cost_cents:300}];}
  }};
  const c=vm.createContext({state});vm.runInContext(helper,c);
  const result=vm.runInContext('readVisibleCatalog()',c);
  if(deny||change)await assert.rejects(result,deny?/owner_required/:/تغيّر الحساب/);
  else{
    const rows=await result;
    assert.equal(rows[0].category,'Food');
    assert.equal(rows[0].cost_cents,role==='owner'?300:undefined);
  }
  assert.ok(!calls[0].q.select.split(',').includes('cost_cents'));
  assert.equal(calls.filter(c=>c.type==='rpc').length,role==='owner'?1:0);
}
await ui('worker');await ui('owner');await ui('owner',true);await ui('owner',false,true);

const db=new PGlite();
const id={store:'11111111-1111-4111-8111-111111111111',other:'11111111-1111-4111-8111-111111111112',owner:'22222222-2222-4222-8222-222222222222',worker:'33333333-3333-4333-8333-333333333333',os:'44444444-4444-4444-8444-444444444444',ws:'55555555-5555-4555-8555-555555555555',device:'66666666-6666-4666-8666-666666666666',p:'77777777-7777-4777-8777-777777777777',otherP:'77777777-7777-4777-8777-777777777778'};
async function as(role,user,session,sql,params=[],denied){
  await db.exec('begin');
  try{
    await db.exec(`set local role ${role}`);
    await db.query("select set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true)",[user,JSON.stringify({sub:user,role,session_id:session})]);
    const r=await db.query(sql,params);
    if(denied)throw Error('UNEXPECTED_SUCCESS');
    await db.exec('rollback');return r.rows;
  }catch(e){await db.exec('rollback');if(!denied||e.message==='UNEXPECTED_SUCCESS')throw e;assert.match(e.message,denied);}
}
try{
  await db.exec(`create role authenticated nologin;create role anon nologin;
    create schema auth;
    create table auth.users(id uuid primary key);
    create table auth.sessions(id uuid primary key,user_id uuid not null references auth.users(id));
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
    grant usage on schema auth to authenticated;grant execute on function auth.uid(),auth.jwt() to authenticated;`);
  for(const f of ['20261015000100_pilot_control_plane.sql','20261015000200_pilot_financial_ledger.sql'])await db.exec(read('../../supabase/migrations/'+f));
  await db.exec("alter table public.rfq_pilot_products add column category text not null default '', add column expiry_date date;grant select(expiry_date) on public.rfq_pilot_products to authenticated;");
  await db.exec(read('../../supabase/migrations/20261022000100_product_read_owner_cost.sql'));
  await db.query('insert into auth.users values($1),($2)',[id.owner,id.worker]);
  await db.query('insert into auth.sessions values($1,$2),($3,$4)',[id.os,id.owner,id.ws,id.worker]);
  await db.query("insert into public.rfq_pilot_stores(id,name,enabled,seat_limit,license_until) values($1,'A',true,4,now()+interval '30 days'),($2,'B',true,4,now()+interval '30 days')",[id.store,id.other]);
  await db.query("insert into public.rfq_pilot_members(store_id,user_id,role) values($1,$2,'owner'),($1,$3,'worker')",[id.store,id.owner,id.worker]);
  await db.query("insert into public.rfq_pilot_products(id,store_id,name,unit,category,price_cents,cost_cents) values($1,$2,'Tea','piece','Food',500,300),($3,$4,'Other','piece','Other',600,400)",[id.p,id.store,id.otherP,id.other]);
  // Owner's real session sees own costs only; cannot read another store or select raw costs.
  const ownerCosts=await as('authenticated',id.owner,id.os,'select * from public.rfq_pilot_owner_product_costs($1)',[id.store]);
  assert.equal(ownerCosts.length,1);assert.equal(ownerCosts[0].id,id.p);assert.equal(Number(ownerCosts[0].cost_cents),300);
  await as('authenticated',id.owner,id.os,'select * from public.rfq_pilot_owner_product_costs($1)',[id.other],/owner_required/);
  await as('authenticated',id.owner,id.os,'select cost_cents from public.rfq_pilot_products',[],/permission denied/);
  const ownerRows=await as('authenticated',id.owner,id.os,`select ${publicSelect} from public.rfq_pilot_products`);
  assert.equal(ownerRows.length,1);assert.equal(ownerRows[0].category,'Food');
  // Worker cannot call owner RPC, even with a valid live session.
  await as('authenticated',id.worker,id.ws,'select * from public.rfq_pilot_owner_product_costs($1)',[id.store],/owner_required/);
  await as('authenticated',id.worker,id.ws,'select cost_cents from public.rfq_pilot_products',[],/permission denied/);
  await as('authenticated',id.worker,id.ws,'select * from public.rfq_pilot_products',[],/permission denied/);
  // Without an approved active worker lease, RLS still hides the public catalog.
  assert.equal((await as('authenticated',id.worker,id.ws,`select ${publicSelect} from public.rfq_pilot_products`)).length,0);
  await as('authenticated',id.owner,'99999999-9999-4999-8999-999999999999','select * from public.rfq_pilot_owner_product_costs($1)',[id.store],/owner_required/);
  await as('anon','','','select * from public.rfq_pilot_owner_product_costs($1)',[id.store],/permission denied/);
  // Actual approved worker device + live lease: public fields visible, costs still denied.
  await db.query("insert into public.rfq_pilot_devices(store_id,id,user_id,kind,status,approved_by,approved_at) values($1,$2,$3,'cashier_phone','approved',$4,now())",[id.store,id.device,id.worker,id.owner]);
  await db.exec('begin');await db.exec('set local role authenticated');
  await db.query("select set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true)",[id.worker,JSON.stringify({sub:id.worker,role:'authenticated',session_id:id.ws})]);
  await db.query('select public.rfq_pilot_claim_worker($1,$2)',[id.store,id.device]);await db.exec('commit');
  const workerRows=await as('authenticated',id.worker,id.ws,`select ${publicSelect} from public.rfq_pilot_products`);
  assert.equal(workerRows.length,1);assert.equal(workerRows[0].id,id.p);assert.equal(workerRows[0].category,'Food');
  await as('authenticated',id.worker,id.ws,'select * from public.rfq_pilot_owner_product_costs($1)',[id.store],/owner_required/);
  await as('authenticated',id.worker,id.ws,'select cost_cents from public.rfq_pilot_products',[],/permission denied/);
  console.log('PASS catalog read security: owner costs only, worker public fields, cross-store/session/anon denial, UI role change, public-only mirror.');
}finally{await db.close();}
