-- TEST PROJECT ONLY. Real central invoices/stock/debts/cash for new test data.
-- Requires 20261015000100_pilot_control_plane.sql. Not an old Room import.
-- No SMS dispatch, supplier purchasing, returns or PDF host is enabled.
-- Clients MUST use Auth + RLS + RPC; a local PIN is never server authorization.

create unique index rfq_pilot_shifts_store_id_uq on public.rfq_pilot_shifts(store_id,id);

create table public.rfq_pilot_products (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.rfq_pilot_stores(id),
  name text not null check (char_length(btrim(name)) between 1 and 120),
  barcode text check (barcode is null or char_length(barcode) between 1 and 80),
  unit text not null default 'حبة',
  price_cents bigint not null check (price_cents between 0 and 1000000000),
  cost_cents bigint not null check (cost_cents between 0 and 1000000000),
  stock_milli bigint not null default 0 check (stock_milli >= 0),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (store_id,id)
);
create index rfq_pilot_products_barcode_idx on public.rfq_pilot_products(store_id,barcode);

create table public.rfq_pilot_customers (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.rfq_pilot_stores(id),
  name text not null check (char_length(btrim(name)) between 1 and 120),
  phone text not null default '' check (char_length(phone) <= 30),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (store_id,id)
);
create index rfq_pilot_customers_name_idx on public.rfq_pilot_customers(store_id,name);

create table public.rfq_pilot_invoices (
  id uuid primary key,
  store_id uuid not null references public.rfq_pilot_stores(id),
  number bigint not null check (number > 0),
  shift_id uuid not null,
  worker_id uuid not null references auth.users(id),
  cashier_device_id uuid not null,
  customer_id uuid,
  subtotal_cents bigint not null check (subtotal_cents >= 0),
  discount_cents bigint not null check (discount_cents >= 0),
  total_cents bigint not null check (total_cents >= 0),
  cash_paid_cents bigint not null check (cash_paid_cents >= 0),
  due_cents bigint not null check (due_cents >= 0),
  request_json jsonb not null,
  sms_consent boolean not null default false,
  sms_consent_at timestamptz,
  created_at timestamptz not null default now(),
  unique (store_id,number),
  unique (store_id,id),
  foreign key (store_id,shift_id) references public.rfq_pilot_shifts(store_id,id),
  foreign key (store_id,customer_id) references public.rfq_pilot_customers(store_id,id),
  check (subtotal_cents >= discount_cents and total_cents = subtotal_cents - discount_cents),
  check (total_cents = cash_paid_cents + due_cents),
  check ((due_cents = 0 and customer_id is null) or (due_cents > 0 and customer_id is not null)),
  check (sms_consent = (sms_consent_at is not null))
);
create index rfq_pilot_invoices_customer_idx on public.rfq_pilot_invoices(store_id,customer_id,created_at desc);

create table public.rfq_pilot_invoice_lines (
  id bigint generated always as identity primary key,
  store_id uuid not null,
  invoice_id uuid not null,
  product_id uuid not null,
  name_snapshot text not null,
  barcode_snapshot text,
  unit_snapshot text not null,
  price_cents bigint not null check (price_cents >= 0),
  cost_cents bigint not null check (cost_cents >= 0),
  qty_milli bigint not null check (qty_milli > 0),
  line_total_cents bigint not null check (line_total_cents >= 0),
  foreign key (store_id,invoice_id) references public.rfq_pilot_invoices(store_id,id),
  foreign key (store_id,product_id) references public.rfq_pilot_products(store_id,id)
);
create index rfq_pilot_invoice_lines_invoice_idx on public.rfq_pilot_invoice_lines(store_id,invoice_id);

