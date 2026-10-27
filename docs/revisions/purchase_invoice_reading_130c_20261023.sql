-- المرحلة كاملة لقراءة فواتير المشتريات — طُبّق على المشروع 2026-10-23 (migration: purchase_invoice_reading_130c_v2)
-- الخادم كان يكتب rfq_pilot_stock_batches عند الشراء فقط. هنا يكتمل:
-- 1) صرف الدفعات بالأقرب صلاحية أولًا (FEFO) مع كل سطر بيع — بلا رفع أخطاء أبدًا.
-- 2) إرجاع الكمية للدفعات المتبقية من نفس الفاتورة عند مرتجع المبيعات أو إلغاء الفاتورة.
-- 3) ميتا الفاتورة المورّدة (رقمها/تاريخها/بصمة صورتها/إجماليها المعلن/مفتاح عدم التكرار).
-- 4) قراءات: دفعات صنف + تقرير القريب انتهاءً/المنتهي.
-- ملاحظة: جدول سطور البيع بلا returned_qty_milli على الخادم — الإرجاع عبر sales_return_lines وvoided_at.

create table if not exists public.rfq_pilot_batch_moves (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null,
  batch_id uuid not null,
  product_id uuid not null,
  ref_id uuid not null,
  kind text not null check (kind in ('consume','release')),
  qty_milli bigint not null check (qty_milli > 0),
  created_at timestamptz not null default now()
);
alter table public.rfq_pilot_batch_moves enable row level security;
drop policy if exists batch_moves_read on public.rfq_pilot_batch_moves;
create policy batch_moves_read on public.rfq_pilot_batch_moves for select
  using (exists (select 1 from public.rfq_pilot_members m where m.store_id=rfq_pilot_batch_moves.store_id and m.user_id=auth.uid() and m.active));

alter table public.rfq_pilot_supplier_purchases
  add column if not exists invoice_ref text,
  add column if not exists invoice_date date,
  add column if not exists image_sha256 text,
  add column if not exists image_thumb text,
  add column if not exists declared_total_cents bigint,
  add column if not exists idempotency_key text;
create unique index if not exists rfq_pilot_supplier_purchases_idem
  on public.rfq_pilot_supplier_purchases(store_id, idempotency_key) where idempotency_key is not null;

-- ==== صرف FEFO — لا يفشل البيع أبدًا ====
create or replace function public.rfq_pilot_batch_consume_fn() returns trigger
language plpgsql security definer set search_path to 'public' as $fn$
DECLARE
  v_need bigint := greatest(coalesce(NEW.qty_milli,0), 0);
  v_batch record; v_take bigint;
BEGIN
  IF v_need <= 0 THEN RETURN NEW; END IF;
  FOR v_batch IN
    SELECT id, qty_milli FROM public.rfq_pilot_stock_batches
    WHERE store_id=NEW.store_id AND product_id=NEW.product_id AND qty_milli>0
      AND (expiry_date IS NULL OR expiry_date >= current_date)
    ORDER BY (expiry_date IS NULL), expiry_date, created_at
  LOOP
    EXIT WHEN v_need <= 0;
    v_take := least(v_batch.qty_milli, v_need);
    UPDATE public.rfq_pilot_stock_batches SET qty_milli=qty_milli-v_take WHERE id=v_batch.id;
    INSERT INTO public.rfq_pilot_batch_moves(store_id,batch_id,product_id,ref_id,kind,qty_milli)
    VALUES (NEW.store_id,v_batch.id,NEW.product_id,NEW.invoice_id,'consume',v_take);
    v_need := v_need - v_take;
  END LOOP;
  -- إن بقي شيء (مخزون بلا دفعات أو منتهٍ اضطراريًا) نصرفه من أي دفعة — ولا نرمي خطأ أبدًا
  IF v_need > 0 THEN
    FOR v_batch IN
      SELECT id, qty_milli FROM public.rfq_pilot_stock_batches
      WHERE store_id=NEW.store_id AND product_id=NEW.product_id AND qty_milli>0
      ORDER BY (expiry_date IS NULL), expiry_date, created_at
    LOOP
      EXIT WHEN v_need <= 0;
      v_take := least(v_batch.qty_milli, v_need);
      UPDATE public.rfq_pilot_stock_batches SET qty_milli=qty_milli-v_take WHERE id=v_batch.id;
      INSERT INTO public.rfq_pilot_batch_moves(store_id,batch_id,product_id,ref_id,kind,qty_milli)
      VALUES (NEW.store_id,v_batch.id,NEW.product_id,NEW.invoice_id,'consume',v_take);
      v_need := v_need - v_take;
    END LOOP;
  END IF;
  RETURN NEW;
END $fn$;
drop trigger if exists rfq_pilot_batch_consume_trg on public.rfq_pilot_invoice_lines;
create trigger rfq_pilot_batch_consume_trg
  after insert on public.rfq_pilot_invoice_lines
  for each row execute function public.rfq_pilot_batch_consume_fn();

