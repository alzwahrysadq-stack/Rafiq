-- Rafiq pilot control plane (TEST PROJECT ONLY, not a sales-ready schema).
-- Apply only after reviewing the test-project backup. The operator provisions
-- stores and memberships with service credentials; clients never get service_role.
-- This migration deliberately does NOT migrate Room, invoice lines, debts, stock,
-- license signatures, SMS, wallet balances, or the existing RFQ1 device license.

create table public.rfq_pilot_stores (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) between 1 and 120),
  enabled boolean not null default false,
  seat_limit integer not null default 2 check (seat_limit between 1 and 50),
  license_until timestamptz not null,
  created_at timestamptz not null default now()
);

create table public.rfq_pilot_members (
  store_id uuid not null references public.rfq_pilot_stores(id),
  user_id uuid not null references auth.users(id),
  role text not null check (role in ('owner', 'worker')),
  active boolean not null default true,
  primary key (store_id, user_id)
);
create index rfq_pilot_members_user_idx on public.rfq_pilot_members (user_id, store_id);

create table public.rfq_pilot_devices (
  store_id uuid not null references public.rfq_pilot_stores(id),
  id uuid not null,
  user_id uuid not null,
  kind text not null check (kind in ('owner_phone', 'cashier_phone', 'web')),
  status text not null default 'pending' check (status in ('pending', 'approved', 'revoked')),
  approved_by uuid references auth.users(id),
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (store_id, id),
  foreign key (store_id, user_id) references public.rfq_pilot_members(store_id, user_id)
);
create index rfq_pilot_devices_seats_idx on public.rfq_pilot_devices (store_id, status);

create table public.rfq_pilot_worker_leases (
  store_id uuid not null,
  user_id uuid not null,
  device_id uuid not null,
  session_id uuid not null,
  lease_until timestamptz not null,
  updated_at timestamptz not null default now(),
  primary key (store_id, user_id),
  foreign key (store_id, user_id) references public.rfq_pilot_members(store_id, user_id),
  foreign key (store_id, device_id) references public.rfq_pilot_devices(store_id, id)
);
create table public.rfq_pilot_denied_sessions (
  store_id uuid not null,
  user_id uuid not null,
  session_id uuid not null,
  denied_at timestamptz not null default now(),
  primary key (store_id, user_id, session_id)
);

create table public.rfq_pilot_shift_requests (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null,
  worker_id uuid not null,
  cashier_device_id uuid not null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'canceled')),
  created_at timestamptz not null default now(),
  approved_by uuid references auth.users(id),
  foreign key (store_id, worker_id) references public.rfq_pilot_members(store_id, user_id),
  foreign key (store_id, cashier_device_id) references public.rfq_pilot_devices(store_id, id)
);
create unique index rfq_pilot_one_pending_request on public.rfq_pilot_shift_requests (store_id, worker_id)
  where status = 'pending';

create table public.rfq_pilot_shifts (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.rfq_pilot_stores(id),
  worker_id uuid not null,
  cashier_device_id uuid not null,
  approved_by uuid not null references auth.users(id),
  status text not null default 'open' check (status in ('open', 'closed')),
  opening_cents bigint not null check (opening_cents >= 0),
  opened_at timestamptz not null default now(),
  closed_at timestamptz,
  counted_cents bigint check (counted_cents >= 0),
  expected_cents bigint,
  difference_cents bigint,
  foreign key (store_id, worker_id) references public.rfq_pilot_members(store_id, user_id),
  foreign key (store_id, cashier_device_id) references public.rfq_pilot_devices(store_id, id)
);
create unique index rfq_pilot_one_open_till on public.rfq_pilot_shifts (store_id, cashier_device_id)
  where status = 'open';
create unique index rfq_pilot_one_open_worker on public.rfq_pilot_shifts (store_id, worker_id)
  where status = 'open';

-- Authorization can be exercised without integrating actual invoices. This table
-- is NOT an accounting ledger and must NOT be connected to the shipped POS.
create table public.rfq_pilot_sale_auth_tests (
  id uuid primary key,
  store_id uuid not null references public.rfq_pilot_stores(id),
  shift_id uuid not null references public.rfq_pilot_shifts(id),
  worker_id uuid not null,
  cashier_device_id uuid not null,
  total_cents bigint not null check (total_cents >= 0),
  paid_cents bigint not null check (paid_cents >= 0),
  created_at timestamptz not null default now(),
  check (paid_cents <= total_cents)
);

