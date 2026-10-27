-- رفع 130 (2026-10-23): الملفات الشخصية (اسم/صورة) + صلاحية العامل لإضافة الموردين بنظام الطلب
-- يُنفَّذ على مشروع Supabase؛ مرافق إصلاحات الرسائل في الملاحظات (wa_invoice_mode='pdf' + rfq_pilot_sms_ack).
create table if not exists public.rfq_pilot_user_profiles (
  store_id uuid not null, user_id uuid not null,
  display_name text, photo text, updated_at timestamptz not null default now(),
  primary key (store_id, user_id));
alter table public.rfq_pilot_user_profiles enable row level security;

create table if not exists public.rfq_pilot_member_perms (
  store_id uuid not null, user_id uuid not null,
  can_add_suppliers boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (store_id, user_id));
alter table public.rfq_pilot_member_perms enable row level security;

create table if not exists public.rfq_pilot_supplier_requests (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null, worker_id uuid not null,
  name text not null, kind text not null default 'supplier',
  description text, phone text,
  status text not null default 'pending',
  decided_by uuid, decided_at timestamptz, reason text,
  supplier_id uuid, created_at timestamptz not null default now());
alter table public.rfq_pilot_supplier_requests enable row level security;

create or replace function public.rfq_pilot_save_my_profile(p_store uuid, p_name text, p_photo text)
returns void language sql security definer set search_path='' as $$
  insert into public.rfq_pilot_user_profiles(store_id,user_id,display_name,photo,updated_at)
  values (p_store,auth.uid(),nullif(left(coalesce(p_name,''),60),''),
          case when p_photo is null then null else nullif(p_photo,'') end, now())
  on conflict (store_id,user_id) do update set
    display_name=coalesce(excluded.display_name, public.rfq_pilot_user_profiles.display_name),
    photo=case when p_photo is null then public.rfq_pilot_user_profiles.photo else excluded.photo end,
    updated_at=now();
$$;

create or replace function public.rfq_pilot_store_profiles(p_store uuid)
returns table(user_id uuid, display_name text, photo text, role text)
language sql security definer set search_path='' as $$
  select m.user_id, up.display_name, up.photo, m.role
  from public.rfq_pilot_members m
  left join public.rfq_pilot_user_profiles up on up.store_id=m.store_id and up.user_id=m.user_id
  where m.store_id=p_store
    and exists(select 1 from public.rfq_pilot_members me where me.store_id=p_store and me.user_id=auth.uid());
$$;

create or replace function public.rfq_pilot_request_supplier(p_store uuid,p_name text,p_kind text,p_description text,p_phone text)
returns uuid language plpgsql security definer set search_path='' as $$
declare v_id uuid; v_role text; v_can boolean;
begin
  select role into v_role from public.rfq_pilot_members where store_id=p_store and user_id=auth.uid() and active;
  if v_role is null then raise 'عضو غير معروف'; end if;
  if v_role<>'owner' then
    select can_add_suppliers into v_can from public.rfq_pilot_member_perms where store_id=p_store and user_id=auth.uid();
    if coalesce(v_can,false)=false then raise 'لا تملك صلاحية إضافة الموردين — يفعّلها المالك لك'; end if;
  end if;
  insert into public.rfq_pilot_supplier_requests(store_id,worker_id,name,kind,description,phone)
  values (p_store,auth.uid(),left(trim(p_name),120),coalesce(nullif(p_kind,''),'supplier'),
          nullif(left(coalesce(p_description,''),300),''),nullif(trim(p_phone),''))
  returning id into v_id;
  return v_id;
end $$;

create or replace function public.rfq_pilot_decide_supplier_request(p_store uuid,p_id uuid,p_approve boolean,p_reason text)
returns void language plpgsql security definer set search_path='' as $$
declare v_row public.rfq_pilot_supplier_requests%rowtype; v_sup uuid;
begin
  if not exists(select 1 from public.rfq_pilot_members where store_id=p_store and user_id=auth.uid() and role='owner') then
    raise 'قرار الموافقة للمالك فقط';
  end if;
  select * into v_row from public.rfq_pilot_supplier_requests where id=p_id and store_id=p_store;
  if not found then raise 'الطلب غير موجود'; end if;
  if v_row.status<>'pending' then raise 'الطلب محسوم سابقًا'; end if;
  if p_approve then
    insert into public.rfq_pilot_suppliers(store_id,name,phone,kind,notes,active,created_by)
    values (p_store,v_row.name,v_row.phone,v_row.kind,coalesce(v_row.description,''),true,auth.uid())
    returning id into v_sup;
    update public.rfq_pilot_supplier_requests set status='approved',decided_by=auth.uid(),decided_at=now(),
      reason=nullif(left(coalesce(p_reason,''),200),''),supplier_id=v_sup where id=p_id;
  else
    update public.rfq_pilot_supplier_requests set status='rejected',decided_by=auth.uid(),decided_at=now(),
      reason=nullif(left(coalesce(p_reason,''),200),'') where id=p_id;
  end if;
end $$;

create or replace function public.rfq_pilot_supplier_requests_list(p_store uuid)
returns table(id uuid,name text,kind text,description text,phone text,status text,worker_id uuid,worker_name text,created_at timestamptz,reason text)
language sql security definer set search_path='' as $$
  select r.id,r.name,r.kind,r.description,r.phone,r.status,r.worker_id,up.display_name,r.created_at,r.reason
  from public.rfq_pilot_supplier_requests r
  left join public.rfq_pilot_user_profiles up on up.store_id=r.store_id and up.user_id=r.worker_id
  where r.store_id=p_store
    and (exists(select 1 from public.rfq_pilot_members me where me.store_id=p_store and me.user_id=auth.uid() and me.role='owner')
         or r.worker_id=auth.uid())
  order by r.created_at desc limit 50;
$$;

create or replace function public.rfq_pilot_set_member_perm(p_store uuid,p_user uuid,p_can_add_suppliers boolean)
returns void language sql security definer set search_path='' as $$
  insert into public.rfq_pilot_member_perms(store_id,user_id,can_add_suppliers,updated_at)
  select p_store,p_user,p_can_add_suppliers,now()
  where exists(select 1 from public.rfq_pilot_members me where me.store_id=p_store and me.user_id=auth.uid() and me.role='owner')
  on conflict (store_id,user_id) do update set can_add_suppliers=excluded.can_add_suppliers,updated_at=now();
$$;

create or replace function public.rfq_pilot_member_perms_list(p_store uuid)
returns table(user_id uuid,display_name text,role text,can_add_suppliers boolean)
language sql security definer set search_path='' as $$
  select m.user_id,up.display_name,m.role,coalesce(p.can_add_suppliers,false)
  from public.rfq_pilot_members m
  left join public.rfq_pilot_user_profiles up on up.store_id=m.store_id and up.user_id=m.user_id
  left join public.rfq_pilot_member_perms p on p.store_id=m.store_id and p.user_id=m.user_id
  where m.store_id=p_store
    and exists(select 1 from public.rfq_pilot_members me where me.store_id=p_store and me.user_id=auth.uid() and me.role='owner');
$$;

-- إصلاحات الرسائل المرافقة (نُفّذت أيضًا في الجلسة):
-- 1) UPDATE rfq_pilot_message_settings SET wa_invoice_mode='pdf';  -- رجوع «PDF + نص»
-- 2) rfq_pilot_sms_ack: لا يخزّن نص الحالة كخطأ عند النجاح (error=null when p_ok)
-- 3) تصحيح أخطاء SMS الكاذبة: status='sent' WHERE status='failed' AND error='submitted'
