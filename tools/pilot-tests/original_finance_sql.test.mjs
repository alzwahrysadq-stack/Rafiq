// Local PGlite with synthetic users and authenticated/anon RLS; NO Supabase connection.
import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const read=f=>readFileSync(new URL('../../supabase/migrations/'+f,import.meta.url),'utf8');
const migrations=['20261015000100_pilot_control_plane.sql',
  '20261015000200_pilot_financial_ledger.sql',
  '20261016000300_original_cash_shift_decision.sql',
  '20261016000400_original_finance_and_owner_events.sql'];
const x={store:'11111111-1111-4111-8111-111111111111',otherStore:'11111111-1111-4111-8111-111111111112',
  owner:'22222222-2222-4222-8222-222222222222',worker:'33333333-3333-4333-8333-333333333333',
  stranger:'44444444-4444-4444-8444-444444444444',ownerDevice:'55555555-5555-4555-8555-555555555555',
  workerDevice:'66666666-6666-4666-8666-666666666666',ownerSession:'77777777-7777-4777-8777-777777777777',
  workerSession:'88888888-8888-4888-8888-888888888888',strangerSession:'99999999-9999-4999-8999-999999999999',
  customer:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',product:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  stock:'abababab-abab-4aba-8aba-abababababab',invoice:'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  advance:'dddddddd-dddd-4ddd-8ddd-dddddddddddd',collection:'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  manual:'ffffffff-ffff-4fff-8fff-ffffffffffff',expense:'10101010-1010-4010-8010-101010101010'};
const db=new PGlite();let checks=0;
async function as(user,sid,query,args=[],reject=null){
  await db.exec('begin');
  try{await db.exec('set local role authenticated');
    await db.query("select set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true)",
      [user,JSON.stringify({sub:user,role:'authenticated',session_id:sid})]);
    const rows=(await db.query(query,args)).rows;
    if(reject)throw Error('UNEXPECTED_SUCCESS: '+query);
    await db.exec('commit');checks++;return rows;
  }catch(e){await db.exec('rollback');
    if(!reject||e.message.startsWith('UNEXPECTED_SUCCESS:'))throw e;
    assert.match(e.message,new RegExp(reject),query);checks++;return null;}}
const owner=(q,a=[],r=null)=>as(x.owner,x.ownerSession,q,a,r);
const worker=(q,a=[],r=null)=>as(x.worker,x.workerSession,q,a,r);
const stranger=(q,a=[],r=null)=>as(x.stranger,x.strangerSession,q,a,r);
const one=rows=>Object.values(rows[0])[0];
try{
  await db.exec(`create role authenticated nologin;create role anon nologin;
    create schema auth;create table auth.users(id uuid primary key);
    create table auth.sessions(id uuid primary key,user_id uuid not null references auth.users(id));
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    create function auth.jwt() returns jsonb language sql stable as $$
      select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
    grant usage on schema auth to authenticated;
    grant execute on function auth.uid(),auth.jwt() to authenticated;`);
  for(const name of migrations)await db.exec(read(name));
  await db.query('insert into auth.users(id) values($1),($2),($3)',[x.owner,x.worker,x.stranger]);
  await db.query('insert into auth.sessions(id,user_id) values($1,$2),($3,$4),($5,$6)',
    [x.ownerSession,x.owner,x.workerSession,x.worker,x.strangerSession,x.stranger]);
  await db.query("insert into public.rfq_pilot_stores(id,name,enabled,seat_limit,license_until) values($1,'Fake',true,3,now()+interval '30 days'),($2,'Other',true,3,now()+interval '30 days')",
    [x.store,x.otherStore]);
  await db.query("insert into public.rfq_pilot_members(store_id,user_id,role) values($1,$2,'owner'),($1,$3,'worker'),($4,$5,'owner')",
    [x.store,x.owner,x.worker,x.otherStore,x.stranger]);
  await owner('select public.rfq_pilot_request_device($1,$2,$3)',[x.store,x.ownerDevice,'owner_phone']);
  await owner('select public.rfq_pilot_approve_device($1,$2)',[x.store,x.ownerDevice]);
  await worker('select public.rfq_pilot_request_device($1,$2,$3)',[x.store,x.workerDevice,'cashier_phone']);
  await owner('select public.rfq_pilot_approve_device($1,$2)',[x.store,x.workerDevice]);
  await worker('select public.rfq_pilot_claim_worker($1,$2)',[x.store,x.workerDevice]);
  assert.equal(one(await owner('select public.rfq_pilot_create_product_once($1,$2,$3,$4,$5,$6,$7)',
    [x.store,x.product,'Milk','12345','piece',750,400])),x.product);
  assert.equal(one(await owner('select public.rfq_pilot_create_product_once($1,$2,$3,$4,$5,$6,$7)',
    [x.store,x.product,'Milk','12345','piece',750,400])),x.product);
  await owner('select public.rfq_pilot_create_product_once($1,$2,$3,$4,$5,$6,$7)',
    [x.store,x.product,'Milk','12345','piece',751,400],'idempotency_event_conflict');
  await worker('select public.rfq_pilot_create_product_once($1,$2,$3,$4,$5,$6,$7)',
    [x.store,'abababab-abab-4aba-8aba-abababababab','Fake','12','piece',1,1],'owner_required');
  await owner('select public.rfq_pilot_adjust_stock($1,$2,$3,$4,$5)',
    [x.store,x.product,x.stock,3000,'fake stock']);
  await worker('select public.rfq_pilot_create_customer($1,$2,$3,$4,$5)',
    [x.store,x.workerDevice,x.customer,'Fake customer','967711111111']);
  const request=one(await worker('select public.rfq_pilot_request_shift($1,$2)',[x.store,x.workerDevice]));
  const shift=one(await owner('select public.rfq_pilot_approve_shift($1,$2)',[request,5000]));
  const checked='select public.rfq_pilot_post_invoice_checked($1,$2,$3,$4,$5::jsonb,$6,$7,$8)';
  const lines=JSON.stringify([{product_id:x.product,qty_milli:2000,quoted_price_cents:750}]);
  const invalid='24242424-2424-4242-8242-242424242424';
  // A price edit after the cashier's review must not invent a new customer debt.
  await owner('select public.rfq_pilot_save_product($1,$2,$3,$4,$5,$6,$7,$8)',
    [x.store,x.product,'Milk','12345','piece',800,400,0]);
  await worker(checked,[shift,x.workerDevice,invalid,x.customer,lines,500,false,1500],
    'price_changed_refresh_cart');
  assert.equal((await owner('select count(*)::int as n from public.rfq_pilot_invoices where store_id=$1',[x.store]))[0].n,0);
  assert.equal(Number(one(await owner('select stock_milli from public.rfq_pilot_products where id=$1',[x.product]))),3000);
  assert.equal(one(await owner('select public.rfq_pilot_shift_cash_snapshot($1,$2)',[shift,null])).expected_cents,5000);
  await owner('select public.rfq_pilot_save_product($1,$2,$3,$4,$5,$6,$7,$8)',
    [x.store,x.product,'Milk','12345','piece',750,400,0]);
  await worker(checked,[shift,x.workerDevice,invalid,x.customer,
    JSON.stringify([{product_id:x.product,qty_milli:2000}]),500,false,1500],
    'invalid_invoice_quote'); // absence, null or non-numeric price is not accepted
  await worker(checked,[shift,x.workerDevice,invalid,x.customer,lines,500,false,1400],
    'invalid_invoice_quote');
  await stranger(checked,[shift,x.workerDevice,invalid,x.customer,lines,500,false,1500],
    'approved_open_shift_required');
  const invoice=one(await worker(checked,
    [shift,x.workerDevice,x.invoice,x.customer,lines,500,false,1500]));
  assert.equal(invoice.total_cents,1500);assert.equal(invoice.due_cents,1000);
  await owner('select public.rfq_pilot_save_product($1,$2,$3,$4,$5,$6,$7,$8)',
    [x.store,x.product,'Milk','12345','piece',800,400,0]);
  const invoiceRetry=one(await worker(checked,
    [shift,x.workerDevice,x.invoice,x.customer,lines,500,false,1500]));
  assert.equal(invoiceRetry.already_committed,true,'lost reply retries same invoice UUID after a later price change');
  await worker(checked,[shift,x.workerDevice,x.invoice,x.customer,lines,600,false,1500],
    'idempotency_event_conflict');
  await worker(checked,[shift,x.workerDevice,x.invoice,x.customer,lines,500,false,1600],
    'idempotency_event_conflict');
  assert.equal((await owner('select count(*)::int as n from public.rfq_pilot_invoices where store_id=$1',[x.store]))[0].n,1);
  assert.equal(Number(one(await owner('select stock_milli from public.rfq_pilot_products where id=$1',[x.product]))),1000);
  const firstTill=one(await owner('select public.rfq_pilot_shift_cash_snapshot($1,$2)',[shift,null]));
  assert.equal(firstTill.expected_cents,5500);
  assert.equal(one(await owner('select public.rfq_pilot_owner_add_debt($1,$2,$3,$4,$5)',
    [x.store,x.customer,x.manual,400,'fake manual debt'])),1400);
  await worker('select public.rfq_pilot_cash_advance($1,$2,$3,$4,$5)',
    [shift,x.advance,x.customer,600,'fake customer cash'],'owner_required_for_cash_advance');
  await stranger('select public.rfq_pilot_cash_advance($1,$2,$3,$4,$5)',
    [shift,x.advance,x.customer,600,'fake customer cash'],'owner_required_for_cash_advance');
  const advance=one(await owner('select public.rfq_pilot_cash_advance($1,$2,$3,$4,$5)',
    [shift,x.advance,x.customer,600,'fake customer cash']));
  assert.deepEqual([advance.customer_balance_cents,advance.till_cents,advance.already_committed],[2000,4900,false]);
  const repeat=one(await owner('select public.rfq_pilot_cash_advance($1,$2,$3,$4,$5)',
    [shift,x.advance,x.customer,600,'fake customer cash']));
  assert.equal(repeat.already_committed,true);assert.equal(repeat.till_cents,4900);
  await owner('select public.rfq_pilot_cash_advance($1,$2,$3,$4,$5)',
    [shift,x.advance,x.customer,601,'fake customer cash'],'idempotency_event_conflict');
  await owner('select public.rfq_pilot_cash_advance($1,$2,$3,$4,$5)',
    [shift,'bcbcbcbc-bcbc-4bcb-8bcb-bcbcbcbcbcbc',x.customer,6000,'fake customer cash'],'insufficient_till_cash');
  assert.equal((await owner('select count(*)::int as n from public.rfq_pilot_debt_entries where kind=$1',
    ['cash_advance']))[0].n,1,'rejected overdraw has no partial customer debt');
  assert.equal(Number(one(await owner('select stock_milli from public.rfq_pilot_products where id=$1',[x.product]))),1000,
    'cash advance neither invoice nor goods stock movement');
  assert.equal(Number(one(await worker('select public.rfq_pilot_collect_debt($1,$2,$3,$4,$5)',
    [shift,x.workerDevice,x.collection,x.customer,300]))),1700);
  await owner('select public.rfq_pilot_owner_cash_adjust($1,$2,$3,$4,$5)',
    [shift,x.expense,'expense',250,'fake till expense']);
  await owner('select public.rfq_pilot_owner_cash_adjust($1,$2,$3,$4,$5)',
    [shift,'12121212-1212-4212-8212-121212121212','withdraw',5000,'would overdraw'],
    'insufficient_till_cash');
  const workerCash=one(await worker('select public.rfq_pilot_shift_cash_snapshot($1,$2)',[shift,x.workerDevice]));
  const ownerCash=one(await owner('select public.rfq_pilot_shift_cash_snapshot($1,$2)',[shift,null]));
  assert.equal(workerCash.expected_cents,4950);assert.equal(ownerCash.expected_cents,4950);
  assert.equal(workerCash.cash_advance_cents,-600);
  assert.deepEqual(workerCash.entries.map(e=>e.kind).sort(),
    ['sale','cash_advance','collection','expense'].sort());
  await stranger('select public.rfq_pilot_shift_cash_snapshot($1,$2)',[shift,x.workerDevice],
    'authorized_shift_required');
  const statement=one(await worker('select public.rfq_pilot_customer_statement($1,$2,$3)',
    [x.store,x.workerDevice,x.customer]));
  assert.equal(statement.balance_cents,1700);assert.equal(statement.entry_count,4);
  assert.deepEqual(statement.entries.map(e=>e.kind).sort(),
    ['invoice_due','owner_debit','cash_advance','collection'].sort());
  const overview=one(await worker('select public.rfq_pilot_customer_overview($1,$2)',[x.store,x.workerDevice]));
  assert.equal(overview.outstanding_cents,1700);assert.equal(overview.customers[0].balance_cents,1700);
  assert.equal(one(await owner('select public.rfq_pilot_customer_overview($1,$2)',[x.store,null])).outstanding_cents,1700);
  await stranger('select public.rfq_pilot_customer_statement($1,$2,$3)',[x.store,x.workerDevice,x.customer],
    'authorized_session_required');
  await stranger('select public.rfq_pilot_customer_overview($1,$2)',[x.store,x.workerDevice],
    'authorized_session_required');
  await worker('insert into public.rfq_pilot_cash_entries(id,store_id,shift_id,kind,amount_cents,actor_id) values($1,$2,$3,$4,$5,$6)',
    ['12121212-1212-4212-8212-121212121212',x.store,shift,'income',100,x.worker],
    'permission denied');
  assert.equal((await worker('select count(*)::int as n from public.rfq_pilot_owner_events where store_id=$1',[x.store]))[0].n,0);
  await worker('insert into public.rfq_pilot_owner_events(store_id,topic,reference_id) values($1,$2,$3)',
    [x.store,'sale',x.invoice],'permission denied');
  const events=await owner('select topic from public.rfq_pilot_owner_events where store_id=$1 order by id',[x.store]);
  assert.ok(events.some(e=>e.topic==='shift_requested'));
  assert.ok(events.some(e=>e.topic==='sale'));
  assert.ok(events.some(e=>e.topic==='cash_advance'));
  assert.ok(events.some(e=>e.topic==='collection'));
  assert.ok(events.some(e=>e.topic==='cash_expense'));
  const summary=one(await owner('select public.rfq_pilot_owner_summary($1)',[x.store]));
  assert.equal(summary.outstanding_debt_cents,1700);
  assert.equal(summary.cash_advances_cents,600);
  assert.equal(summary.goods_credit_cents,1000);
  await stranger('select public.rfq_pilot_owner_summary($1)',[x.store],'owner_required');
  const closed=one(await owner('select public.rfq_pilot_close_shift($1,$2)',[shift,4950]));
  assert.equal(closed.expected_cents,4950);
  const sameClosedInvoice=one(await worker(checked,
    [shift,x.workerDevice,x.invoice,x.customer,lines,500,false,1500]));
  assert.equal(sameClosedInvoice.already_committed,true,'retry acknowledges only the original invoice after close');
  await worker(checked,[shift,x.workerDevice,invalid,x.customer,lines,500,false,1500],
    'approved_open_shift_required');
  const afterClose=one(await owner('select public.rfq_pilot_cash_advance($1,$2,$3,$4,$5)',
    [shift,x.advance,x.customer,600,'fake customer cash']));
  assert.equal(afterClose.already_committed,true,'a previous committed advance may be verified after shift closes');
  console.log(`PASS ${checks} original finance SQL checks: isolated cash advance, till/debt, owner event RLS, no Room; synthetic only.`);
}finally{await db.close();}