-- Explicitly deny direct client writes; all state changes go through guarded RPCs.
do $$
declare t text;
begin
  foreach t in array array[
    'rfq_pilot_stores','rfq_pilot_members','rfq_pilot_devices',
    'rfq_pilot_worker_leases','rfq_pilot_denied_sessions',
    'rfq_pilot_shift_requests','rfq_pilot_shifts','rfq_pilot_sale_auth_tests'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
  end loop;
end $$;

-- Supabase Auth's signed JWT includes session_id. It must match the *current*
-- database lease on every worker operation: an older, still-valid JWT alone is
-- never sufficient to continue after an owner revokes a session.
create function public.rfq_pilot_session_id() returns uuid
language plpgsql stable security definer set search_path = '' as $$
declare v text;
begin
  v := auth.jwt() ->> 'session_id';
  if v is null or v !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return null;
  end if;
  return v::uuid;
end $$;

-- Auth sign-out deletes the session row, but its access JWT can remain usable until
-- expiry. Reject it immediately for this control plane (and all owner RPCs).
create function public.rfq_pilot_live_session() returns boolean
language sql stable security definer set search_path = '' as $$
  select auth.uid() is not null and public.rfq_pilot_session_id() is not null and exists (
    select 1 from auth.sessions a
      where a.id = public.rfq_pilot_session_id() and a.user_id = auth.uid()
  );
$$;

-- The operator must seed license_until and seat_limit after independently
-- validating the RFQ2 signature/store ID. Clients cannot write these columns.
create function public.rfq_pilot_license_current(p_store uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.rfq_pilot_stores
    where id = p_store and enabled and license_until > now());
$$;

create function public.rfq_pilot_is_owner(p_store uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select public.rfq_pilot_live_session() and exists (
    select 1 from public.rfq_pilot_members m join public.rfq_pilot_stores s on s.id = m.store_id
    where m.store_id = p_store and m.user_id = auth.uid()
      and m.role = 'owner' and m.active and s.enabled
  );
$$;

create function public.rfq_pilot_worker_active(p_store uuid, p_worker uuid, p_device uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select auth.uid() = p_worker and public.rfq_pilot_live_session() and exists (
    select 1 from public.rfq_pilot_worker_leases l
    join public.rfq_pilot_members m on (m.store_id, m.user_id) = (l.store_id, l.user_id)
    join public.rfq_pilot_stores s on s.id = l.store_id
    join public.rfq_pilot_devices d on (d.store_id, d.id) = (l.store_id, l.device_id)
    where l.store_id = p_store and l.user_id = p_worker
      and l.device_id = p_device and l.session_id = public.rfq_pilot_session_id()
      and l.lease_until > now() and m.active and m.role = 'worker'
      and s.enabled and s.license_until > now()
      and d.status = 'approved' and d.user_id = p_worker
      and d.kind in ('cashier_phone', 'web')
  );
$$;

create policy rfq_pilot_stores_read on public.rfq_pilot_stores for select to authenticated
using ((select public.rfq_pilot_live_session()) and exists (select 1 from public.rfq_pilot_members m
  where m.store_id = id and m.user_id = (select auth.uid()) and m.active));
create policy rfq_pilot_members_read on public.rfq_pilot_members for select to authenticated
using ((select public.rfq_pilot_live_session()) and
  (user_id = (select auth.uid()) or (select public.rfq_pilot_is_owner(store_id))));
create policy rfq_pilot_devices_read on public.rfq_pilot_devices for select to authenticated
using ((select public.rfq_pilot_live_session()) and
  (user_id = (select auth.uid()) or (select public.rfq_pilot_is_owner(store_id))));
create policy rfq_pilot_requests_read on public.rfq_pilot_shift_requests for select to authenticated
using ((select public.rfq_pilot_is_owner(store_id)) or
  (worker_id = (select auth.uid()) and (select public.rfq_pilot_worker_active(store_id, worker_id, cashier_device_id))));
create policy rfq_pilot_shifts_owner_read on public.rfq_pilot_shifts for select to authenticated
using ((select public.rfq_pilot_is_owner(store_id)));
-- Workers get no direct financial/shift/lease table access. Narrow RPC returns only shift ID.
grant select on public.rfq_pilot_stores, public.rfq_pilot_members, public.rfq_pilot_devices,
  public.rfq_pilot_shift_requests, public.rfq_pilot_shifts to authenticated;

create function public.rfq_pilot_request_device(p_store uuid, p_device uuid, p_kind text) returns text
language plpgsql security definer set search_path = '' as $$
declare v_role text; v_existing public.rfq_pilot_devices%rowtype;
begin
  if not public.rfq_pilot_live_session() or p_device is null or p_kind not in ('owner_phone','cashier_phone','web') then
    raise exception 'invalid_device_request';
  end if;
  select m.role into v_role from public.rfq_pilot_members m
    join public.rfq_pilot_stores s on s.id = m.store_id
    where m.store_id = p_store and m.user_id = auth.uid() and m.active
      and s.enabled and s.license_until > now();
  if v_role is null or (v_role = 'worker' and p_kind = 'owner_phone') then
    raise exception 'membership_required';
  end if;
  select * into v_existing from public.rfq_pilot_devices
    where store_id = p_store and id = p_device;
  if found then
    if v_existing.user_id <> auth.uid() or v_existing.kind <> p_kind or v_existing.status = 'revoked' then
      raise exception 'device_not_available';
    end if;
    return v_existing.status;
  end if;
  insert into public.rfq_pilot_devices(store_id,id,user_id,kind)
    values (p_store,p_device,auth.uid(),p_kind);
  return 'pending';
end $$;

create function public.rfq_pilot_approve_device(p_store uuid, p_device uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_seats integer; v_count integer;
begin
  if not public.rfq_pilot_is_owner(p_store) then raise exception 'owner_required'; end if;
  if not public.rfq_pilot_license_current(p_store) then raise exception 'license_expired'; end if;
  -- Serializes competing approvals so the seat limit cannot be oversubscribed.
  select seat_limit into v_seats from public.rfq_pilot_stores where id = p_store for update;
  select count(*) into v_count from public.rfq_pilot_devices where store_id = p_store and status = 'approved';
  if v_count >= v_seats then raise exception 'device_limit_reached'; end if;
  update public.rfq_pilot_devices set status = 'approved', approved_by = auth.uid(), approved_at = now()
    where store_id = p_store and id = p_device and status = 'pending';
  if not found then raise exception 'pending_device_required'; end if;
end $$;

create function public.rfq_pilot_revoke_device(p_store uuid, p_device uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.rfq_pilot_is_owner(p_store) then raise exception 'owner_required'; end if;
  perform 1 from public.rfq_pilot_stores where id = p_store for update;
  update public.rfq_pilot_devices set status = 'revoked', approved_by = null, approved_at = null
    where store_id = p_store and id = p_device and status <> 'revoked';
  if not found then raise exception 'active_device_required'; end if;
  -- Fail closed even for a still-valid JWT, and release its seat immediately.
  insert into public.rfq_pilot_denied_sessions(store_id,user_id,session_id)
    select store_id,user_id,session_id from public.rfq_pilot_worker_leases
    where store_id = p_store and device_id = p_device on conflict do nothing;
  delete from public.rfq_pilot_worker_leases where store_id = p_store and device_id = p_device;
end $$;

create function public.rfq_pilot_claim_worker(p_store uuid, p_device uuid) returns timestamptz
language plpgsql security definer set search_path = '' as $$
declare v_session uuid; v_old public.rfq_pilot_worker_leases%rowtype; v_until timestamptz;
begin
  v_session := public.rfq_pilot_session_id();
  if v_session is null or not public.rfq_pilot_live_session() then raise exception 'authenticated_session_required'; end if;
  if not exists (select 1 from public.rfq_pilot_members m join public.rfq_pilot_stores s on s.id = m.store_id
    where m.store_id = p_store and m.user_id = auth.uid() and m.role = 'worker' and m.active
      and s.enabled and s.license_until > now())
    or not exists (select 1 from public.rfq_pilot_devices d
      where d.store_id = p_store and d.id = p_device and d.user_id = auth.uid()
        and d.status = 'approved' and d.kind in ('cashier_phone', 'web'))
    or exists (select 1 from public.rfq_pilot_denied_sessions
      where store_id = p_store and user_id = auth.uid() and session_id = v_session) then
    raise exception 'worker_device_or_session_denied';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_store::text || ':' || auth.uid()::text, 0));
  select * into v_old from public.rfq_pilot_worker_leases
    where store_id = p_store and user_id = auth.uid() for update;
  if found and v_old.lease_until > now()
    and (v_old.session_id <> v_session or v_old.device_id <> p_device) then
    raise exception 'worker_session_already_active';
  end if;
  v_until := now() + interval '2 minutes';
  insert into public.rfq_pilot_worker_leases(store_id,user_id,device_id,session_id,lease_until)
    values (p_store,auth.uid(),p_device,v_session,v_until)
    on conflict (store_id,user_id) do update
      set device_id = excluded.device_id, session_id = excluded.session_id,
          lease_until = excluded.lease_until, updated_at = now();
  return v_until;
end $$;

create function public.rfq_pilot_heartbeat(p_store uuid, p_device uuid) returns timestamptz
language plpgsql security definer set search_path = '' as $$
declare v_until timestamptz;
begin
  update public.rfq_pilot_worker_leases l set lease_until = now() + interval '2 minutes', updated_at = now()
    where l.store_id = p_store and l.user_id = auth.uid() and l.device_id = p_device
      and l.session_id = public.rfq_pilot_session_id() and l.lease_until > now()
      and public.rfq_pilot_worker_active(p_store, auth.uid(), p_device)
    returning lease_until into v_until;
  if not found then raise exception 'worker_session_expired'; end if;
  return v_until;
end $$;

create function public.rfq_pilot_revoke_worker(p_store uuid, p_worker uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_old public.rfq_pilot_worker_leases%rowtype;
begin
  if not public.rfq_pilot_is_owner(p_store) then raise exception 'owner_required'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_store::text || ':' || p_worker::text, 0));
  select * into v_old from public.rfq_pilot_worker_leases
    where store_id = p_store and user_id = p_worker for update;
  if found then
    insert into public.rfq_pilot_denied_sessions(store_id,user_id,session_id)
      values (p_store,p_worker,v_old.session_id) on conflict do nothing;
    delete from public.rfq_pilot_worker_leases
      where store_id = p_store and user_id = p_worker;
  end if;
end $$;

create function public.rfq_pilot_request_shift(p_store uuid, p_device uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if not public.rfq_pilot_worker_active(p_store, auth.uid(), p_device)
    or not exists (select 1 from public.rfq_pilot_devices
      where store_id = p_store and id = p_device and kind in ('cashier_phone', 'web')) then
    raise exception 'approved_cashier_session_required';
  end if;
  insert into public.rfq_pilot_shift_requests(store_id,worker_id,cashier_device_id)
    values (p_store,auth.uid(),p_device) returning id into v_id;
  return v_id;
end $$;

create function public.rfq_pilot_approve_shift(p_request uuid, p_opening_cents bigint) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_request public.rfq_pilot_shift_requests%rowtype; v_shift uuid;
begin
  if p_opening_cents is null or p_opening_cents < 0 then raise exception 'invalid_opening_balance'; end if;
  select * into v_request from public.rfq_pilot_shift_requests where id = p_request for update;
  if not found or v_request.status <> 'pending'
    or not public.rfq_pilot_is_owner(v_request.store_id)
    or not public.rfq_pilot_license_current(v_request.store_id)
    or not exists (select 1 from public.rfq_pilot_members m
      where m.store_id = v_request.store_id and m.user_id = v_request.worker_id and m.active and m.role = 'worker')
    or not exists (select 1 from public.rfq_pilot_devices d
      where d.store_id = v_request.store_id and d.id = v_request.cashier_device_id
        and d.status = 'approved' and d.kind in ('cashier_phone', 'web')) then
    raise exception 'owner_and_pending_request_required';
  end if;
  insert into public.rfq_pilot_shifts(store_id,worker_id,cashier_device_id,approved_by,opening_cents)
    values (v_request.store_id,v_request.worker_id,v_request.cashier_device_id,auth.uid(),p_opening_cents)
    returning id into v_shift;
  update public.rfq_pilot_shift_requests set status = 'approved', approved_by = auth.uid() where id = p_request;
  return v_shift;
end $$;

create function public.rfq_pilot_my_open_shift(p_store uuid, p_device uuid) returns uuid
language plpgsql stable security definer set search_path = '' as $$
declare v_id uuid;
begin
  if not public.rfq_pilot_worker_active(p_store, auth.uid(), p_device) then return null; end if;
  select id into v_id from public.rfq_pilot_shifts
    where store_id = p_store and worker_id = auth.uid() and cashier_device_id = p_device and status = 'open';
  return v_id;
end $$;

-- Test hook only. Real sales MUST validate invoice lines, stock, customer/debt,
-- and transactional cash ledger server-side before replacing this function.
create function public.rfq_pilot_test_sale(p_shift uuid, p_device uuid,
  p_event uuid, p_total_cents bigint, p_paid_cents bigint) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_shift public.rfq_pilot_shifts%rowtype; v_old public.rfq_pilot_sale_auth_tests%rowtype;
begin
  if p_event is null or p_total_cents is null or p_paid_cents is null
    or p_total_cents < 0 or p_paid_cents < 0 or p_paid_cents > p_total_cents then
    raise exception 'invalid_test_sale';
  end if;
  select * into v_shift from public.rfq_pilot_shifts where id = p_shift for update;
  if not found or v_shift.status <> 'open' or v_shift.cashier_device_id <> p_device
    or not public.rfq_pilot_worker_active(v_shift.store_id, v_shift.worker_id, p_device) then
    raise exception 'approved_open_shift_required';
  end if;
  select * into v_old from public.rfq_pilot_sale_auth_tests where id = p_event;
  if found then
    if v_old.shift_id <> p_shift or v_old.cashier_device_id <> p_device
      or v_old.total_cents <> p_total_cents or v_old.paid_cents <> p_paid_cents then
      raise exception 'idempotency_event_conflict';
    end if;
    return v_old.id;
  end if;
  insert into public.rfq_pilot_sale_auth_tests(id,store_id,shift_id,worker_id,cashier_device_id,total_cents,paid_cents)
    values (p_event,v_shift.store_id,p_shift,v_shift.worker_id,p_device,p_total_cents,p_paid_cents);
  return p_event;
end $$;

-- The pilot report includes opening cash and these *test* cash receipts only;
-- real closeout also needs debt collections, returns, expenses, and cash-outs.
create function public.rfq_pilot_close_shift(p_shift uuid, p_counted_cents bigint) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_shift public.rfq_pilot_shifts%rowtype; v_cash bigint; v_total bigint; v_due bigint;
begin
  if p_counted_cents is null or p_counted_cents < 0 then raise exception 'invalid_count'; end if;
  select * into v_shift from public.rfq_pilot_shifts where id = p_shift for update;
  if not found or v_shift.status <> 'open' or not public.rfq_pilot_is_owner(v_shift.store_id) then
    raise exception 'owner_and_open_shift_required';
  end if;
  select coalesce(sum(paid_cents),0),coalesce(sum(total_cents),0),
    coalesce(sum(total_cents - paid_cents),0) into v_cash,v_total,v_due
    from public.rfq_pilot_sale_auth_tests where shift_id = p_shift;
  update public.rfq_pilot_shifts
    set status = 'closed',closed_at = now(), counted_cents = p_counted_cents,
      expected_cents = opening_cents + v_cash,
      difference_cents = p_counted_cents - opening_cents - v_cash
    where id = p_shift;
  return jsonb_build_object('shift_id',p_shift,'opening_cents',v_shift.opening_cents,
    'test_sales_total_cents',v_total,'test_due_cents',v_due,
    'test_cash_cents',v_cash,'expected_cents',v_shift.opening_cents + v_cash,
    'counted_cents',p_counted_cents,
    'difference_cents',p_counted_cents - v_shift.opening_cents - v_cash,
    'warning','PILOT AUTH TEST ONLY: not an accounting report');
end $$;

-- PostgreSQL grants function execution to PUBLIC by default: remove it before
-- exposing only the intended RPCs to signed-in clients.
do $$
declare f record;
begin
  for f in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like 'rfq_pilot_%'
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f.signature);
    execute format('grant execute on function %s to authenticated', f.signature);
  end loop;
end $$;