-- ==== محرّك الإرجاع المشترك ====
create or replace function public.rfq_pilot_batch_release_qty(p_store uuid, p_product uuid, p_ref uuid, p_qty bigint)
returns void
language plpgsql security definer set search_path to 'public' as $fn$
DECLARE
  v_rest bigint := greatest(coalesce(p_qty,0),0);
  v_take bigint; v_pool bigint; v_move record;
BEGIN
  IF v_rest <= 0 THEN RETURN; END IF;
  SELECT coalesce(sum(case when kind='consume' then qty_milli else -qty_milli end),0) INTO v_pool
    FROM public.rfq_pilot_batch_moves
    WHERE store_id=p_store AND product_id=p_product AND ref_id=p_ref;
  v_rest := least(v_rest, greatest(v_pool,0));
  FOR v_move IN
    SELECT batch_id, sum(case when kind='consume' then qty_milli else -qty_milli end) AS qty
      FROM public.rfq_pilot_batch_moves
      WHERE store_id=p_store AND product_id=p_product AND ref_id=p_ref
      GROUP BY batch_id ORDER BY min(created_at) DESC
  LOOP
    EXIT WHEN v_rest <= 0;
    IF v_move.qty <= 0 THEN CONTINUE; END IF;
    v_take := least(v_move.qty, v_rest);
    UPDATE public.rfq_pilot_stock_batches SET qty_milli=qty_milli+v_take WHERE id=v_move.batch_id;
    INSERT INTO public.rfq_pilot_batch_moves(store_id,batch_id,product_id,ref_id,kind,qty_milli)
    VALUES (p_store,v_move.batch_id,p_product,p_ref,'release',v_take);
    v_rest := v_rest - v_take;
  END LOOP;
END $fn$;

-- محرّك إرجاع المرتجعات: سطر مرتجع جديد → إرجاع كميته للدفعات المتبقية من الفاتورة الأصلية
create or replace function public.rfq_pilot_batch_release_return_fn() returns trigger
language plpgsql security definer set search_path to 'public' as $fn$
DECLARE v_invoice uuid;
BEGIN
  SELECT invoice_id INTO v_invoice FROM public.rfq_pilot_invoice_lines WHERE id=NEW.invoice_line_id;
  IF v_invoice IS NULL THEN RETURN NEW; END IF;
  PERFORM public.rfq_pilot_batch_release_qty(NEW.store_id, NEW.product_id, v_invoice, greatest(coalesce(NEW.qty_milli,0),0));
  RETURN NEW;
END $fn$;
drop trigger if exists rfq_pilot_batch_release_return_trg on public.rfq_pilot_sales_return_lines;
create trigger rfq_pilot_batch_release_return_trg
  after insert on public.rfq_pilot_sales_return_lines
  for each row execute function public.rfq_pilot_batch_release_return_fn();

-- إلغاء فاتورة → إرجاع كل أسطرها المتبقية من الدفعات
create or replace function public.rfq_pilot_batch_release_void_fn() returns trigger
language plpgsql security definer set search_path to 'public' as $fn$
DECLARE v_line record;
BEGIN
  IF NEW.voided_at IS NULL OR OLD.voided_at IS NOT NULL THEN RETURN NEW; END IF;
  FOR v_line IN SELECT product_id, qty_milli FROM public.rfq_pilot_invoice_lines WHERE invoice_id=NEW.id LOOP
    PERFORM public.rfq_pilot_batch_release_qty(NEW.store_id, v_line.product_id, NEW.id, greatest(coalesce(v_line.qty_milli,0),0));
  END LOOP;
  RETURN NEW;
END $fn$;
drop trigger if exists rfq_pilot_batch_release_void_trg on public.rfq_pilot_invoices;
create trigger rfq_pilot_batch_release_void_trg
  after update of voided_at on public.rfq_pilot_invoices
  for each row execute function public.rfq_pilot_batch_release_void_fn();

-- ==== قراءات الدفعات ====
create or replace function public.rfq_pilot_product_batches(p_store uuid, p_product uuid)
returns table(id uuid, qty_milli bigint, expiry_date date, expired boolean, kind text, created_at timestamptz)
language sql security definer set search_path to 'public' stable as $fn$
  select b.id, b.qty_milli, b.expiry_date,
         (b.expiry_date is not null and b.expiry_date < current_date) as expired,
         'purchase'::text as kind, b.created_at
  from public.rfq_pilot_stock_batches b
  where b.store_id=p_store and b.product_id=p_product and b.qty_milli <> 0
    and exists (select 1 from public.rfq_pilot_members m where m.store_id=p_store and m.user_id=auth.uid() and m.active)
  order by (b.expiry_date is null), b.expiry_date;
$fn$;

