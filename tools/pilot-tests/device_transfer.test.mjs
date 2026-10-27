// In-memory PostgreSQL integration tests. Synthetic users, no real project or Android build.
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const db = new PGlite();
const migration = name => readFileSync(new URL(`../../supabase/migrations/${name}`,import.meta.url),'utf8');
const u = {
  store:'11111111-1111-4111-8111-111111111111', other:'11111111-1111-4111-8111-111111111112',
  owner:'22222222-2222-4222-8222-222222222222',worker:'33333333-3333-4333-8333-333333333333',
  ownerSession:'44444444-4444-4444-8444-444444444444',workerSession:'55555555-5555-4555-8555-555555555555',
  cashier:'66666666-6666-4666-8666-666666666666',web:'66666666-6666-4666-8666-666666666667',
  invoice:'77777777-7777-4777-8777-777777777777',customer:'88888888-8888-4888-8888-888888888888',
  adjustment:'99999999-9999-4999-8999-999999999999',ownerDebt:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  collection:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',expense:'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
};
let checks=0;
async function as(uid,session,sql,params=[],denied=null) {
  await db.exec('begin');
  try {
    await db.exec('set local role authenticated');
    await db.query("select set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true)",
      [uid,JSON.stringify({sub:uid,role:'authenticated',session_id:session})]);
    const result=await db.query(sql,params);
    await db.exec('commit');
    if (denied) throw Error(`UNEXPECTED_SUCCESS: ${denied}`);
    checks++;
    return result.rows;
  } catch(e) {
    await db.exec('rollback');
    if (!denied || e.message.startsWith('UNEXPECTED_SUCCESS:')) throw e;
    assert.match(e.message,new RegExp(denied),sql);
    checks++;
    return null;
  }
}
const owner=(sql,params=[],denied=null)=>as(u.owner,u.ownerSession,sql,params,denied);
const worker=(sql,params=[],denied=null)=>as(u.worker,u.workerSession,sql,params,denied);

try {
  await db.exec(`
    create role authenticated nologin; create role anon nologin;
    create schema auth;
    create table auth.users(id uuid primary key);
    create table auth.sessions(id uuid primary key,user_id uuid not null references auth.users(id));
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    create function auth.jwt() returns jsonb language sql stable as $$
      select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
    grant usage on schema auth to authenticated;
    grant execute on function auth.uid(),auth.jwt() to authenticated;
  `);
  await db.exec(migration('20261015000100_pilot_control_plane.sql'));
  await db.exec(migration('20261015000200_pilot_financial_ledger.sql'));
  await db.query('insert into auth.users(id) values($1),($2)',[u.owner,u.worker]);
  await db.query('insert into auth.sessions(id,user_id) values($1,$2),($3,$4)',
    [u.ownerSession,u.owner,u.workerSession,u.worker]);
  await db.query("insert into public.rfq_pilot_stores(id,name,enabled,seat_limit,license_until) values ($1,'Pilot shop',true,3,now()+interval '30 days'),($2,'Other shop',true,2,now()+interval '30 days')",
    [u.store,u.other]);
  await db.query("insert into public.rfq_pilot_members(store_id,user_id,role) values($1,$2,'owner'),($1,$3,'worker')",
    [u.store,u.owner,u.worker]);
  await owner('select public.rfq_pilot_request_device($1,$2,$3)',[u.store,u.web,'web']);
  await owner('select public.rfq_pilot_approve_device($1,$2)',[u.store,u.web]);
  await worker('select public.rfq_pilot_request_device($1,$2,$3)',[u.store,u.cashier,'cashier_phone']);
  await owner('select public.rfq_pilot_approve_device($1,$2)',[u.store,u.cashier]);

  await db.exec(migration('20261022000200_owner_device_transfer.sql'));
  const pending='66666666-6666-4666-8666-666666666668';
  const extra='66666666-6666-4666-8666-666666666669';
  await owner('select public.rfq_pilot_request_device($1,$2,$3)',[u.store,pending,'web']);
  await owner('select public.rfq_pilot_request_device($1,$2,$3)',[u.store,extra,'owner_phone']);
  await owner('select public.rfq_pilot_approve_device($1,$2)',[u.store,extra]);
  // Three occupied seats: approving the already-approved device must still succeed.
  await owner('select public.rfq_pilot_approve_device($1,$2)',[u.store,u.web]);
  await owner('select public.rfq_pilot_approve_device($1,$2)',[u.store,pending],'device_limit_reached');
  const transfer='select public.rfq_pilot_replace_own_device($1,$2,$3) as id';
  await worker(transfer,[u.store,u.web,pending],'active_owner_license_required');
  await owner(transfer,[u.other,u.web,pending],'active_owner_license_required');
  await owner(transfer,[u.store,u.web,u.web],'invalid_device_transfer');
  await owner(transfer,[u.store,u.cashier,pending],'own_same_kind_devices_required');
  await owner(transfer,[u.store,extra,pending],'own_same_kind_devices_required');
  await db.query("insert into public.rfq_pilot_worker_leases(store_id,user_id,device_id,session_id,lease_until) values($1,$2,$3,$4,now()+interval '1 minute')",[u.store,u.owner,u.web,u.ownerSession]);
  await owner(transfer,[u.store,u.web,pending],'old_device_has_active_shift_or_session');
  await db.query('delete from public.rfq_pilot_worker_leases where store_id=$1 and user_id=$2',[u.store,u.owner]);
  const result=await owner(transfer,[u.store,u.web,pending]);assert.equal(result[0].id,pending);
  await owner(transfer,[u.store,u.web,pending]); // network-lost ACK retry: same audit event
  const devices=(await db.query('select id,status from public.rfq_pilot_devices where store_id=$1',[u.store])).rows;
  assert.equal(devices.filter(d=>d.status==='approved').length,3);
  assert.equal(devices.find(d=>d.id===u.web).status,'revoked');
  assert.equal(devices.find(d=>d.id===pending).status,'approved');
  assert.equal(devices.find(d=>d.id===u.cashier).status,'approved','worker device never touched');
  assert.equal((await db.query('select count(*)::int as n from public.rfq_pilot_device_transfers')).rows[0].n,1);
  const audits=await owner('select * from public.rfq_pilot_device_transfers');assert.equal(audits.length,1);
  assert.equal((await worker('select * from public.rfq_pilot_device_transfers')).length,0);
  await worker("update public.rfq_pilot_devices set status='approved' where id=$1",[u.web],'permission denied');
  await worker("insert into public.rfq_pilot_device_transfers(store_id,actor_id,old_device,new_device) values($1,$2,$3,$4)",[u.store,u.worker,u.cashier,pending],'permission denied');
  await db.exec('begin');await db.exec('set local role anon');
  try{await db.query(transfer,[u.store,pending,u.web]);assert.fail('anon executed transfer');}
  catch(e){assert.match(e.message,/permission denied/);}finally{await db.exec('rollback');}
  console.log('PASS device transfer: full-seat idempotent approval, explicit same-owner replacement, active-session block, seat preservation, audit, worker/cross-store/anon denial.');
} finally { await db.close(); }
