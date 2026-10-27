// Local, in-memory PostgreSQL tests only. Does not contact Supabase or build Android.
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const db = new PGlite();
const migration = readFileSync(new URL('../../supabase/migrations/20261015000100_pilot_control_plane.sql', import.meta.url), 'utf8');
const u = {
  store: '11111111-1111-4111-8111-111111111111',
  store2: '11111111-1111-4111-8111-111111111112',
  owner: '22222222-2222-4222-8222-222222222222',
  worker: '33333333-3333-4333-8333-333333333333',
  ownerDevice: '44444444-4444-4444-8444-444444444444',
  cashier: '55555555-5555-4555-8555-555555555555',
  web: '66666666-6666-4666-8666-666666666666',
  pendingOwnerDevice: '66666666-6666-4666-8666-666666666667',
  ownerSession: '77777777-7777-4777-8777-777777777777',
  workerSession1: '88888888-8888-4888-8888-888888888888',
  workerSession2: '99999999-9999-4999-8999-999999999999',
  workerSession3: '99999999-9999-4999-8999-999999999998',
  sale1: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  sale2: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
};
let checks = 0;

async function as(user, session, sql, params = [], errorContains = null) {
  await db.exec('begin');
  try {
    await db.exec('set local role authenticated');
    await db.query("select set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claims', $2, true)",
      [user, JSON.stringify({ sub: user, role: 'authenticated', session_id: session })]);
    const result = await db.query(sql, params);
    await db.exec('commit');
    if (errorContains) throw new Error(`UNEXPECTED_SUCCESS: expected ${errorContains} but operation succeeded`);
    checks++;
    return result.rows;
  } catch (error) {
    await db.exec('rollback');
    if (!errorContains || error.message.startsWith('UNEXPECTED_SUCCESS:')) throw error;
    assert.match(error.message, new RegExp(errorContains), sql);
    checks++;
    return null;
  }
}
const worker = (sql, params = [], errorContains = null) =>
  as(u.worker, u.workerSession1, sql, params, errorContains);
const second = (sql, params = [], errorContains = null) =>
  as(u.worker, u.workerSession2, sql, params, errorContains);
const owner = (sql, params = [], errorContains = null) =>
  as(u.owner, u.ownerSession, sql, params, errorContains);

