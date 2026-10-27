-- ONE-TIME TEST PROJECT UPGRADE (2026-10-16); SQL Editor only.
-- Preconditions: pilot 00100+00200 installed; original 00300 NOT applied.
-- Never run the installer again; never run this upgrade twice.
-- READ BEFORE APPLYING: no Room import, no production publication, no SMS/Push.
-- Contents: incremental 00300 shift decisions + 00400 financial/read/owner feed.
-- Entire upgrade shares ONE PostgreSQL transaction; any SQL failure rolls back both.
-- The app also requires a matching new Android APK (not yet built/tested).
begin;

-- BEGIN incremental source 20261016000300_original_cash_shift_decision.sql
-- Rafiq TEST PROJECT ONLY — incremental shift-decision upgrade, NOT the installer.
-- Before running in Supabase SQL Editor, verify the correct test project and
-- that the previously approved single-file pilot schema was installed already.
-- Paste THIS ENTIRE FILE once, in one SQL Editor run. No passwords/API keys here.
-- No Room data is read, moved, cleared, or synchronized by this migration.
-- It does not make the original POS, debts or cash ledger cloud-connected.
-- 'rejected' is an owner's audited decision, distinct from legacy 'canceled'.

do $rfq_preflight$
begin
  if to_regclass('public.rfq_pilot_shift_requests') is null or
     to_regprocedure('public.rfq_pilot_request_shift(uuid,uuid)') is null or
     to_regprocedure('public.rfq_pilot_approve_shift(uuid,bigint)') is null or
     to_regprocedure('public.rfq_pilot_close_shift(uuid,bigint)') is null then
    raise exception 'pilot_shift_schema_missing_do_not_rerun_installer';
  end if;
end $rfq_preflight$;

alter table public.rfq_pilot_shift_requests
  drop constraint rfq_pilot_shift_requests_status_check;
alter table public.rfq_pilot_shift_requests
  add constraint rfq_pilot_shift_requests_status_check
  check (status in ('pending','approved','canceled','rejected'));
alter table public.rfq_pilot_shift_requests
  add column rejected_by uuid references auth.users(id),
  add column rejected_at timestamptz;

-- Opening/counting values are in cents; cap test inputs to 999,999,999 YER
-- even if an untrusted client bypasses the UI. Existing rows are CHECKed;
-- any out-of-range historical row aborts this entire transaction, without edits.
alter table public.rfq_pilot_shifts add constraint rfq_pilot_original_opening_limit
  check (opening_cents between 0 and 99999999900);
alter table public.rfq_pilot_shifts add constraint rfq_pilot_original_counted_limit
  check (counted_cents is null or counted_cents between 0 and 99999999900);

-- Same RPC signature as the installed pilot: duplicate taps return the same
-- pending ID, never a second request. One worker cannot request while already
-- open, or silently switch an existing request to a different device.
create or replace function public.rfq_pilot_request_shift(p_store uuid, p_device uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_device uuid;
begin
  if not public.rfq_pilot_worker_active(p_store, auth.uid(), p_device)
    or not exists (select 1 from public.rfq_pilot_devices
      where store_id = p_store and id = p_device and kind in ('cashier_phone', 'web')) then
    raise exception 'approved_cashier_session_required';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_store::text || ':shift-request:' || auth.uid()::text, 0));
  if exists (select 1 from public.rfq_pilot_shifts
    where store_id = p_store and worker_id = auth.uid() and status = 'open') then
    raise exception 'open_shift_already_exists';
  end if;
  select id, cashier_device_id into v_id,v_device from public.rfq_pilot_shift_requests
    where store_id = p_store and worker_id = auth.uid() and status = 'pending';
  if v_id is not null then
    if v_device <> p_device then raise exception 'pending_shift_on_other_device'; end if;
    return v_id;
  end if;
  insert into public.rfq_pilot_shift_requests(store_id,worker_id,cashier_device_id)
    values (p_store,auth.uid(),p_device) returning id into v_id;
  return v_id;
end $$;