create or replace function public.rfq_pilot_expiring_batches(p_store uuid, p_days integer default 30)
returns table(product_id uuid, name text, qty_milli bigint, expiry_date date, expired boolean, created_at timestamptz)
language sql security definer set search_path to 'public' stable as $fn$
  select b.product_id, pr.name, b.qty_milli, b.expiry_date,
         (b.expiry_date < current_date) as expired, b.created_at
  from public.rfq_pilot_stock_batches b
  join public.rfq_pilot_products pr on pr.id=b.product_id
  where b.store_id=p_store and b.qty_milli>0 and b.expiry_date is not null
    and b.expiry_date <= current_date + greatest(coalesce(p_days,30),1)
    and exists (select 1 from public.rfq_pilot_members m where m.store_id=p_store and m.user_id=auth.uid() and m.active)
  order by b.expiry_date;
$fn$;

-- ==== ترحيل فاتورة مورّد من المسودة: ميتا + صورة + عدم تكرار — معاملة واحدة ====
create or replace function public.rfq_pilot_save_purchase_v3(
  p_store uuid, p_supplier uuid, p_lines jsonb, p_paid_cents bigint default 0,
  p_note text default null, p_shift_id uuid default null, p_pay_method text default 'cash',
  p_invoice_ref text default null, p_invoice_date date default null,
  p_image_sha256 text default null, p_image_thumb text default null,
  p_declared_total_cents bigint default null, p_idempotency_key text default null)
returns jsonb
language plpgsql security definer set search_path to 'public' as $fn$
DECLARE
  v_prev public.rfq_pilot_supplier_purchases%ROWTYPE;
  v_res jsonb; v_id uuid; v_total bigint;
  v_line jsonb; v_sum bigint := 0; v_qty bigint; v_cost bigint;
BEGIN
  IF p_idempotency_key IS NOT NULL THEN
    SELECT * INTO v_prev FROM public.rfq_pilot_supplier_purchases
      WHERE store_id=p_store AND idempotency_key=p_idempotency_key;
    IF FOUND THEN
      RETURN jsonb_build_object('id',v_prev.id,'purchase_id',v_prev.id,'total_cents',v_prev.total_cents,'already_committed',true,'ok',true);
    END IF;
  END IF;
  IF p_image_sha256 IS NOT NULL AND p_image_sha256 !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'purchase_image_fingerprint_invalid'; END IF;
  IF p_invoice_ref IS NOT NULL AND length(p_invoice_ref) > 100 THEN RAISE EXCEPTION 'purchase_invoice_ref_invalid'; END IF;
  IF p_declared_total_cents IS NOT NULL THEN
    IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' THEN RAISE EXCEPTION 'purchase_lines_required'; END IF;
    FOR v_line IN SELECT value FROM jsonb_array_elements(p_lines) LOOP
      v_qty := coalesce((v_line->>'qty_milli')::bigint,0);
      v_cost := coalesce((v_line->>'cost_cents')::bigint,-1);
      IF v_qty <= 0 OR v_cost < 0 THEN RAISE EXCEPTION 'purchase_line_invalid'; END IF;
      v_sum := v_sum + (v_qty * v_cost + 500) / 1000;
    END LOOP;
    IF p_declared_total_cents <> v_sum THEN
      RAISE EXCEPTION 'purchase_total_mismatch';
    END IF;
  END IF;
  v_res := public.rfq_pilot_save_purchase_v2(p_store,p_supplier,p_lines,p_paid_cents,p_note,p_shift_id,p_pay_method);
  v_id := (v_res->>'id')::uuid;
  v_total := (v_res->>'total_cents')::bigint;
  UPDATE public.rfq_pilot_supplier_purchases SET
    invoice_ref=nullif(btrim(coalesce(p_invoice_ref,'')),''),
    invoice_date=p_invoice_date, image_sha256=p_image_sha256, image_thumb=p_image_thumb,
    declared_total_cents=p_declared_total_cents, idempotency_key=p_idempotency_key
  WHERE id=v_id AND store_id=p_store;
  RETURN v_res || jsonb_build_object('purchase_id',v_id,'already_committed',false);
EXCEPTION WHEN unique_violation THEN
  SELECT * INTO v_prev FROM public.rfq_pilot_supplier_purchases
    WHERE store_id=p_store AND idempotency_key=p_idempotency_key;
  IF FOUND THEN
    RETURN jsonb_build_object('id',v_prev.id,'purchase_id',v_prev.id,'total_cents',v_prev.total_cents,'already_committed',true,'ok',true);
  END IF;
  RAISE;
END $fn$;

grant execute on function public.rfq_pilot_save_purchase_v3(uuid,uuid,jsonb,bigint,text,uuid,text,text,date,text,text,bigint,text) to authenticated;
grant execute on function public.rfq_pilot_product_batches(uuid,uuid) to authenticated;
grant execute on function public.rfq_pilot_expiring_batches(uuid,integer) to authenticated;
grant execute on function public.rfq_pilot_batch_release_qty(uuid,uuid,uuid,bigint) to authenticated;
