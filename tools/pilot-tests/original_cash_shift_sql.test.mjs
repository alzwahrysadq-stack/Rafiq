// Upgrade contract against local in-memory PostgreSQL only. Never contacts Supabase.
import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';

const read = file => readFileSync(new URL('../../supabase/migrations/'+file,import.meta.url),'utf8');
const upgrade=read('20261016000300_original_cash_shift_decision.sql');
const ids={
  store:'11111111-1111-4111-8111-111111111111',store2:'11111111-1111-4111-8111-111111111112',
  owner:'22222222-2222-4222-8222-222222222222',worker:'33333333-3333-4333-8333-333333333333',
  another:'33333333-3333-4333-8333-333333333334',
  od:'44444444-4444-4444-8444-444444444444',wd:'55555555-5555-4555-8555-555555555555',
  os:'66666666-6666-4666-8666-666666666666',ws:'77777777-7777-4777-8777-777777777777',
  as:'88888888-8888-4888-8888-888888888888',
};
const db=new PGlite();let checks=0;
async function as(user,session,query,args=[],reject=null){
  await db.exec('begin');
  try{
    await db.exec('set local role authenticated');
    await db.query("select set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true)",
      [user,JSON.stringify({sub:user,role:'authenticated',session_id:session})]);
    const result=(await db.query(query,args)).rows;
    await db.exec('commit');
    if(reject)throw Error('UNEXPECTED_SUCCESS: '+query);
    checks++;return result;
  }catch(e){
    await db.exec('rollback');
    if(!reject||e.message.startsWith('UNEXPECTED_SUCCESS:'))throw e;
    assert.match(e.message,new RegExp(reject),query);checks++;return null;
  }
}
const owner=(q,a=[],r=null)=>as(ids.owner,ids.os,q,a,r);
const worker=(q,a=[],r=null)=>as(ids.worker,ids.ws,q,a,r);
const another=(q,a=[],r=null)=>as(ids.another,ids.as,q,a,r);
try{
  await db.exec(`create role authenticated nologin;create role anon nologin;
    create schema auth;
    create table auth.users(id uuid primary key);
    create table auth.sessions(id uuid primary key,user_id uuid not null references auth.users(id));
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    create function auth.jwt() returns jsonb language sql stable as $$
      select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
    grant usage on schema auth to authenticated;
    grant execute on function auth.uid(),auth.jwt() to authenticated;`);
  await db.exec(read('20261015000100_pilot_control_plane.sql'));
  await db.exec(read('20261015000200_pilot_financial_ledger.sql'));
  await db.exec(upgrade); // exactly one incremental SQL Editor script, after installed schema
  await db.query('insert into auth.users(id) values ($1),($2),($3)',[ids.owner,ids.worker,ids.another]);
  await db.query('insert into auth.sessions(id,user_id) values ($1,$2),($3,$4),($5,$6)',
    [ids.os,ids.owner,ids.ws,ids.worker,ids.as,ids.another]);
  await db.query("insert into public.rfq_pilot_stores(id,name,enabled,seat_limit,license_until) values($1,'Store',true,3,now()+interval '30 days'),($2,'Other',true,3,now()+interval '30 days')",
    [ids.store,ids.store2]);
  await db.query("insert into public.rfq_pilot_members(store_id,user_id,role) values($1,$2,'owner'),($1,$3,'worker'),($4,$5,'owner')",
    [ids.store,ids.owner,ids.worker,ids.store2,ids.another]);
  await owner('select public.rfq_pilot_request_device($1,$2,$3)',[ids.store,ids.od,'owner_phone']);
  await owner('select public.rfq_pilot_approve_device($1,$2)',[ids.store,ids.od]);
  await worker('select public.rfq_pilot_request_device($1,$2,$3)',[ids.store,ids.wd,'cashier_phone']);
  await owner('select public.rfq_pilot_approve_device($1,$2)',[ids.store,ids.wd]);
  await worker('select public.rfq_pilot_claim_worker($1,$2)',[ids.store,ids.wd]);
  await another('select public.rfq_pilot_request_shift($1,$2)',[ids.store,ids.wd],
    'approved_cashier_session_required');
  const first=(await worker('select public.rfq_pilot_request_shift($1,$2) as id',[ids.store,ids.wd]))[0].id;
  const repeat=(await worker('select public.rfq_pilot_request_shift($1,$2) as id',[ids.store,ids.wd]))[0].id;
  assert.equal(first,repeat,'duplicate taps must return the same request ID');
  await worker('select public.rfq_pilot_reject_shift($1)',[first],'owner_and_pending_request_required');
  await another('select public.rfq_pilot_reject_shift($1)',[first],'owner_and_pending_request_required');
  await db.exec('begin;set local role anon');
  try{await assert.rejects(()=>db.query('select public.rfq_pilot_reject_shift($1)',[first]),/permission denied/);checks++;}
  finally{await db.exec('rollback');}
  await worker('update public.rfq_pilot_shift_requests set status=$1 where id=$2',['rejected',first],
    'permission denied');
  await owner('select public.rfq_pilot_reject_shift($1)',[first]);
  await owner('select public.rfq_pilot_reject_shift($1)',[first],'owner_and_pending_request_required');
  await owner('select public.rfq_pilot_approve_shift($1,$2)',[first,0],
    'owner_and_pending_request_required');
  const rows=await worker('select status,rejected_by,rejected_at from public.rfq_pilot_shift_requests where id=$1',[first]);
  assert.equal(rows[0].status,'rejected');assert.equal(rows[0].rejected_by,ids.owner);
  assert.ok(rows[0].rejected_at);
  const noShift=await owner('select count(*)::int as count from public.rfq_pilot_shifts where store_id=$1',[ids.store]);
  assert.equal(noShift[0].count,0);
  const second=(await worker('select public.rfq_pilot_request_shift($1,$2) as id',[ids.store,ids.wd]))[0].id;
  assert.notEqual(first,second,'a rejected request may be requested again');
  await owner('select public.rfq_pilot_approve_shift($1,$2)',[second,-1],'invalid_opening_balance');
  await owner('select public.rfq_pilot_approve_shift($1,$2)',[second,null],'invalid_opening_balance');
  await owner('select public.rfq_pilot_approve_shift($1,$2)',[second,99999999901],
    'rfq_pilot_original_opening_limit');
  const shift=(await owner('select public.rfq_pilot_approve_shift($1,$2) as id',[second,50000]))[0].id;
  assert.equal((await worker('select public.rfq_pilot_my_open_shift($1,$2) as id',[ids.store,ids.wd]))[0].id,shift);
  await owner('select public.rfq_pilot_reject_shift($1)',[second],'owner_and_pending_request_required');
  await worker('select public.rfq_pilot_request_shift($1,$2)',[ids.store,ids.wd],
    'open_shift_already_exists');
  await owner('select public.rfq_pilot_close_shift($1,$2)',[shift,null],'invalid_count');
  await owner('select public.rfq_pilot_close_shift($1,$2)',[shift,-1],'invalid_count');
  await owner('select public.rfq_pilot_close_shift($1,$2)',[shift,99999999901],
    'rfq_pilot_original_counted_limit');
  await worker('select public.rfq_pilot_close_shift($1,$2)',[shift,50000],
    'owner_and_open_shift_required');
  const closed=(await owner('select public.rfq_pilot_close_shift($1,$2) as report',[shift,50000]))[0].report;
  assert.equal(closed.expected_cents,50000);assert.equal(closed.difference_cents,0);
  assert.equal((await worker('select public.rfq_pilot_my_open_shift($1,$2) as id',[ids.store,ids.wd]))[0].id,null);
  await owner('select public.rfq_pilot_close_shift($1,$2)',[shift,50000],
    'owner_and_open_shift_required');
  assert.notEqual((await worker('select public.rfq_pilot_request_shift($1,$2) as id',[ids.store,ids.wd]))[0].id,second);
  const otherDb=new PGlite();
  try{await assert.rejects(()=>otherDb.exec(upgrade),/pilot_shift_schema_missing_do_not_rerun_installer/);checks++;}
  finally{await otherDb.close();}
  console.log(`PASS ${checks} original cash SQL checks: owner rejection, audit, no duplicate/open shift, valid open/close; in-memory only.`);
}finally{await db.close();}
