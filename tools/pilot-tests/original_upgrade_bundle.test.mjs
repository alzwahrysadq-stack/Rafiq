// One-phone-copy SQL Editor upgrade: 003+004 in ONE transaction. PGlite only.
import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const source=f=>readFileSync(new URL('../../supabase/migrations/'+f,import.meta.url),'utf8');
const bundle=readFileSync(new URL('../../docs/rafiq_test_upgrade_20261016.sql',import.meta.url),'utf8');
const migration3=source('20261016000300_original_cash_shift_decision.sql');
const migration4=source('20261016000400_original_finance_and_owner_events.sql');
assert.match(bundle,/^-- ONE-TIME TEST PROJECT UPGRADE/);
assert.equal((bundle.match(/^begin;$/gmi)||[]).length,1);
assert.equal((bundle.match(/^commit;$/gmi)||[]).length,1);
assert.ok(bundle.includes('rfq_pilot_reject_shift')&&bundle.includes('rfq_pilot_cash_advance')&&
  bundle.includes('rfq_pilot_post_invoice_checked'));
const setup=`create role authenticated nologin;create role anon nologin;
  create schema auth;create table auth.users(id uuid primary key);
  create table auth.sessions(id uuid primary key,user_id uuid not null references auth.users(id));
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
  create function auth.jwt() returns jsonb language sql stable as $$
    select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
  grant usage on schema auth to authenticated;
  grant execute on function auth.uid(),auth.jwt() to authenticated;`;
const db=new PGlite();
try{
  await db.exec(setup);
  await db.exec(source('20261015000100_pilot_control_plane.sql'));
  await db.exec(source('20261015000200_pilot_financial_ledger.sql'));
  await db.exec(bundle);
  const list=(await db.query("select proname from pg_proc where proname in ('rfq_pilot_cash_advance','rfq_pilot_reject_shift','rfq_pilot_post_invoice_checked') order by proname")).rows;
  assert.deepEqual(list.map(x=>x.proname),
    ['rfq_pilot_cash_advance','rfq_pilot_post_invoice_checked','rfq_pilot_reject_shift']);
  const count=(await db.query("select count(*)::int as n from information_schema.tables where table_schema='public' and table_name='rfq_pilot_owner_events'")).rows[0].n;
  assert.equal(count,1);
  await assert.rejects(()=>db.exec(bundle));
  await db.exec('rollback');
  assert.equal((await db.query("select count(*)::int as n from information_schema.tables where table_schema='public' and table_name='rfq_pilot_owner_events'")).rows[0].n,1,
    'repeated installation does not replace existing owner events');
}finally{await db.close();}
const empty=new PGlite();
try{await empty.exec(setup);
  await assert.rejects(()=>empty.exec(bundle),/pilot_shift_schema_missing_do_not_rerun_installer/);
  await empty.exec('rollback');
  assert.equal((await empty.query("select count(*)::int as n from information_schema.tables where table_schema='public' and table_name='rfq_pilot_owner_events'")).rows[0].n,0,
    'preflight failure leaves no financial table');
  assert.equal((await empty.query("select count(*)::int as n from information_schema.tables where table_schema='public' and table_name='rfq_pilot_shift_requests'")).rows[0].n,0);
}finally{await empty.close();}
// Reproducible concatenation must not hide/reorder source migrations.
assert.ok(bundle.indexOf('BEGIN incremental source 20261016000300')<bundle.indexOf('BEGIN incremental source 20261016000400'));
assert.ok(migration3.includes('rfq_pilot_reject_shift')&&migration4.includes('rfq_pilot_cash_advance'));
console.log('PASS SQL Editor upgrade bundle: atomic 003+004, rollback on missing base, reject second application; test DB only.');
