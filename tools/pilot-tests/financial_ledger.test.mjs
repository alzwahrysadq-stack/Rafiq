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

  // Only the owner can add products; worker can see sale price, never cost/profit.
  await worker('select public.rfq_pilot_save_product($1,$2,$3,$4,$5,$6,$7,$8)',
    [u.store,null,'Test rice','460111','piece',500,300,3000], 'active_owner_license_required');
  const product=(await owner('select public.rfq_pilot_save_product($1,$2,$3,$4,$5,$6,$7,$8) as id',
    [u.store,null,'Test rice','460111','piece',500,300,3000]))[0].id;
  await worker('select public.rfq_pilot_create_customer($1,$2,$3,$4,$5)',
    [u.store,u.cashier,u.customer,'Client','967711111111'],'authorized_session_required');
  await worker('select public.rfq_pilot_claim_worker($1,$2)',[u.store,u.cashier]);
  await worker('select public.rfq_pilot_create_customer($1,$2,$3,$4,$5)',
    [u.store,u.cashier,u.customer,'Client','967711111111']);
  const same=(await worker('select public.rfq_pilot_create_customer($1,$2,$3,$4,$5) as id',
    [u.store,u.cashier,u.customer,'Client','967711111111']))[0];
  assert.equal(same.id,u.customer);
  await worker('select public.rfq_pilot_create_customer($1,$2,$3,$4,$5)',
    [u.other,u.cashier,u.customer,'Client','967711111111'],'authorized_session_required');
  await worker('select cost_cents from public.rfq_pilot_products where id=$1',[product],'permission denied');
  await worker('select public.rfq_pilot_owner_summary($1)',[u.store],'owner_required');
  const visible=(await worker('select id,price_cents,stock_milli from public.rfq_pilot_products where store_id=$1',[u.store]))[0];
  assert.equal(visible.price_cents,500);
  assert.equal(visible.stock_milli,3000);
  await worker('update public.rfq_pilot_products set price_cents=1 where id=$1',[product],'permission denied');
  await owner('select public.rfq_pilot_adjust_stock($1,$2,$3,$4,$5)',
    [u.store,product,u.adjustment,1000,'new stock']);
  const stockAfterRetry=await owner('select public.rfq_pilot_adjust_stock($1,$2,$3,$4,$5) as stock',
    [u.store,product,u.adjustment,1000,'new stock']);
  assert.equal(Number(stockAfterRetry[0].stock),4000);
  await owner('select public.rfq_pilot_adjust_stock($1,$2,$3,$4,$5)',
    [u.store,product,u.adjustment,2000,'new stock'],'idempotency_event_conflict');

  const lines=JSON.stringify([{product_id:product,qty_milli:2000}]);
  await worker('select public.rfq_pilot_post_invoice($1,$2,$3,$4,$5::jsonb,$6,$7)',
    [u.invoice,u.cashier,u.invoice,u.customer,lines,200,true],'approved_open_shift_required');
  await worker('select public.rfq_pilot_request_shift($1,$2)',[u.store,u.cashier]);
  const request=(await owner("select id from public.rfq_pilot_shift_requests where store_id=$1 and status='pending'",[u.store]))[0].id;
  const shift=(await owner('select public.rfq_pilot_approve_shift($1,$2) as id',[request,1000]))[0].id;
  await worker('select public.rfq_pilot_post_invoice($1,$2,$3,$4,$5::jsonb,$6,$7)',
    [shift,u.web,u.invoice,u.customer,lines,200,true],'approved_open_shift_required');
  await worker('select public.rfq_pilot_post_invoice($1,$2,$3,$4,$5::jsonb,$6,$7)',
    [shift,u.cashier,u.invoice,u.customer,JSON.stringify([{product_id:product,qty_milli:5000}]),200,true],
    'insufficient_stock');
  await worker('select public.rfq_pilot_post_invoice($1,$2,$3,$4,$5::jsonb,$6,$7)',
    [shift,u.cashier,u.invoice,u.customer,JSON.stringify([{product_id:product,qty_milli:2000},{product_id:product,qty_milli:1000}]),200,true],
    'invalid_invoice_line');
  await worker('select public.rfq_pilot_post_invoice($1,$2,$3,$4,$5::jsonb,$6,$7)',
    [shift,u.cashier,u.invoice,null,lines,200,true],'invalid_credit_customer');
  const receipt=(await worker('select public.rfq_pilot_post_invoice($1,$2,$3,$4,$5::jsonb,$6,$7) as value',
    [shift,u.cashier,u.invoice,u.customer,lines,200,true]))[0].value;
  assert.equal(receipt.total_cents,1000);
  assert.equal(receipt.due_cents,800);
  assert.equal(receipt.already_committed,false);
  const retry=(await worker('select public.rfq_pilot_post_invoice($1,$2,$3,$4,$5::jsonb,$6,$7) as value',
    [shift,u.cashier,u.invoice,u.customer,lines,200,true]))[0].value;
  assert.equal(retry.invoice_id,u.invoice);
  assert.equal(retry.already_committed,true);
  await worker('select public.rfq_pilot_post_invoice($1,$2,$3,$4,$5::jsonb,$6,$7)',
    [shift,u.cashier,u.invoice,u.customer,lines,300,true],'idempotency_event_conflict');
  const after=(await worker('select stock_milli from public.rfq_pilot_products where id=$1',[product]))[0];
  assert.equal(Number(after.stock_milli),2000,'retry must not repeat stock consumption');
  await worker('insert into public.rfq_pilot_invoices(id,store_id,number,shift_id,worker_id,cashier_device_id,subtotal_cents,discount_cents,total_cents,cash_paid_cents,due_cents,request_json) values($1,$2,2,$3,$4,$5,0,0,0,0,0,\'{}\')',
    [u.invoice,u.store,shift,u.worker,u.cashier],'permission denied');
  await worker('select request_json from public.rfq_pilot_invoices where id=$1',[u.invoice],'permission denied');
  await worker('select cost_cents from public.rfq_pilot_invoice_lines where invoice_id=$1',[u.invoice],'permission denied');
  const invoiceVisible=(await worker('select number,due_cents from public.rfq_pilot_invoices where id=$1',[u.invoice]))[0];
  assert.equal(invoiceVisible.number,1);
  assert.equal(Number(invoiceVisible.due_cents),800);

  await worker('select public.rfq_pilot_owner_add_debt($1,$2,$3,$4,$5)',
    [u.store,u.customer,u.ownerDebt,300,'owner note'],'active_owner_license_required');
  await owner('select public.rfq_pilot_owner_add_debt($1,$2,$3,$4,$5)',
    [u.store,u.customer,u.ownerDebt,300,'owner note']);
  const balance=(await worker('select public.rfq_pilot_customer_balance($1,$2,$3) as cents',
    [u.store,u.cashier,u.customer]))[0];
  assert.equal(Number(balance.cents),1100);
  await worker('select public.rfq_pilot_collect_debt($1,$2,$3,$4,$5)',
    [shift,u.cashier,u.collection,u.customer,1200],'collection_exceeds_debt');
  await worker('select public.rfq_pilot_collect_debt($1,$2,$3,$4,$5)',
    [shift,u.cashier,u.collection,u.customer,200]);
  const collected=(await worker('select public.rfq_pilot_collect_debt($1,$2,$3,$4,$5) as cents',
    [shift,u.cashier,u.collection,u.customer,200]))[0];
  assert.equal(Number(collected.cents),900,'same collection ID cannot double cash/debt');
  await owner('select public.rfq_pilot_owner_cash_adjust($1,$2,$3,$4,$5)',
    [shift,u.expense,'expense',100,'test expense']);
  const ownerSummary=(await owner('select public.rfq_pilot_owner_summary($1) as value',[u.store]))[0].value;
  assert.equal(ownerSummary.sales_cents,1000);
  assert.equal(ownerSummary.outstanding_debt_cents,900);
  assert.equal(ownerSummary.gross_margin_estimate_cents,400);
  const report=(await owner('select public.rfq_pilot_close_shift($1,$2) as value',[shift,1300]))[0].value;
  assert.equal(report.expected_cents,1300,'1000 opening + 200 sale + 200 collection - 100 expense');
  assert.equal(report.difference_cents,0);
  const cashAfterClose=(await owner('select public.rfq_pilot_owner_cash_adjust($1,$2,$3,$4,$5) as cents',
    [shift,u.expense,'expense',100,'test expense']))[0];
  assert.equal(Number(cashAfterClose.cents),1300,'same owner cash movement survives shift close');
  await owner('select public.rfq_pilot_owner_cash_adjust($1,$2,$3,$4,$5)',
    [shift,'dddddddd-dddd-4ddd-8ddd-dddddddddddd','expense',100,'test expense'],
    'active_owner_open_shift_required');
  await owner('select public.rfq_pilot_owner_cash_adjust($1,$2,$3,$4,$5)',
    [shift,u.expense,'expense',200,'test expense'],'idempotency_event_conflict');
  const acknowledgedLate=(await worker('select public.rfq_pilot_post_invoice($1,$2,$3,$4,$5::jsonb,$6,$7) as value',
    [shift,u.cashier,u.invoice,u.customer,lines,200,true]))[0].value;
  assert.equal(acknowledgedLate.already_committed,true,'lost network reply must be recoverable after close');
  const collectionLate=(await worker('select public.rfq_pilot_collect_debt($1,$2,$3,$4,$5) as cents',
    [shift,u.cashier,u.collection,u.customer,200]))[0];
  assert.equal(Number(collectionLate.cents),900,'one collection even if response was lost');
  await worker('select public.rfq_pilot_post_invoice($1,$2,$3,$4,$5::jsonb,$6,$7)',
    [shift,u.cashier,'dddddddd-dddd-4ddd-8ddd-dddddddddddd',u.customer,lines,200,true],
    'approved_open_shift_required');
  await worker('select public.rfq_pilot_test_sale($1,$2,$3,$4,$5)',
    [shift,u.cashier,u.invoice,1,1],'does not exist');

  // On expiry: the owner may ACK an already committed UUID, never post a new entry.
  await db.query("update public.rfq_pilot_stores set license_until=now()-interval '1 second' where id=$1",[u.store]);
  const oldStock=(await owner('select public.rfq_pilot_adjust_stock($1,$2,$3,$4,$5) as stock',
    [u.store,product,u.adjustment,1000,'new stock']))[0];
  assert.equal(Number(oldStock.stock),2000,'stock ACK returns current stock without a second adjustment');
  await owner('select public.rfq_pilot_adjust_stock($1,$2,$3,$4,$5)',
    [u.store,product,'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',1000,'new stock'],
    'active_owner_license_required');
  const oldDebt=(await owner('select public.rfq_pilot_owner_add_debt($1,$2,$3,$4,$5) as cents',
    [u.store,u.customer,u.ownerDebt,300,'owner note']))[0];
  assert.equal(Number(oldDebt.cents),900,'owner debt ACK after expiry does not repeat debt');
  await owner('select public.rfq_pilot_owner_add_debt($1,$2,$3,$4,$5)',
    [u.store,u.customer,'ffffffff-ffff-4fff-8fff-ffffffffffff',300,'owner note'],
    'active_owner_license_required');
  const oldCash=(await owner('select public.rfq_pilot_owner_cash_adjust($1,$2,$3,$4,$5) as cents',
    [shift,u.expense,'expense',100,'test expense']))[0];
  assert.equal(Number(oldCash.cents),1300);
  await owner('select public.rfq_pilot_create_customer($1,$2,$3,$4,$5)',
    [u.store,null,u.customer,'Client','967711111111']);
  await owner('select public.rfq_pilot_create_customer($1,$2,$3,$4,$5)',
    [u.store,null,'10101010-1010-4010-8010-101010101010','Another',''],
    'authorized_session_required');
  const cashEntries=(await owner('select count(*) as count from public.rfq_pilot_cash_entries where shift_id=$1',
    [shift]))[0];
  assert.equal(Number(cashEntries.count),3,'only sale, collection and one expense');
  console.log(`PASS ${checks} pilot financial SQL operations plus assertions; no Supabase/Android calls.`);
} finally {await db.close();}