create table public.rfq_pilot_debt_entries (
  id uuid primary key,
  store_id uuid not null,
  customer_id uuid not null,
  invoice_id uuid,
  kind text not null check (kind in ('invoice_due','collection','owner_debit')),
  amount_cents bigint not null check (amount_cents <> 0),
  actor_id uuid not null references auth.users(id),
  note text not null default '',
  created_at timestamptz not null default now(),
  foreign key (store_id,customer_id) references public.rfq_pilot_customers(store_id,id),
  foreign key (store_id,invoice_id) references public.rfq_pilot_invoices(store_id,id),
  check ((kind = 'collection' and amount_cents < 0) or
    (kind in ('invoice_due','owner_debit') and amount_cents > 0))
);
create index rfq_pilot_debt_entries_customer_idx on public.rfq_pilot_debt_entries(store_id,customer_id,created_at);

create table public.rfq_pilot_cash_entries (
  id uuid primary key,
  store_id uuid not null,
  shift_id uuid not null,
  kind text not null check (kind in ('sale','collection','income','expense','withdraw')),
  amount_cents bigint not null check (amount_cents <> 0),
  actor_id uuid not null references auth.users(id),
  reference_id uuid,
  reason text not null default '',
  created_at timestamptz not null default now(),
  foreign key (store_id,shift_id) references public.rfq_pilot_shifts(store_id,id),
  check ((kind in ('sale','collection','income') and amount_cents > 0) or
    (kind in ('expense','withdraw') and amount_cents < 0))
);
create index rfq_pilot_cash_entries_shift_idx on public.rfq_pilot_cash_entries(store_id,shift_id);

create table public.rfq_pilot_stock_adjustments (
  id uuid primary key,
  store_id uuid not null,
  product_id uuid not null,
  delta_milli bigint not null check (delta_milli <> 0),
  reason text not null check (char_length(btrim(reason)) between 3 and 200),
  actor_id uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  foreign key (store_id,product_id) references public.rfq_pilot_products(store_id,id)
);

-- Clients may read their own store, but cannot write or view cost/profit columns.
-- The owner retrieves cost/treasury only from explicitly guarded RPCs.
do $$
declare t text;
begin
  foreach t in array array[
    'rfq_pilot_products','rfq_pilot_customers','rfq_pilot_invoices',
    'rfq_pilot_invoice_lines','rfq_pilot_debt_entries','rfq_pilot_cash_entries',
    'rfq_pilot_stock_adjustments'
  ] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on public.%I from public, anon, authenticated',t);
  end loop;
end $$;

create function public.rfq_pilot_worker_view(p_store uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.rfq_pilot_worker_leases l
      where l.store_id = p_store and l.user_id = auth.uid()
        and l.session_id = public.rfq_pilot_session_id()
        and public.rfq_pilot_worker_active(l.store_id,l.user_id,l.device_id)
  );
$$;

create policy rfq_pilot_products_view on public.rfq_pilot_products for select to authenticated
using ((select public.rfq_pilot_is_owner(store_id)) or (select public.rfq_pilot_worker_view(store_id)));
create policy rfq_pilot_customers_view on public.rfq_pilot_customers for select to authenticated
using ((select public.rfq_pilot_is_owner(store_id)) or (select public.rfq_pilot_worker_view(store_id)));
create policy rfq_pilot_invoices_view on public.rfq_pilot_invoices for select to authenticated
using ((select public.rfq_pilot_is_owner(store_id)) or
  (worker_id = (select auth.uid()) and (select public.rfq_pilot_worker_view(store_id))));
create policy rfq_pilot_lines_view on public.rfq_pilot_invoice_lines for select to authenticated
using (exists (select 1 from public.rfq_pilot_invoices i
  where (i.store_id,i.id) = (store_id,invoice_id) and
    (public.rfq_pilot_is_owner(i.store_id) or
      (i.worker_id = auth.uid() and public.rfq_pilot_worker_view(i.store_id)))));
create policy rfq_pilot_debts_owner on public.rfq_pilot_debt_entries for select to authenticated
using ((select public.rfq_pilot_is_owner(store_id)));
create policy rfq_pilot_cash_owner on public.rfq_pilot_cash_entries for select to authenticated
using ((select public.rfq_pilot_is_owner(store_id)));
create policy rfq_pilot_stock_owner on public.rfq_pilot_stock_adjustments for select to authenticated
using ((select public.rfq_pilot_is_owner(store_id)));