-- SECURITY DEFINER is intentional: authenticated clients cannot UPDATE the
-- guarded table directly. The row lock serializes approval versus rejection.
-- A rejected request creates NO shift. Historical decisions cannot be edited.
create function public.rfq_pilot_reject_shift(p_request uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_request public.rfq_pilot_shift_requests%rowtype;
begin
  select * into v_request from public.rfq_pilot_shift_requests where id = p_request for update;
  if not found or v_request.status <> 'pending' or
     not public.rfq_pilot_is_owner(v_request.store_id) then
    raise exception 'owner_and_pending_request_required';
  end if;
  update public.rfq_pilot_shift_requests
    set status = 'rejected', rejected_by = auth.uid(), rejected_at = now()
    where id = p_request and status = 'pending';
  if not found then raise exception 'owner_and_pending_request_required'; end if;
end $$;

-- PostgreSQL grants EXECUTE to PUBLIC by default, so revoke it immediately.
revoke all on function public.rfq_pilot_reject_shift(uuid) from public, anon, authenticated;
grant execute on function public.rfq_pilot_reject_shift(uuid) to authenticated;
revoke all on function public.rfq_pilot_request_shift(uuid,uuid) from public, anon, authenticated;
grant execute on function public.rfq_pilot_request_shift(uuid,uuid) to authenticated;
-- END incremental source 20261016000300_original_cash_shift_decision.sql

-- BEGIN incremental source 20261016000400_original_finance_and_owner_events.sql
-- TEST PROJECT ONLY. Incremental AFTER 00100, 00200, 00300 (no installer/Room import).
-- Server is the sole authority for cash, goods, debt and owner event history.
-- Owner-only cash advance is intentionally NOT a worker permission or an invoice.
-- An event history is NOT a push notification or proof of an SMS dispatch.

do $preflight$ begin
  if to_regprocedure('public.rfq_pilot_reject_shift(uuid)') is null or
     to_regprocedure('public.rfq_pilot_post_invoice(uuid,uuid,uuid,uuid,jsonb,bigint,boolean)') is null or
     to_regclass('public.rfq_pilot_cash_entries') is null then
    raise exception 'pilot_finance_schema_missing_do_not_rerun_installer';
  end if;
end $preflight$;

-- Keep the signs explicit. A cash advance is a positive customer liability and
-- a negative till movement, with one event UUID connecting both in one RPC.
alter table public.rfq_pilot_debt_entries drop constraint rfq_pilot_debt_entries_kind_check;
alter table public.rfq_pilot_debt_entries add constraint rfq_pilot_debt_entries_kind_check
  check (kind in ('invoice_due','collection','owner_debit','cash_advance'));
alter table public.rfq_pilot_debt_entries drop constraint rfq_pilot_debt_entries_check;
alter table public.rfq_pilot_debt_entries add constraint rfq_pilot_debt_entries_check
  check ((kind='collection' and amount_cents<0) or
    (kind in ('invoice_due','owner_debit','cash_advance') and amount_cents>0));
alter table public.rfq_pilot_cash_entries drop constraint rfq_pilot_cash_entries_kind_check;
alter table public.rfq_pilot_cash_entries add constraint rfq_pilot_cash_entries_kind_check
  check (kind in ('sale','collection','income','expense','withdraw','cash_advance'));
alter table public.rfq_pilot_cash_entries drop constraint rfq_pilot_cash_entries_check;
alter table public.rfq_pilot_cash_entries add constraint rfq_pilot_cash_entries_check
  check ((kind in ('sale','collection','income') and amount_cents>0) or
    (kind in ('expense','withdraw','cash_advance') and amount_cents<0));
create unique index rfq_pilot_one_cash_advance_per_debt
  on public.rfq_pilot_cash_entries(reference_id) where kind='cash_advance';

-- All financial writers in 00200 lock the shift FOR UPDATE before inserting a
-- cash movement. Defend every negative movement, not just the new advance.
create function public.rfq_pilot_guard_till() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_opening bigint; v_cash bigint;
begin
  if new.amount_cents < 0 then
    select opening_cents into v_opening from public.rfq_pilot_shifts
      where id=new.shift_id and store_id=new.store_id and status='open';
    if not found then raise exception 'approved_open_shift_required'; end if;
    select coalesce(sum(amount_cents),0) into v_cash from public.rfq_pilot_cash_entries
      where store_id=new.store_id and shift_id=new.shift_id;
    if v_opening+v_cash+new.amount_cents<0 then raise exception 'insufficient_till_cash'; end if;
  end if;
  return new;
end $$;
create trigger rfq_pilot_cash_never_negative before insert on public.rfq_pilot_cash_entries
  for each row execute function public.rfq_pilot_guard_till();

create function public.rfq_pilot_cash_advance(p_shift uuid,p_event uuid,
  p_customer uuid,p_amount_cents bigint,p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_shift public.rfq_pilot_shifts%rowtype;
  v_old public.rfq_pilot_debt_entries%rowtype;
  v_cash public.rfq_pilot_cash_entries%rowtype;
  v_balance bigint; v_till bigint; v_reason text;
begin
  if p_event is null or p_customer is null or p_shift is null or
     p_amount_cents is null or p_amount_cents not between 1 and 99999999900 then
    raise exception 'invalid_cash_advance';
  end if;
  v_reason:=btrim(coalesce(p_reason,''));
  if char_length(v_reason) not between 3 and 200 then raise exception 'invalid_cash_advance'; end if;
  select * into v_shift from public.rfq_pilot_shifts where id=p_shift for update;
  if not found or not public.rfq_pilot_is_owner(v_shift.store_id) then
    raise exception 'owner_required_for_cash_advance'; end if;
  perform 1 from public.rfq_pilot_customers where store_id=v_shift.store_id and id=p_customer for update;
  if not found then raise exception 'customer_not_found'; end if;
  select * into v_old from public.rfq_pilot_debt_entries where id=p_event;
  if found then
    select * into v_cash from public.rfq_pilot_cash_entries
      where kind='cash_advance' and reference_id=p_event;
    if v_old.store_id<>v_shift.store_id or v_old.customer_id<>p_customer or
       v_old.kind<>'cash_advance' or v_old.amount_cents<>p_amount_cents or
       v_old.actor_id<>auth.uid() or v_old.note<>v_reason or
       v_cash.store_id is null or v_cash.shift_id<>p_shift or
       v_cash.amount_cents<>-p_amount_cents or v_cash.reason<>v_reason or
       v_cash.actor_id<>auth.uid() then
      raise exception 'idempotency_event_conflict';
    end if;
  else
    if v_shift.status<>'open' or not public.rfq_pilot_license_current(v_shift.store_id) or
       not exists(select 1 from public.rfq_pilot_customers
         where store_id=v_shift.store_id and id=p_customer and active) then
      raise exception 'active_owner_open_shift_required'; end if;
    -- Guard above is defense in depth; a second check here explains the failure.
    select v_shift.opening_cents+coalesce(sum(amount_cents),0) into v_till
      from public.rfq_pilot_cash_entries where shift_id=p_shift;
    if v_till < p_amount_cents then raise exception 'insufficient_till_cash'; end if;
    insert into public.rfq_pilot_debt_entries(id,store_id,customer_id,kind,amount_cents,actor_id,note)
      values(p_event,v_shift.store_id,p_customer,'cash_advance',p_amount_cents,auth.uid(),v_reason);
    insert into public.rfq_pilot_cash_entries(id,store_id,shift_id,kind,amount_cents,actor_id,reference_id,reason)
      values(gen_random_uuid(),v_shift.store_id,p_shift,'cash_advance',-p_amount_cents,auth.uid(),p_event,v_reason);
  end if;
  select coalesce(sum(amount_cents),0) into v_balance from public.rfq_pilot_debt_entries
    where store_id=v_shift.store_id and customer_id=p_customer;
  select v_shift.opening_cents+coalesce(sum(amount_cents),0) into v_till
    from public.rfq_pilot_cash_entries where shift_id=p_shift;
  return jsonb_build_object('event_id',p_event,'customer_balance_cents',v_balance,
    'till_cents',v_till,'already_committed',v_old.id is not null);
end $$;

-- One server calculation for the original cash screen on either handset.
create function public.rfq_pilot_shift_cash_snapshot(p_shift uuid,p_device uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_shift public.rfq_pilot_shifts%rowtype; v_sum bigint; v_sales bigint;
  v_collections bigint; v_advance bigint; v_other bigint; v_rows jsonb;
begin
  select * into v_shift from public.rfq_pilot_shifts where id=p_shift;
  if not found or not (public.rfq_pilot_is_owner(v_shift.store_id) or
    (v_shift.worker_id=auth.uid() and v_shift.cashier_device_id=p_device and
     public.rfq_pilot_worker_active(v_shift.store_id,auth.uid(),p_device))) then
    raise exception 'authorized_shift_required'; end if;
  select coalesce(sum(amount_cents),0),
    coalesce(sum(amount_cents) filter(where kind='sale'),0),
    coalesce(sum(amount_cents) filter(where kind='collection'),0),
    coalesce(sum(amount_cents) filter(where kind='cash_advance'),0),
    coalesce(sum(amount_cents) filter(where kind in ('income','expense','withdraw')),0)
    into v_sum,v_sales,v_collections,v_advance,v_other
    from public.rfq_pilot_cash_entries where store_id=v_shift.store_id and shift_id=p_shift;
  select coalesce(jsonb_agg(jsonb_build_object('id',e.id,'kind',e.kind,
    'amount_cents',e.amount_cents,'reason',e.reason,'created_at',e.created_at)
    order by e.created_at desc,e.id desc),'[]'::jsonb) into v_rows from (
      select id,kind,amount_cents,reason,created_at from public.rfq_pilot_cash_entries
      where store_id=v_shift.store_id and shift_id=p_shift
      order by created_at desc,id desc limit 60) e;
  return jsonb_build_object('shift_id',p_shift,'status',v_shift.status,
    'opening_cents',v_shift.opening_cents,'sale_cents',v_sales,
    'collection_cents',v_collections,'cash_advance_cents',v_advance,
    'other_net_cents',v_other,'expected_cents',v_shift.opening_cents+v_sum,
    'entries',v_rows,'shown_limit',60);
end $$;

-- No assumption about how partial payments settle an invoice versus an advance.
create function public.rfq_pilot_customer_statement(p_store uuid,p_device uuid,p_customer uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_c public.rfq_pilot_customers%rowtype; v_balance bigint;
  v_rows jsonb; v_count bigint;
begin
  if not (public.rfq_pilot_is_owner(p_store) or
    public.rfq_pilot_worker_active(p_store,auth.uid(),p_device)) then
    raise exception 'authorized_session_required'; end if;
  select * into v_c from public.rfq_pilot_customers where store_id=p_store and id=p_customer;
  if not found then raise exception 'customer_not_found'; end if;
  select coalesce(sum(amount_cents),0),count(*) into v_balance,v_count
    from public.rfq_pilot_debt_entries where store_id=p_store and customer_id=p_customer;
  select coalesce(jsonb_agg(jsonb_build_object('id',e.id,'kind',e.kind,
    'amount_cents',e.amount_cents,'invoice_id',e.invoice_id,'note',e.note,
    'created_at',e.created_at) order by e.created_at desc,e.id desc),'[]'::jsonb)
    into v_rows from (select id,kind,amount_cents,invoice_id,note,created_at
      from public.rfq_pilot_debt_entries where store_id=p_store and customer_id=p_customer
      order by created_at desc,id desc limit 150) e;
  return jsonb_build_object('customer_id',p_customer,'customer_name',v_c.name,
    'balance_cents',v_balance,'entries',v_rows,'entry_count',v_count,'shown_limit',150);
end $$;

create function public.rfq_pilot_customer_overview(p_store uuid,p_device uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_total bigint; v_count bigint; v_rows jsonb;
begin
  if not (public.rfq_pilot_is_owner(p_store) or
     public.rfq_pilot_worker_active(p_store,auth.uid(),p_device)) then
    raise exception 'authorized_session_required'; end if;
  select coalesce(sum(amount_cents),0) into v_total from public.rfq_pilot_debt_entries
    where store_id=p_store;
  select count(*) into v_count from public.rfq_pilot_customers where store_id=p_store and active;
  select coalesce(jsonb_agg(jsonb_build_object('id',c.id,'name',c.name,'phone',c.phone,
    'balance_cents',c.balance) order by c.name,c.id),'[]'::jsonb) into v_rows from (
     select c.id,c.name,c.phone,coalesce(sum(d.amount_cents),0) as balance
     from public.rfq_pilot_customers c left join public.rfq_pilot_debt_entries d
       on d.store_id=c.store_id and d.customer_id=c.id
     where c.store_id=p_store and c.active
     group by c.id,c.name,c.phone order by c.name,c.id limit 300) c;
  return jsonb_build_object('outstanding_cents',v_total,'customer_count',v_count,
    'customers',v_rows,'shown_limit',300);
end $$;

-- The old product-creation RPC generates a fresh UUID on every retry. For the
-- original Android owner screen, accept a client-generated idempotency UUID
-- instead; stock still starts at zero and only adjust_stock may change it.
create function public.rfq_pilot_create_product_once(p_store uuid,p_id uuid,p_name text,
  p_barcode text,p_unit text,p_price_cents bigint,p_cost_cents bigint) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_old public.rfq_pilot_products%rowtype;
  v_name text; v_barcode text; v_unit text;
begin
  if not public.rfq_pilot_is_owner(p_store) then raise exception 'owner_required'; end if;
  v_name:=btrim(coalesce(p_name,''));v_barcode:=nullif(btrim(coalesce(p_barcode,'')),'');
  v_unit:=btrim(coalesce(p_unit,''));
  if p_id is null or char_length(v_name) not between 1 and 120 or
     (v_barcode is not null and char_length(v_barcode)>80) or
     char_length(v_unit) not between 1 and 30 or
     p_price_cents is null or p_price_cents not between 0 and 1000000000 or
     p_cost_cents is null or p_cost_cents not between 0 and 1000000000 then
    raise exception 'invalid_product';end if;
  select * into v_old from public.rfq_pilot_products where id=p_id;
  if found then
    if v_old.store_id<>p_store or v_old.name<>v_name or
       v_old.barcode is distinct from v_barcode or v_old.unit<>v_unit or
       v_old.price_cents<>p_price_cents or v_old.cost_cents<>p_cost_cents then
      raise exception 'idempotency_event_conflict';end if;
    return p_id;
  end if;
  if not public.rfq_pilot_license_current(p_store) then raise exception 'active_owner_license_required';end if;
  insert into public.rfq_pilot_products(id,store_id,name,barcode,unit,price_cents,cost_cents,stock_milli)
    values(p_id,p_store,v_name,v_barcode,v_unit,p_price_cents,p_cost_cents,0);
  return p_id;
end $$;

-- The original Android POS must never confirm a different server price than
-- the price reviewed by the cashier. The installed Pilot RPC in 00200 remains
-- available for legacy TEST clients. This checked entry point serializes in the
-- SAME order (shift, then products by UUID), holds all locks through the original
-- posting RPC, and does not create a second invoice/payment implementation.
-- The quoted unit prices become part of request_json for strict UUID retries.
create function public.rfq_pilot_post_invoice_checked(p_shift uuid,p_device uuid,p_invoice uuid,
  p_customer uuid,p_lines jsonb,p_cash_cents bigint,p_sms_consent boolean,
  p_quoted_total_cents bigint) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_shift public.rfq_pilot_shifts%rowtype;
  v_old public.rfq_pilot_invoices%rowtype;
  v_product public.rfq_pilot_products%rowtype;
  v_item jsonb; v_id uuid; v_qty bigint; v_price bigint;
  v_total bigint:=0; v_result jsonb;
begin
  if p_invoice is null or p_shift is null or p_device is null or
     p_quoted_total_cents is null or p_quoted_total_cents not between 0 and 100000000000 or
     p_lines is null or jsonb_typeof(p_lines)<>'array' or
     jsonb_array_length(p_lines) not between 1 and 100 then
    raise exception 'invalid_invoice_quote';
  end if;
  select * into v_shift from public.rfq_pilot_shifts where id=p_shift for update;
  if not found or v_shift.cashier_device_id<>p_device or
     not public.rfq_pilot_worker_active(v_shift.store_id,v_shift.worker_id,p_device) then
    raise exception 'approved_open_shift_required';
  end if;
  -- Idempotency wins over later price/stock changes and even a closed shift.
  -- The underlying RPC still verifies actor, device, shift and request_json.
  select * into v_old from public.rfq_pilot_invoices where id=p_invoice;
  if found then
    if v_old.total_cents<>p_quoted_total_cents then
      raise exception 'idempotency_event_conflict'; end if;
    return public.rfq_pilot_post_invoice(p_shift,p_device,p_invoice,p_customer,
      p_lines,p_cash_cents,p_sms_consent);
  end if;
  if v_shift.status<>'open' then raise exception 'approved_open_shift_required'; end if;
  for v_item in select x.value from jsonb_array_elements(p_lines) x(value)
    order by x.value->>'product_id'
  loop
    if jsonb_typeof(v_item)<>'object' or
       (v_item->>'product_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' or
       (v_item->>'qty_milli') !~ '^[0-9]{1,10}$' or
       not (v_item ? 'quoted_price_cents') or
       jsonb_typeof(v_item->'quoted_price_cents')<>'number' or
       (v_item->>'quoted_price_cents') !~ '^(0|[1-9][0-9]{0,9})$' then
      raise exception 'invalid_invoice_quote'; end if;
    v_id:=(v_item->>'product_id')::uuid;
    v_qty:=(v_item->>'qty_milli')::bigint;
    v_price:=(v_item->>'quoted_price_cents')::bigint;
    if v_qty not between 1 and 1000000 or v_price>1000000000 then
      raise exception 'invalid_invoice_quote'; end if;
    select * into v_product from public.rfq_pilot_products
      where store_id=v_shift.store_id and id=v_id and active for update;
    if not found or v_product.stock_milli<v_qty then raise exception 'insufficient_stock'; end if;
    if v_product.price_cents<>v_price then raise exception 'price_changed_refresh_cart'; end if;
    v_total:=v_total+round(v_price::numeric*v_qty/1000)::bigint;
  end loop;
  if v_total<>p_quoted_total_cents then raise exception 'invalid_invoice_quote'; end if;
  v_result:=public.rfq_pilot_post_invoice(p_shift,p_device,p_invoice,p_customer,
    p_lines,p_cash_cents,p_sms_consent);
  if (v_result->>'total_cents')::bigint<>p_quoted_total_cents then
    raise exception 'invalid_invoice_quote'; end if;
  return v_result;
end $$;

-- Transactional audit feed for the owner. A foreground badge/sound is possible,
-- but there is deliberately NO claim that the phone receives background Push.
create table public.rfq_pilot_owner_events (
  id bigint generated always as identity primary key,
  store_id uuid not null references public.rfq_pilot_stores(id),
  topic text not null check (topic in ('device_requested','shift_requested','shift_approved',
    'shift_rejected','shift_closed','sale','collection','cash_advance',
    'cash_income','cash_expense','cash_withdraw','owner_debt')),
  reference_id uuid not null,
  amount_cents bigint,
  created_at timestamptz not null default now(),
  unique(store_id,topic,reference_id)
);
create index rfq_pilot_owner_events_store_latest on public.rfq_pilot_owner_events(store_id,id desc);
alter table public.rfq_pilot_owner_events enable row level security;
revoke all on public.rfq_pilot_owner_events from public,anon,authenticated;
create policy rfq_pilot_owner_events_read on public.rfq_pilot_owner_events
  for select to authenticated using ((select public.rfq_pilot_is_owner(store_id)));
grant select(id,store_id,topic,reference_id,amount_cents,created_at)
  on public.rfq_pilot_owner_events to authenticated;

create function public.rfq_pilot_record_owner_event() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_topic text; v_reference uuid; v_amount bigint;
begin
  if tg_table_name='rfq_pilot_shift_requests' then
    if tg_op='INSERT' and new.status='pending' then v_topic:='shift_requested';
    elsif tg_op='UPDATE' and new.status='approved' and old.status='pending' then v_topic:='shift_approved';
    elsif tg_op='UPDATE' and new.status='rejected' and old.status='pending' then v_topic:='shift_rejected'; end if;
    v_reference:=new.id;
  elsif tg_table_name='rfq_pilot_shifts' then
    if tg_op='UPDATE' and new.status='closed' and old.status='open' then
      v_topic:='shift_closed';v_amount:=new.difference_cents;end if;
    v_reference:=new.id;
  elsif tg_table_name='rfq_pilot_devices' then
    if tg_op='INSERT' and new.status='pending' then v_topic:='device_requested';end if;
    v_reference:=new.id;
  elsif tg_table_name='rfq_pilot_invoices' then
    v_topic:='sale';v_reference:=new.id;v_amount:=new.total_cents;
  elsif tg_table_name='rfq_pilot_cash_entries' then
    if new.kind in ('collection','cash_advance','income','expense','withdraw') then
      v_topic:=case when new.kind in ('income','expense','withdraw') then 'cash_'||new.kind else new.kind end;
      v_reference:=new.id;v_amount:=new.amount_cents;
    end if;
  elsif tg_table_name='rfq_pilot_debt_entries' then
    if new.kind='owner_debit' then v_topic:='owner_debt';
      v_reference:=new.id;v_amount:=new.amount_cents;end if;
  end if;
  if v_topic is not null then
    insert into public.rfq_pilot_owner_events(store_id,topic,reference_id,amount_cents)
      values(new.store_id,v_topic,v_reference,v_amount) on conflict do nothing;
  end if;
  return new;
end $$;
create trigger rfq_pilot_alert_request after insert or update of status on public.rfq_pilot_shift_requests
  for each row execute function public.rfq_pilot_record_owner_event();
create trigger rfq_pilot_alert_shift_close after update of status on public.rfq_pilot_shifts
  for each row execute function public.rfq_pilot_record_owner_event();
create trigger rfq_pilot_alert_device after insert on public.rfq_pilot_devices
  for each row execute function public.rfq_pilot_record_owner_event();
create trigger rfq_pilot_alert_invoice after insert on public.rfq_pilot_invoices
  for each row execute function public.rfq_pilot_record_owner_event();
create trigger rfq_pilot_alert_cash after insert on public.rfq_pilot_cash_entries
  for each row execute function public.rfq_pilot_record_owner_event();
create trigger rfq_pilot_alert_debt after insert on public.rfq_pilot_debt_entries
  for each row execute function public.rfq_pilot_record_owner_event();

-- Keep the 00200 summary contract; add separate cash-advance / manual debt totals.
create or replace function public.rfq_pilot_owner_summary(p_store uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_sales bigint; v_cash bigint; v_due bigint; v_cost numeric;
  v_debt bigint; v_adv bigint; v_manual bigint;
begin
  if not public.rfq_pilot_is_owner(p_store) then raise exception 'owner_required'; end if;
  select coalesce(sum(total_cents),0),coalesce(sum(cash_paid_cents),0),
    coalesce(sum(due_cents),0) into v_sales,v_cash,v_due
    from public.rfq_pilot_invoices where store_id=p_store;
  select coalesce(sum(cost_cents::numeric*qty_milli/1000),0) into v_cost
    from public.rfq_pilot_invoice_lines where store_id=p_store;
  select coalesce(sum(amount_cents),0),
    coalesce(sum(amount_cents) filter(where kind='cash_advance'),0),
    coalesce(sum(amount_cents) filter(where kind='owner_debit'),0)
    into v_debt,v_adv,v_manual from public.rfq_pilot_debt_entries where store_id=p_store;
  return jsonb_build_object('sales_cents',v_sales,'cash_received_on_sales_cents',v_cash,
    'new_credit_cents',v_due,'goods_credit_cents',v_due,
    'cash_advances_cents',v_adv,'manual_debt_cents',v_manual,
    'gross_margin_estimate_cents',v_sales-round(v_cost)::bigint,
    'outstanding_debt_cents',v_debt,
    'notice','Test scope: no returns, supplier costs/expenses, or taxes');
end $$;

-- A default PostgreSQL function grant is PUBLIC: revoke the newly created
-- definer functions/triggers, then grant only intended RPCs to authenticated.
do $grants$ declare f record; begin
  for f in select p.oid::regprocedure as signature from pg_proc p
    join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'
    and p.proname in ('rfq_pilot_guard_till','rfq_pilot_record_owner_event',
      'rfq_pilot_cash_advance','rfq_pilot_shift_cash_snapshot',
      'rfq_pilot_customer_statement','rfq_pilot_customer_overview',
      'rfq_pilot_create_product_once','rfq_pilot_post_invoice_checked')
  loop execute format('revoke all on function %s from public,anon,authenticated',f.signature); end loop;
end $grants$;
grant execute on function public.rfq_pilot_cash_advance(uuid,uuid,uuid,bigint,text),
  public.rfq_pilot_shift_cash_snapshot(uuid,uuid),
  public.rfq_pilot_customer_statement(uuid,uuid,uuid),
  public.rfq_pilot_customer_overview(uuid,uuid),
  public.rfq_pilot_create_product_once(uuid,uuid,text,text,text,bigint,bigint),
  public.rfq_pilot_post_invoice_checked(uuid,uuid,uuid,uuid,jsonb,bigint,boolean,bigint)
  to authenticated;
-- END incremental source 20261016000400_original_finance_and_owner_events.sql

commit;
