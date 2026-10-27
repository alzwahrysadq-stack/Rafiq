// Tests the one-run SQL Editor script as ONE PostgreSQL transaction, no real project.
import {PGlite} from '@electric-sql/pglite';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
const store='11111111-1111-4111-8111-111111111111';
const owner='22222222-2222-4222-8222-222222222222';
const worker='33333333-3333-4333-8333-333333333333';
const until=new Date(Date.now()+7*86400000).toISOString();
const py=`import sys\nsys.path.insert(0,'tools')\nfrom make_test_project_sql import create\nprint(create('owner@invalid.test','worker@invalid.test','Test shop',3,'${until}','${store}'))`;
const generated=spawnSync('python3',['-c',py],{cwd:new URL('../..',import.meta.url).pathname,encoding:'utf8'});
assert.equal(generated.status,0,generated.stderr);
const sql=generated.stdout;
assert.ok(sql.startsWith('-- RAFIQ TEST PROJECT ONLY'));
assert.match(sql,/^begin;/m);assert.match(sql,/^commit;/m);
assert.ok(!sql.includes('service_role\''));
async function dbWithUsers(workerExists){
  const db=new PGlite();
  await db.exec(`create role authenticated nologin; create role anon nologin;
    create schema auth;create table auth.users(id uuid primary key,email text not null unique);
    create table auth.sessions(id uuid primary key,user_id uuid not null references auth.users(id));
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    create function auth.jwt() returns jsonb language sql stable as $$
      select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
    grant usage on schema auth to authenticated;
    grant execute on function auth.uid(),auth.jwt() to authenticated;`);
  await db.query('insert into auth.users(id,email) values($1,$2)',[owner,'owner@invalid.test']);
  if(workerExists)await db.query('insert into auth.users(id,email) values($1,$2)',[worker,'worker@invalid.test']);
  return db;
}
const good=await dbWithUsers(true);
try{
  await good.exec(sql);
  const stores=(await good.query('select id,seat_limit,enabled from public.rfq_pilot_stores')).rows;
  assert.equal(stores.length,1);assert.equal(stores[0].id,store);
  assert.equal(stores[0].seat_limit,3);assert.equal(stores[0].enabled,true);
  const roles=(await good.query('select role from public.rfq_pilot_members order by role')).rows.map(r=>r.role);
  assert.deepEqual(roles,['owner','worker']);
  const financial=(await good.query("select to_regclass('public.rfq_pilot_invoices') as table_name")).rows[0];
  assert.equal(financial.table_name,'rfq_pilot_invoices');
}finally{await good.close();}
const missing=await dbWithUsers(false);
try{
  await assert.rejects(()=>missing.exec(sql),/test_auth_accounts_missing_or_duplicate/);
  await missing.exec('rollback');
  const absent=(await missing.query("select to_regclass('public.rfq_pilot_stores') as table_name")).rows[0];
  assert.equal(absent.table_name,null,'an absent worker must roll back the entire schema installation');
}finally{await missing.close();}
console.log('PASS SQL Editor bundle: atomic install, role seeds, missing-user rollback (fake IDs only).');