grant select(id,store_id,name,barcode,unit,price_cents,stock_milli,active,created_at,updated_at)
  on public.rfq_pilot_products to authenticated;
grant select(id,store_id,name,phone,active,created_at) on public.rfq_pilot_customers to authenticated;
grant select(id,store_id,number,shift_id,worker_id,cashier_device_id,customer_id,
  subtotal_cents,discount_cents,total_cents,cash_paid_cents,due_cents,created_at)
  on public.rfq_pilot_invoices to authenticated;
grant select(id,store_id,invoice_id,product_id,name_snapshot,barcode_snapshot,unit_snapshot,
  price_cents,qty_milli,line_total_cents)
  on public.rfq_pilot_invoice_lines to authenticated;
grant select on public.rfq_pilot_debt_entries,public.rfq_pilot_cash_entries,
  public.rfq_pilot_stock_adjustments to authenticated;

create function public.rfq_pilot_save_product(p_store uuid,p_id uuid,p_name text,
  p_barcode text,p_unit text,p_price_cents bigint,p_cost_cents bigint,
  p_initial_stock_milli bigint default 0) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_name text; v_barcode text;
begin
  if not public.rfq_pilot_is_owner(p_store) or not public.rfq_pilot_license_current(p_store) then
    raise exception 'active_owner_license_required';
  end if;
  v_name := btrim(coalesce(p_name,''));
  v_barcode := nullif(btrim(coalesce(p_barcode,'')),'');
  if char_length(v_name) not between 1 and 120 or
    (v_barcode is not null and char_length(v_barcode) > 80) or
    char_length(btrim(coalesce(p_unit,''))) not between 1 and 30 or
    p_price_cents is null or p_price_cents not between 0 and 1000000000 or
    p_cost_cents is null or p_cost_cents not between 0 and 1000000000 or
    p_initial_stock_milli is null or p_initial_stock_milli not between 0 and 1000000000 then
    raise exception 'invalid_product';
  end if;
  if p_id is null then
    insert into public.rfq_pilot_products(store_id,name,barcode,unit,price_cents,cost_cents,stock_milli)
      values(p_store,v_name,v_barcode,btrim(p_unit),p_price_cents,p_cost_cents,p_initial_stock_milli)
      returning id into v_id;
  else
    if p_initial_stock_milli <> 0 then raise exception 'use_audited_stock_adjustment'; end if;
    update public.rfq_pilot_products set name=v_name,barcode=v_barcode,unit=btrim(p_unit),
      price_cents=p_price_cents,cost_cents=p_cost_cents,updated_at=now()
      where store_id=p_store and id=p_id returning id into v_id;
    if not found then raise exception 'product_not_found'; end if;
  end if;
  return v_id;
end $$;

create function public.rfq_pilot_adjust_stock(p_store uuid,p_product uuid,p_event uuid,
  p_delta_milli bigint,p_reason text) returns bigint
language plpgsql security definer set search_path = '' as $$
declare v_stock bigint; v_prev public.rfq_pilot_stock_adjustments%rowtype;
begin
  if not public.rfq_pilot_is_owner(p_store) then
    raise exception 'active_owner_license_required';
  end if;
  if p_event is null or p_delta_milli is null or p_delta_milli=0 or
    p_delta_milli not between -1000000000 and 1000000000 or
    char_length(btrim(coalesce(p_reason,''))) not between 3 and 200 then
    raise exception 'invalid_stock_adjustment';
  end if;
  select stock_milli into v_stock from public.rfq_pilot_products
    where store_id=p_store and id=p_product for update;
  if not found then raise exception 'product_not_found'; end if;
  select * into v_prev from public.rfq_pilot_stock_adjustments where id=p_event;
  if found then
    if v_prev.store_id <> p_store or v_prev.product_id <> p_product or
      v_prev.delta_milli <> p_delta_milli or v_prev.reason <> btrim(p_reason) or
      v_prev.actor_id <> auth.uid() then raise exception 'idempotency_event_conflict'; end if;
    return v_stock;
  end if;
  if not public.rfq_pilot_license_current(p_store) then
    raise exception 'active_owner_license_required'; end if;
  if v_stock + p_delta_milli < 0 then raise exception 'insufficient_stock'; end if;
  update public.rfq_pilot_products set stock_milli = stock_milli+p_delta_milli,updated_at=now()
    where store_id=p_store and id=p_product returning stock_milli into v_stock;
  insert into public.rfq_pilot_stock_adjustments(id,store_id,product_id,delta_milli,reason,actor_id)
    values(p_event,p_store,p_product,p_delta_milli,btrim(p_reason),auth.uid());
  return v_stock;
