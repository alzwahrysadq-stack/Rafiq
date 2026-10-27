-- 6ج (أوفلاين-أول) + مراجعة 2: صنْف أُنشئ دون اتصال يحمل معرفًا محليًا (uuid من الهاتف).
-- عند المزامنة يقبل الخادم المعرف الصريح مرة واحدة بلا تكرار، مع عزل تام بين المتاجر:
--   * المعرف يخص متجرًا آخر            -> رفض صريح (لا تعديل لبيانات الغير داخل دالة definer).
--   * المعرف غير موجود في هذا المتجر   -> إدراج بالمعرف نفسه مع الرصيد المبدئي.
--   * المعرف موجود وبنفس البيانات      -> إقرار إعادة إرسال مطابقة (رد ضائع بعد نجاح): إرجاع المعرف بلا تغيير ولا خطأ.
--   * المعرف موجود وبيانات مختلفة      -> تعديل بيانات بلا مساس بالرصيد (الرصيد المبدئي مرفوض كما كان).
-- لا حذف ولا تعديل لبيانات قائمة. التواقيع والأذونات لا تتغير (CREATE OR REPLACE).
create or replace function public.rfq_pilot_save_product(p_store uuid,p_id uuid,p_name text,
  p_barcode text,p_unit text,p_price_cents bigint,p_cost_cents bigint,
  p_initial_stock_milli bigint default 0) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_name text; v_barcode text; v_same boolean; v_other boolean;
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
  if p_id is not null then
    select exists(select 1 from public.rfq_pilot_products where id=p_id and store_id<>p_store) into v_other;
    if v_other then
      raise exception 'product_id_belongs_to_another_store';
    end if;
  end if;
  if p_id is null then
    insert into public.rfq_pilot_products(store_id,name,barcode,unit,price_cents,cost_cents,stock_milli)
      values(p_store,v_name,v_barcode,btrim(p_unit),p_price_cents,p_cost_cents,p_initial_stock_milli)
      returning id into v_id;
  else
    select (name=v_name and barcode is not distinct from v_barcode and unit=btrim(p_unit)
            and price_cents=p_price_cents and cost_cents=p_cost_cents)
      into v_same
      from public.rfq_pilot_products where id=p_id and store_id=p_store;
    if v_same is null then
      -- غير موجود بعد: إنشاء أول بمعرف محلي ورصيد مبدئي؛ حارس تعارض يمنع أي لمس لصف متجر آخر.
      insert into public.rfq_pilot_products(id,store_id,name,barcode,unit,price_cents,cost_cents,stock_milli)
        values(p_id,p_store,v_name,v_barcode,btrim(p_unit),p_price_cents,p_cost_cents,p_initial_stock_milli)
        on conflict (id) do update set
          name=excluded.name,barcode=excluded.barcode,unit=excluded.unit,
          price_cents=excluded.price_cents,cost_cents=excluded.cost_cents,updated_at=now()
        where public.rfq_pilot_products.store_id=p_store;
      v_id := p_id;
    elsif v_same and p_initial_stock_milli <> 0 then
      -- إعادة إرسال مطابقة بعد ضياع الرد: مقبولة بلا تغيير بيانات ولا رصيد ولا خطأ.
      return p_id;
    else
      if p_initial_stock_milli <> 0 then raise exception 'use_audited_stock_adjustment'; end if;
      update public.rfq_pilot_products set name=v_name,barcode=v_barcode,unit=btrim(p_unit),
        price_cents=p_price_cents,cost_cents=p_cost_cents,updated_at=now()
        where store_id=p_store and id=p_id;
      v_id := p_id;
    end if;
  end if;
  return v_id;
end $$;
