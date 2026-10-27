-- RAFIQ Pilot: guarded invoice RPC, candidate for the exact 18f5 source.
-- Local source only: NOT executed, NOT tested, NOT deployed; DO NOT RUN ON PRODUCTION.
-- Exact evidence 18f5 base ledger SHA-256:
-- 5d343cfa7d4bfedcb66ce75775dcea00fd8c2369f6ada4a63368d6b36e08ddf2
-- COORDINATED STAGING ROLLOUT ONLY: this migration disables the old unsafe
-- rfq_pilot_post_invoice endpoint. Existing APKs cannot post new invoices until
-- a matching guarded client is installed. Never enable the old RPC as a fallback.

create function public.rfq_pilot_post_invoice_guarded(p_shift uuid,p_device uuid,p_invoice uuid,
  p_customer uuid,p_lines jsonb,p_cash_cents bigint,p_sms_consent boolean default false,
  p_replay_only boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_shift public.rfq_pilot_shifts%rowtype; v_customer public.rfq_pilot_customers%rowtype;
  v_prev public.rfq_pilot_invoices%rowtype; v_product public.rfq_pilot_products%rowtype;
  v_item jsonb; v_product_id uuid; v_qty bigint; v_line_total bigint; v_subtotal bigint:=0;
  v_due bigint; v_number bigint; v_request jsonb; v_seen uuid[]:=array[]::uuid[];
  v_expected_price bigint; v_lines jsonb;
begin
  if p_shift is null or p_invoice is null or p_device is null or p_lines is null or
    jsonb_typeof(p_lines)<>'array' or jsonb_array_length(p_lines) not between 1 and 100 or
    p_cash_cents is null or p_cash_cents<0 or p_sms_consent is null or
    p_replay_only is null then
    raise exception 'invalid_invoice';
  end if;
  v_request:=jsonb_build_object('shift',p_shift,'device',p_device,'customer',p_customer,
    'lines',p_lines,'cash',p_cash_cents,'consent',p_sms_consent);
  -- Serialize requests for the SAME invoice id before reading the earlier result.
  -- This read-only replay path does NOT authorize a fresh sale.
  if not public.rfq_pilot_live_session() then raise exception 'live_session_required'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_invoice::text, 711));
  select * into v_prev from public.rfq_pilot_invoices where id=p_invoice;
  if found then
    if v_prev.shift_id<>p_shift or v_prev.worker_id<>auth.uid() or
       v_prev.cashier_device_id<>p_device or v_prev.request_json<>v_request or
       exists (select 1 from public.rfq_pilot_denied_sessions z
         where z.store_id=v_prev.store_id and z.user_id=auth.uid()
           and z.session_id=public.rfq_pilot_session_id()) or
       not exists (
         select 1 from public.rfq_pilot_members m
           join public.rfq_pilot_stores s on s.id=m.store_id
           join public.rfq_pilot_devices d on d.store_id=m.store_id
         where m.store_id=v_prev.store_id and m.user_id=auth.uid()
           and m.active and m.role='worker' and s.enabled
           and d.id=p_device and d.user_id=auth.uid()
           and d.status='approved' and d.kind in ('cashier_phone','web')
       ) then raise exception 'idempotency_event_conflict'; end if;
    -- A worker can verify only THIS committed invoice's immutable lines even
    -- after the lease/license/shift ended. Ordinary table RLS stays unchanged.
    select coalesce(jsonb_agg(jsonb_build_object('invoice_id',l.invoice_id,
      'product_id',l.product_id,'name_snapshot',l.name_snapshot,
      'price_cents',l.price_cents,'qty_milli',l.qty_milli) order by l.id),'[]'::jsonb)
      into v_lines from public.rfq_pilot_invoice_lines l
      where l.store_id=v_prev.store_id and l.invoice_id=v_prev.id;
    return jsonb_build_object('invoice_id',v_prev.id,'number',v_prev.number,
      'total_cents',v_prev.total_cents,'due_cents',v_prev.due_cents,
      'lines',v_lines,'already_committed',true);
  end if;
  -- Read-only recovery may check for a prior commit, but cannot create one.
  -- The flag is NOT part of the original sale payload or idempotency comparison.
  if p_replay_only then raise exception 'invoice_replay_not_found'; end if;
  -- New sales STILL require an active license, worker lease and open shift.
  select * into v_shift from public.rfq_pilot_shifts where id=p_shift for update;
  if not found or v_shift.cashier_device_id<>p_device or
     v_shift.worker_id<>auth.uid() or v_shift.status<>'open' or
     not public.rfq_pilot_worker_active(v_shift.store_id,v_shift.worker_id,p_device) then
    raise exception 'approved_open_shift_required';
  end if;
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
    -- Require a client-agreed snapshot (not an authoritative client price).
    -- The server row lock and comparison happen in this SAME transaction,
    -- before ANY invoice/stock/cash/debt write.
    if jsonb_typeof(v_item->'expected_price_cents') is distinct from 'number' or
       coalesce((v_item->>'expected_price_cents') !~ '^(0|[1-9][0-9]{0,9})$',true) or
       jsonb_typeof(v_item->'expected_name') is distinct from 'string' or
       coalesce(char_length(btrim(v_item->>'expected_name')) not between 1 and 120,true) then
      raise exception 'invoice_price_snapshot_required';
    end if;
    v_expected_price:=(v_item->>'expected_price_cents')::bigint;
    if v_expected_price>1000000000 then raise exception 'invoice_price_snapshot_required'; end if;
    select * into v_product from public.rfq_pilot_products
      where store_id=v_shift.store_id and id=v_product_id and active for update;
    if not found or v_product.stock_milli<v_qty then raise exception 'insufficient_stock'; end if;
    if v_product.price_cents<>v_expected_price or v_product.name<>(v_item->>'expected_name') then
      raise exception 'invoice_snapshot_changed';
    end if;
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
  select coalesce(jsonb_agg(jsonb_build_object('invoice_id',l.invoice_id,
    'product_id',l.product_id,'name_snapshot',l.name_snapshot,
    'price_cents',l.price_cents,'qty_milli',l.qty_milli) order by l.id),'[]'::jsonb)
    into v_lines from public.rfq_pilot_invoice_lines l
    where l.store_id=v_shift.store_id and l.invoice_id=p_invoice;
  return jsonb_build_object('invoice_id',p_invoice,'number',v_number,
    'total_cents',v_subtotal,'due_cents',v_due,'lines',v_lines,'already_committed',false);
end $$;

revoke all on function public.rfq_pilot_post_invoice_guarded(uuid,uuid,uuid,uuid,jsonb,bigint,boolean,boolean)
  from public, anon, authenticated;
grant execute on function public.rfq_pilot_post_invoice_guarded(uuid,uuid,uuid,uuid,jsonb,bigint,boolean,boolean)
  to authenticated;

-- Fail closed: old clients must not bypass atomic price/name verification.
revoke all on function public.rfq_pilot_post_invoice(uuid,uuid,uuid,uuid,jsonb,bigint,boolean)
  from public, anon, authenticated;

-- Refresh PostgREST's RPC signature cache after the coordinated staging gate.
notify pgrst, 'reload schema';
