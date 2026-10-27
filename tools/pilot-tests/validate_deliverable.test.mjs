// Run against the EXACT one-time SQL file being handed to the owner.
// Synthetic in-memory Auth only. No real Supabase connection, password or service key.
// Usage: node tools/pilot-tests/validate_deliverable.test.mjs FILE OWNER_EMAIL WORKER_EMAIL
import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';

const [file,ownerEmail,workerEmail]=process.argv.slice(2);
if(!file || !ownerEmail || !workerEmail)throw Error('FILE OWNER_EMAIL WORKER_EMAIL required');
const sql=readFileSync(file,'utf8');
const store=sql.match(/declare v_store uuid := '([0-9a-f-]{36})'::uuid;/)?.[1];
assert.ok(store,'no seed UUID');
assert.ok(sql.startsWith('-- RAFIQ TEST PROJECT ONLY'));
assert.ok(sql.includes('begin;')&&sql.includes('\ncommit;\nselect '),'single-transaction editor script');
assert.ok(sql.includes("lower('"+ownerEmail.replaceAll("'","''")+"')"));
assert.ok(sql.includes("lower('"+workerEmail.replaceAll("'","''")+"')"));
assert.doesNotMatch(sql,/(?:sb_secret_|-----BEGIN PRIVATE KEY-----|service_role\s*=)/i);
assert.doesNotMatch(sql,/^\s*(?:delete\s+from\s+auth\.users|truncate\s+auth\.|drop\s+schema\s+auth)/im);

const owner='22222222-2222-4222-8222-222222222222';
const worker='33333333-3333-4333-8333-333333333333';
const ownerSession='44444444-4444-4444-8444-444444444444';
const workerSession='55555555-5555-4555-8555-555555555555';
async function setup(includeWorker){
  const db=new PGlite();
  await db.exec(`create role authenticated nologin;create role anon nologin;
    create schema auth;create table auth.users(id uuid primary key,email text not null unique);
    create table auth.sessions(id uuid primary key,user_id uuid not null references auth.users(id));
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    create function auth.jwt() returns jsonb language sql stable as $$
      select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
    grant usage on schema auth to authenticated;
    grant execute on function auth.uid(),auth.jwt() to authenticated;`);
  // Match the owner's account case-insensitively; still bind exactly the supplied IDs.
  await db.query('insert into auth.users(id,email) values($1,$2)',[owner,ownerEmail.toUpperCase()]);
  await db.query('insert into auth.sessions(id,user_id) values($1,$2)',[ownerSession,owner]);
  if(includeWorker){
    await db.query('insert into auth.users(id,email) values($1,$2)',[worker,workerEmail]);
    await db.query('insert into auth.sessions(id,user_id) values($1,$2)',[workerSession,worker]);
  }
  return db;
}
async function as(db,user,session,query,params=[]){
  await db.exec('begin');
  try{
    await db.exec('set local role authenticated');
    await db.query("select set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true)",
      [user,JSON.stringify({sub:user,role:'authenticated',session_id:session})]);
    const rows=(await db.query(query,params)).rows;
    await db.exec('commit');return rows;
  }catch(error){await db.exec('rollback');throw error;}
}
const installed=await setup(true);
try{
  await installed.exec(sql);
  const rows=(await installed.query('select id,name,enabled,seat_limit,license_until from public.rfq_pilot_stores')).rows;
  assert.equal(rows.length,1);assert.equal(rows[0].id,store);assert.equal(rows[0].seat_limit,4);
  assert.equal(rows[0].enabled,true);assert.equal(rows[0].name,'متجر رفيق التجريبي — صنعاء');
  assert.equal(new Date(rows[0].license_until).toISOString(),'2027-01-15T00:00:00.000Z');
  const roles=(await installed.query(`select m.role,u.email from public.rfq_pilot_members m
    join auth.users u on u.id=m.user_id order by m.role`)).rows;
  assert.deepEqual(roles,[{role:'owner',email:ownerEmail.toUpperCase()},{role:'worker',email:workerEmail}]);
  for(const table of ['rfq_pilot_invoices','rfq_pilot_invoice_lines','rfq_pilot_debt_entries',
    'rfq_pilot_cash_entries','rfq_pilot_shifts','rfq_pilot_worker_leases']){
    assert.equal((await installed.query('select to_regclass($1) as tbl',[`public.${table}`])).rows[0].tbl,table);
  }
  const rls=(await installed.query(`select c.relname,c.relrowsecurity from pg_class c
    join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relkind='r' and c.relname like 'rfq_pilot_%'
    order by c.relname`)).rows;
  assert.equal(rls.length,14,'15 temporary+permanent tables were created; test hook was dropped');
  assert.ok(rls.every(t=>t.relrowsecurity===true),
    'EVERY retained test table must have RLS enabled by the exact delivered file');
  const ownerRows=await as(installed,owner,ownerSession,
    'select role from public.rfq_pilot_members where store_id=$1 order by role',[store]);
  assert.deepEqual(ownerRows.map(r=>r.role),['owner','worker']);
  const workerRows=await as(installed,worker,workerSession,
    'select role from public.rfq_pilot_members where store_id=$1 order by role',[store]);
  assert.deepEqual(workerRows.map(r=>r.role),['worker']);
  const anonymous=(await installed.query(`select has_table_privilege('anon','public.rfq_pilot_invoices','SELECT') as can_read`)).rows[0];
  assert.equal(anonymous.can_read,false);
}finally{await installed.close();}
const missing=await setup(false);
try{
  await assert.rejects(()=>missing.exec(sql),/test_auth_accounts_missing_or_duplicate/);
  await missing.exec('rollback');
  assert.equal((await missing.query("select to_regclass('public.rfq_pilot_stores') as table_name")).rows[0].table_name,
    null,'transaction MUST roll back all schema if worker account is absent');
}finally{await missing.close();}
console.log('PASS exact handoff SQL: two actual email selectors, synthetic Auth membership/RLS, atomic missing-user rollback. No live project contacted.');