end $$;

create function public.rfq_pilot_create_customer(p_store uuid,p_device uuid,p_id uuid,
  p_name text,p_phone text default '') returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_existing public.rfq_pilot_customers%rowtype; v_name text; v_phone text;
begin
  if not (public.rfq_pilot_is_owner(p_store) or
    public.rfq_pilot_worker_active(p_store,auth.uid(),p_device)) then
    raise exception 'authorized_session_required';
  end if;
  v_name := btrim(coalesce(p_name,'')); v_phone := btrim(coalesce(p_phone,''));
  if p_id is null or char_length(v_name) not between 1 and 120 or char_length(v_phone)>30 then
    raise exception 'invalid_customer';
  end if;
  select * into v_existing from public.rfq_pilot_customers where id=p_id;
  if found then
    if v_existing.store_id<>p_store or v_existing.name<>v_name or v_existing.phone<>v_phone then
      raise exception 'idempotency_event_conflict'; end if;
    return p_id;
  end if;
  if not public.rfq_pilot_license_current(p_store) then
    raise exception 'authorized_session_required'; end if;
  insert into public.rfq_pilot_customers(id,store_id,name,phone)
    values(p_id,p_store,v_name,v_phone);
  return p_id;
end $$;

create function public.rfq_pilot_customer_balance(p_store uuid,p_device uuid,p_customer uuid)
returns bigint language plpgsql stable security definer set search_path = '' as $$
declare v_balance bigint;
begin
  if not (public.rfq_pilot_is_owner(p_store) or
      public.rfq_pilot_worker_active(p_store,auth.uid(),p_device)) then
    raise exception 'authorized_session_required';
  end if;
  if not exists(select 1 from public.rfq_pilot_customers
    where store_id=p_store and id=p_customer and active) then raise exception 'customer_not_found'; end if;
  select coalesce(sum(amount_cents),0) into v_balance from public.rfq_pilot_debt_entries
    where store_id=p_store and customer_id=p_customer;
  return v_balance;
end $$;

-- Customer debts entered remotely by the owner (no SIM, no cashier cash movement).
-- Every adjustment has an idempotency key and an audit note. Negative corrections
-- and old-phone migrations are intentionally excluded from this test endpoint.
create function public.rfq_pilot_owner_add_debt(p_store uuid,p_customer uuid,p_event uuid,
  p_amount_cents bigint,p_reason text) returns bigint
language plpgsql security definer set search_path = '' as $$
declare v_old public.rfq_pilot_debt_entries%rowtype;
  v_customer public.rfq_pilot_customers%rowtype; v_balance bigint;