try {
  await db.exec(`
    create role authenticated nologin;
    create role anon nologin;
    create schema auth;
    create table auth.users(id uuid primary key);
    create table auth.sessions(id uuid primary key, user_id uuid not null references auth.users(id));
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid
    $$;
    create function auth.jwt() returns jsonb language sql stable as $$
      select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb
    $$;
    grant usage on schema auth to authenticated;
    grant execute on function auth.uid(), auth.jwt() to authenticated;
  `);
  await db.exec(migration);
  await db.query('insert into auth.users(id) values ($1),($2)', [u.owner,u.worker]);
  await db.query('insert into auth.sessions(id,user_id) values ($1,$2),($3,$4),($5,$4),($6,$4)',
    [u.ownerSession,u.owner,u.workerSession1,u.worker,u.workerSession2,u.workerSession3]);
  await db.query("insert into public.rfq_pilot_stores(id,name,enabled,seat_limit,license_until) values ($1,$2,true,2,now()+interval '30 days'),($3,$4,true,2,now()+interval '30 days')",
    [u.store,'Test shop',u.store2,'Another shop']);
  await db.query("insert into public.rfq_pilot_members(store_id,user_id,role) values ($1,$2,'owner'),($1,$3,'worker')",
    [u.store,u.owner,u.worker]);

  // Membership cannot be forged by any client; no worker can self-approve a seat.
  await worker('insert into public.rfq_pilot_members(store_id,user_id,role) values ($1,$2,$3)',
    [u.store2,u.worker,'owner'], 'permission denied');
  await worker('select public.rfq_pilot_request_device($1,$2,$3)',
    [u.store2,u.cashier,'cashier_phone'], 'membership_required');
  await owner('select public.rfq_pilot_request_device($1,$2,$3)', [u.store,u.ownerDevice,'owner_phone']);
  await owner('select public.rfq_pilot_approve_device($1,$2)', [u.store,u.ownerDevice]);
  await worker('select public.rfq_pilot_request_device($1,$2,$3)', [u.store,u.cashier,'cashier_phone']);
  await worker('select public.rfq_pilot_claim_worker($1,$2)',
    [u.store,u.cashier], 'worker_device_or_session_denied');
  await owner('select public.rfq_pilot_approve_device($1,$2)', [u.store,u.cashier]);
  await worker('select public.rfq_pilot_request_device($1,$2,$3)', [u.store,u.web,'web']);
  await owner('select public.rfq_pilot_approve_device($1,$2)',
    [u.store,u.web], 'device_limit_reached');
  await worker('select public.rfq_pilot_approve_device($1,$2)',
    [u.store,u.web], 'owner_required');
  const otherShop = await worker('select count(*)::int as count from public.rfq_pilot_stores where id=$1', [u.store2]);
  assert.equal(otherShop[0].count,0, 'different store must not be visible');
  await worker("update public.rfq_pilot_devices set status='approved' where store_id=$1 and id=$2",
    [u.store,u.web], 'permission denied');
  await owner("insert into public.rfq_pilot_sale_auth_tests(id,store_id,shift_id,worker_id,cashier_device_id,total_cents,paid_cents) values ($1,$2,$3,$4,$5,1,1)",
    [u.sale1,u.store,u.store,u.worker,u.cashier], 'permission denied');
  await db.exec('begin; set local role anon');
  try {
    await db.query('select public.rfq_pilot_claim_worker($1,$2)', [u.store,u.cashier]);
    throw new Error('UNEXPECTED_SUCCESS: anon invoked guarded RPC');
  } catch (error) {
    assert.match(error.message, /permission denied/);
    checks++;
  } finally {
    await db.exec('rollback');
  }

  await worker('select public.rfq_pilot_claim_worker($1,$2)', [u.store,u.cashier]);
  await second('select public.rfq_pilot_claim_worker($1,$2)',
    [u.store,u.cashier], 'worker_session_already_active');
  await worker('select public.rfq_pilot_request_shift($1,$2) as id', [u.store,u.cashier]);
  let requests = await owner("select id from public.rfq_pilot_shift_requests where store_id=$1 and status='pending'", [u.store]);
  assert.equal(requests.length, 1);
  await worker('select public.rfq_pilot_approve_shift($1,$2)',
    [requests[0].id,1000], 'owner_and_pending_request_required');
  const shifts = await owner('select public.rfq_pilot_approve_shift($1,$2) as id', [requests[0].id,1000]);
  const shift = shifts[0].id;
  const ownShift = await worker('select public.rfq_pilot_my_open_shift($1,$2) as id', [u.store,u.cashier]);
  assert.equal(ownShift[0].id, shift);
  const hidden = await worker('select count(*)::int as count from public.rfq_pilot_shifts');
  assert.equal(hidden[0].count, 0, 'worker must not read treasury data');
  await worker('select * from public.rfq_pilot_sale_auth_tests', [], 'permission denied');
  await worker('select public.rfq_pilot_test_sale($1,$2,$3,$4,$5)',
    [shift,u.web,u.sale1,2000,500], 'approved_open_shift_required');
  await second('select public.rfq_pilot_test_sale($1,$2,$3,$4,$5)',
    [shift,u.cashier,u.sale1,2000,500], 'approved_open_shift_required');
  await worker('select public.rfq_pilot_test_sale($1,$2,$3,$4,$5)',
    [shift,u.cashier,u.sale1,2000,500]);
  const repeated = await worker('select public.rfq_pilot_test_sale($1,$2,$3,$4,$5) as id',
    [shift,u.cashier,u.sale1,2000,500]);
  assert.equal(repeated[0].id,u.sale1);
  await worker('select public.rfq_pilot_test_sale($1,$2,$3,$4,$5)',
    [shift,u.cashier,u.sale1,3000,500], 'idempotency_event_conflict');
  await worker('select public.rfq_pilot_close_shift($1,$2)',
    [shift,1500], 'owner_and_open_shift_required');

  // Owner revocation invalidates an otherwise-unexpired Supabase access token.
  await owner('select public.rfq_pilot_revoke_worker($1,$2)', [u.store,u.worker]);
  await worker('select public.rfq_pilot_test_sale($1,$2,$3,$4,$5)',
    [shift,u.cashier,u.sale2,1000,1000], 'approved_open_shift_required');
  await worker('select public.rfq_pilot_claim_worker($1,$2)',
    [u.store,u.cashier], 'worker_device_or_session_denied');
  await second('select public.rfq_pilot_claim_worker($1,$2)', [u.store,u.cashier]);
  await second('select public.rfq_pilot_test_sale($1,$2,$3,$4,$5)',
    [shift,u.cashier,u.sale2,1000,1000]);
  const report = await owner('select public.rfq_pilot_close_shift($1,$2) as report', [shift,2500]);
  assert.equal(report[0].report.expected_cents, 2500);
  assert.equal(report[0].report.difference_cents, 0);
  assert.match(report[0].report.warning,/PILOT/);
  await second('select public.rfq_pilot_test_sale($1,$2,$3,$4,$5)',
    [shift,u.cashier,'cccccccc-cccc-4ccc-8ccc-cccccccccccc',100,100], 'approved_open_shift_required');
  await second('select public.rfq_pilot_heartbeat($1,$2)', [u.store,u.cashier]);
  await db.query('update public.rfq_pilot_worker_leases set lease_until=now()-interval \'1 second\' where user_id=$1', [u.worker]);
  await second('select public.rfq_pilot_heartbeat($1,$2)',
    [u.store,u.cashier], 'worker_session_expired');
  await worker('select public.rfq_pilot_revoke_device($1,$2)',
    [u.store,u.cashier], 'owner_required');
  await owner('select public.rfq_pilot_revoke_device($1,$2)', [u.store,u.cashier]);
  await second('select public.rfq_pilot_claim_worker($1,$2)',
    [u.store,u.cashier], 'worker_device_or_session_denied');
  await owner('select public.rfq_pilot_approve_device($1,$2)', [u.store,u.web]);
  await as(u.worker,u.workerSession3,'select public.rfq_pilot_claim_worker($1,$2)',[u.store,u.web]);
  const webRequest=(await as(u.worker,u.workerSession3,
    'select public.rfq_pilot_request_shift($1,$2) as id',[u.store,u.web]))[0].id;
  const webShift=(await owner('select public.rfq_pilot_approve_shift($1,$2) as id',[webRequest,0]))[0].id;
  const webShiftVisible=(await as(u.worker,u.workerSession3,
    'select public.rfq_pilot_my_open_shift($1,$2) as id',[u.store,u.web]))[0].id;
  assert.equal(webShiftVisible,webShift,'approved web cashier may open a shift');
  await owner('select public.rfq_pilot_close_shift($1,$2)',[webShift,0]);
  await owner('select public.rfq_pilot_request_device($1,$2,$3)',
    [u.store,u.pendingOwnerDevice,'owner_phone']);
  await db.query("update public.rfq_pilot_stores set license_until=now()-interval '1 second' where id=$1", [u.store]);
  await owner('select public.rfq_pilot_approve_device($1,$2)',
    [u.store,u.pendingOwnerDevice], 'license_expired');
  await as(u.worker,u.workerSession3,'select public.rfq_pilot_claim_worker($1,$2)',
    [u.store,u.web], 'worker_device_or_session_denied');
  const afterExpiry = await owner('select public.rfq_pilot_is_owner($1) as can_view, public.rfq_pilot_license_current($1) as can_sell', [u.store]);
  assert.equal(afterExpiry[0].can_view,true, 'owner retains read/report access after expiry');
  assert.equal(afterExpiry[0].can_sell,false, 'license expiry must stop new authorizations');
  // A signed-out JWT is not an acceptable substitute for a live auth.sessions row.
  await db.query('delete from auth.sessions where id=$1', [u.workerSession2]);
  await second('select public.rfq_pilot_claim_worker($1,$2)',
    [u.store,u.cashier], 'authenticated_session_required');
  const signedOutDevices = await second('select count(*)::int as count from public.rfq_pilot_devices where store_id=$1', [u.store]);
  assert.equal(signedOutDevices[0].count,0);
  await db.query('delete from auth.sessions where id=$1', [u.ownerSession]);
  await owner('select public.rfq_pilot_revoke_worker($1,$2)',
    [u.store,u.worker], 'owner_required');

  console.log(`PASS ${checks} pilot SQL authorization checks + assertions; Android not built, Supabase not contacted.`);
} finally {
  await db.close();
}