begin
  if not public.rfq_pilot_is_owner(p_store) then
    raise exception 'active_owner_license_required';
  end if;
  if p_event is null or p_amount_cents is null or p_amount_cents not between 1 and 100000000000 or
    char_length(btrim(coalesce(p_reason,''))) not between 3 and 200 then raise exception 'invalid_debt'; end if;
  select * into v_customer from public.rfq_pilot_customers
    where store_id=p_store and id=p_customer for update;
  if not found then raise exception 'customer_not_found'; end if;
  select * into v_old from public.rfq_pilot_debt_entries where id=p_event;
  if found then
    if v_old.store_id<>p_store or v_old.customer_id<>p_customer or
      v_old.kind<>'owner_debit' or v_old.actor_id<>auth.uid() or
      v_old.amount_cents<>p_amount_cents or v_old.note<>btrim(p_reason) then
      raise exception 'idempotency_event_conflict'; end if;
  else
    if not public.rfq_pilot_license_current(p_store) or not v_customer.active then
      raise exception 'active_owner_license_required'; end if;
    insert into public.rfq_pilot_debt_entries(id,store_id,customer_id,kind,amount_cents,actor_id,note)
      values(p_event,p_store,p_customer,'owner_debit',p_amount_cents,auth.uid(),btrim(p_reason));
  end if;
  select coalesce(sum(amount_cents),0) into v_balance from public.rfq_pilot_debt_entries
    where store_id=p_store and customer_id=p_customer;
  return v_balance;
end $$;

-- No direct invoice inserts. All quantities, prices, stock, debt and till cash are
-- committed in ONE database transaction, serialized with closing the same shift.
-- Test scope: cash + debt only, no discounts/noncash/returns/supplier invoices.
create function public.rfq_pilot_post_invoice(p_shift uuid,p_device uuid,p_invoice uuid,
  p_customer uuid,p_lines jsonb,p_cash_cents bigint,p_sms_consent boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_shift public.rfq_pilot_shifts%rowtype; v_customer public.rfq_pilot_customers%rowtype;
  v_prev public.rfq_pilot_invoices%rowtype; v_product public.rfq_pilot_products%rowtype;
  v_item jsonb; v_product_id uuid; v_qty bigint; v_line_total bigint; v_subtotal bigint:=0;
  v_due bigint; v_number bigint; v_request jsonb; v_seen uuid[]:=array[]::uuid[];
begin
  if p_shift is null or p_invoice is null or p_device is null or p_lines is null or
    jsonb_typeof(p_lines)<>'array' or jsonb_array_length(p_lines) not between 1 and 100 or
    p_cash_cents is null or p_cash_cents<0 or p_sms_consent is null then
    raise exception 'invalid_invoice';
  end if;
  v_request:=jsonb_build_object('shift',p_shift,'device',p_device,'customer',p_customer,
    'lines',p_lines,'cash',p_cash_cents,'consent',p_sms_consent);
  select * into v_shift from public.rfq_pilot_shifts where id=p_shift for update;
  if not found or v_shift.cashier_device_id<>p_device or
    not public.rfq_pilot_worker_active(v_shift.store_id,v_shift.worker_id,p_device) then
    raise exception 'approved_open_shift_required';
  end if;
  select * into v_prev from public.rfq_pilot_invoices where id=p_invoice;
  if found then
    if v_prev.store_id<>v_shift.store_id or v_prev.worker_id<>auth.uid() or
      v_prev.request_json<>v_request then raise exception 'idempotency_event_conflict'; end if;
    return jsonb_build_object('invoice_id',v_prev.id,'number',v_prev.number,
      'total_cents',v_prev.total_cents,'due_cents',v_prev.due_cents,
      'already_committed',true);
  end if;
  if v_shift.status<>'open' then raise exception 'approved_open_shift_required'; end if;
  -- Lock products in UUID order, regardless of the client's line order.
  for v_item in select x.value from jsonb_array_elements(p_lines) x(value)
    order by x.value->>'product_id'
  loop
    if jsonb_typeof(v_item)<>'object' or
      (v_item->>'product_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' or
      (v_item->>'qty_milli') !~ '^[0-9]{1,10}$' then raise exception 'invalid_invoice_line'; end if;
    v_product_id:=(v_item->>'product_id')::uuid;
    v_qty:=(v_item->>'qty_milli')::bigint;
    if v_qty not between 1 and 1000000 or v_product_id=any(v_seen) then
      raise exception 'invalid_invoice_line'; end if;
    v_seen:=array_append(v_seen,v_product_id);
    select * into v_product from public.rfq_pilot_products
      where store_id=v_shift.store_id and id=v_product_id and active for update;
    if not found or v_product.stock_milli<v_qty then raise exception 'insufficient_stock'; end if;
    v_line_total:=round(v_product.price_cents::numeric*v_qty/1000)::bigint;
    v_subtotal:=v_subtotal+v_line_total;
  end loop;
  if v_subtotal>100000000000 or p_cash_cents>v_subtotal then raise exception 'invalid_payment'; end if;
  v_due:=v_subtotal-p_cash_cents;
  if (v_due>0 and p_customer is null) or (v_due=0 and p_customer is not null) or
    (p_sms_consent and v_due=0) then raise exception 'invalid_credit_customer'; end if;
  if v_due>0 then
    select * into v_customer from public.rfq_pilot_customers
      where store_id=v_shift.store_id and id=p_customer and active for update;
    if not found then raise exception 'customer_not_found'; end if;
    if p_sms_consent and v_customer.phone='' then raise exception 'customer_phone_required'; end if;
  end if;
  -- The store row is the global invoice-number sequence lock. No local-device
  -- number is treated as authoritative; other devices see this number as-is.
  perform 1 from public.rfq_pilot_stores where id=v_shift.store_id and enabled and license_until>now() for update;
  if not found then raise exception 'license_expired'; end if;
  select coalesce(max(number),0)+1 into v_number from public.rfq_pilot_invoices
    where store_id=v_shift.store_id;
  insert into public.rfq_pilot_invoices(id,store_id,number,shift_id,worker_id,cashier_device_id,
    customer_id,subtotal_cents,discount_cents,total_cents,cash_paid_cents,due_cents,
    request_json,sms_consent,sms_consent_at)
    values(p_invoice,v_shift.store_id,v_number,p_shift,auth.uid(),p_device,
      p_customer,v_subtotal,0,v_subtotal,p_cash_cents,v_due,
      v_request,p_sms_consent,case when p_sms_consent then now() else null end);
  for v_item in select x.value from jsonb_array_elements(p_lines) x(value) loop
    v_product_id:=(v_item->>'product_id')::uuid;
    v_qty:=(v_item->>'qty_milli')::bigint;
    select * into v_product from public.rfq_pilot_products
      where store_id=v_shift.store_id and id=v_product_id;
    v_line_total:=round(v_product.price_cents::numeric*v_qty/1000)::bigint;
    insert into public.rfq_pilot_invoice_lines(store_id,invoice_id,product_id,name_snapshot,
      barcode_snapshot,unit_snapshot,price_cents,cost_cents,qty_milli,line_total_cents)
      values(v_shift.store_id,p_invoice,v_product_id,v_product.name,v_product.barcode,
        v_product.unit,v_product.price_cents,v_product.cost_cents,v_qty,v_line_total);
    update public.rfq_pilot_products set stock_milli=stock_milli-v_qty,updated_at=now()
      where id=v_product_id and store_id=v_shift.store_id;
  end loop;
  if p_cash_cents>0 then
    insert into public.rfq_pilot_cash_entries(id,store_id,shift_id,kind,amount_cents,actor_id,reference_id)
      values(gen_random_uuid(),v_shift.store_id,p_shift,'sale',p_cash_cents,auth.uid(),p_invoice);
  end if;
  if v_due>0 then
    insert into public.rfq_pilot_debt_entries(id,store_id,customer_id,invoice_id,kind,amount_cents,actor_id)
      values(gen_random_uuid(),v_shift.store_id,p_customer,p_invoice,'invoice_due',v_due,auth.uid());
  end if;
  return jsonb_build_object('invoice_id',p_invoice,'number',v_number,
    'total_cents',v_subtotal,'due_cents',v_due,'already_committed',false);
end $$;

create function public.rfq_pilot_collect_debt(p_shift uuid,p_device uuid,p_event uuid,
  p_customer uuid,p_amount_cents bigint) returns bigint
language plpgsql security definer set search_path = '' as $$
declare v_shift public.rfq_pilot_shifts%rowtype; v_old public.rfq_pilot_debt_entries%rowtype;
  v_customer public.rfq_pilot_customers%rowtype; v_balance bigint;
begin
  if p_event is null or p_amount_cents is null or p_amount_cents not between 1 and 100000000000 then
    raise exception 'invalid_collection'; end if;
  select * into v_shift from public.rfq_pilot_shifts where id=p_shift for update;
  if not found or v_shift.cashier_device_id<>p_device or
    not public.rfq_pilot_worker_active(v_shift.store_id,v_shift.worker_id,p_device) then
    raise exception 'approved_open_shift_required'; end if;
  select * into v_customer from public.rfq_pilot_customers
    where store_id=v_shift.store_id and id=p_customer for update;
  if not found then raise exception 'customer_not_found'; end if;
  select * into v_old from public.rfq_pilot_debt_entries where id=p_event;
  if found then
    if v_old.store_id<>v_shift.store_id or v_old.customer_id<>p_customer or
      v_old.kind<>'collection' or v_old.actor_id<>auth.uid() or
      v_old.amount_cents<>-p_amount_cents or v_old.note<>p_shift::text then
      raise exception 'idempotency_event_conflict'; end if;
  else
    if v_shift.status<>'open' or not v_customer.active then
      raise exception 'approved_open_shift_required'; end if;
    select coalesce(sum(amount_cents),0) into v_balance from public.rfq_pilot_debt_entries
      where store_id=v_shift.store_id and customer_id=p_customer;
    if v_balance<p_amount_cents then raise exception 'collection_exceeds_debt'; end if;
    insert into public.rfq_pilot_debt_entries(id,store_id,customer_id,kind,amount_cents,actor_id,note)
      values(p_event,v_shift.store_id,p_customer,'collection',-p_amount_cents,auth.uid(),p_shift::text);
    insert into public.rfq_pilot_cash_entries(id,store_id,shift_id,kind,amount_cents,actor_id,reference_id)
      values(gen_random_uuid(),v_shift.store_id,p_shift,'collection',p_amount_cents,auth.uid(),p_event);
  end if;
  select coalesce(sum(amount_cents),0) into v_balance from public.rfq_pilot_debt_entries
    where store_id=v_shift.store_id and customer_id=p_customer;
  return v_balance;
end $$;

create function public.rfq_pilot_owner_cash_adjust(p_shift uuid,p_event uuid,p_kind text,
  p_amount_cents bigint,p_reason text) returns bigint
language plpgsql security definer set search_path = '' as $$
declare v_shift public.rfq_pilot_shifts%rowtype; v_old public.rfq_pilot_cash_entries%rowtype;
  v_signed bigint; v_balance bigint;
begin
  select * into v_shift from public.rfq_pilot_shifts where id=p_shift for update;
  if not found or not public.rfq_pilot_is_owner(v_shift.store_id) then
    raise exception 'active_owner_open_shift_required'; end if;
  if p_event is null or p_kind not in ('income','expense','withdraw') or
    p_amount_cents is null or p_amount_cents not between 1 and 100000000000 or
    char_length(btrim(coalesce(p_reason,''))) not between 3 and 200 then
    raise exception 'invalid_cash_adjustment'; end if;
  v_signed:=case when p_kind='income' then p_amount_cents else -p_amount_cents end;
  select * into v_old from public.rfq_pilot_cash_entries where id=p_event;
  if found then
    if v_old.store_id<>v_shift.store_id or v_old.shift_id<>p_shift or
      v_old.kind<>p_kind or v_old.amount_cents<>v_signed or
      v_old.reason<>btrim(p_reason) or v_old.actor_id<>auth.uid() then
      raise exception 'idempotency_event_conflict'; end if;
  else
    if v_shift.status<>'open' or not public.rfq_pilot_license_current(v_shift.store_id) then
      raise exception 'active_owner_open_shift_required'; end if;
    insert into public.rfq_pilot_cash_entries(id,store_id,shift_id,kind,amount_cents,actor_id,reason)
      values(p_event,v_shift.store_id,p_shift,p_kind,v_signed,auth.uid(),btrim(p_reason));
  end if;
  select v_shift.opening_cents+coalesce(sum(amount_cents),0) into v_balance
    from public.rfq_pilot_cash_entries where shift_id=p_shift;
  return v_balance;
end $$;

-- Replace/remove the auth-only test hook: it must never be usable as a real sale.
create or replace function public.rfq_pilot_close_shift(p_shift uuid,p_counted_cents bigint) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_shift public.rfq_pilot_shifts%rowtype;
  v_cash bigint; v_sales bigint; v_collections bigint; v_other bigint;
  v_total bigint; v_due bigint; v_expected bigint;
begin
  if p_counted_cents is null or p_counted_cents<0 then raise exception 'invalid_count'; end if;
  select * into v_shift from public.rfq_pilot_shifts where id=p_shift for update;
  if not found or v_shift.status<>'open' or not public.rfq_pilot_is_owner(v_shift.store_id) then
    raise exception 'owner_and_open_shift_required'; end if;
  select coalesce(sum(amount_cents),0),
    coalesce(sum(amount_cents) filter(where kind='sale'),0),
    coalesce(sum(amount_cents) filter(where kind='collection'),0),
    coalesce(sum(amount_cents) filter(where kind in ('income','expense','withdraw')),0)
    into v_cash,v_sales,v_collections,v_other
    from public.rfq_pilot_cash_entries where shift_id=p_shift;
  select coalesce(sum(total_cents),0),coalesce(sum(due_cents),0) into v_total,v_due
    from public.rfq_pilot_invoices where shift_id=p_shift;
  v_expected:=v_shift.opening_cents+v_cash;
  if v_expected<0 then raise exception 'negative_till_requires_review'; end if;
  update public.rfq_pilot_shifts set status='closed',closed_at=now(),
    counted_cents=p_counted_cents,expected_cents=v_expected,
    difference_cents=p_counted_cents-v_expected where id=p_shift;
  return jsonb_build_object('shift_id',p_shift,'opening_cents',v_shift.opening_cents,
    'sales_total_cents',v_total,'sales_due_cents',v_due,'sales_cash_cents',v_sales,
    'collections_cash_cents',v_collections,'other_cash_net_cents',v_other,
    'expected_cents',v_expected,'counted_cents',p_counted_cents,
    'difference_cents',p_counted_cents-v_expected);
end $$;

drop function public.rfq_pilot_test_sale(uuid,uuid,uuid,bigint,bigint);
drop table public.rfq_pilot_sale_auth_tests;

create function public.rfq_pilot_owner_summary(p_store uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_sales bigint; v_cash bigint; v_due bigint; v_cost numeric; v_debt bigint;
begin
  if not public.rfq_pilot_is_owner(p_store) then raise exception 'owner_required'; end if;
  select coalesce(sum(total_cents),0),coalesce(sum(cash_paid_cents),0),
    coalesce(sum(due_cents),0) into v_sales,v_cash,v_due
    from public.rfq_pilot_invoices where store_id=p_store;
  select coalesce(sum(cost_cents::numeric*qty_milli/1000),0) into v_cost
    from public.rfq_pilot_invoice_lines where store_id=p_store;
  select coalesce(sum(amount_cents),0) into v_debt
    from public.rfq_pilot_debt_entries where store_id=p_store;
  return jsonb_build_object('sales_cents',v_sales,'cash_received_on_sales_cents',v_cash,
    'new_credit_cents',v_due,'gross_margin_estimate_cents',v_sales-round(v_cost)::bigint,
    'outstanding_debt_cents',v_debt,
    'notice','Test scope: no returns, supplier costs/expenses, or taxes');
end $$;

-- Unlike the test-only functions dropped above, every new RPC is deliberately
-- restricted to authenticated. Helpers are also callable only by authenticated.
do $$
declare f record;
begin
  for f in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname like 'rfq_pilot_%'
  loop
    execute format('revoke all on function %s from public, anon, authenticated',f.signature);
    execute format('grant execute on function %s to authenticated',f.signature);
  end loop;
end $$;
