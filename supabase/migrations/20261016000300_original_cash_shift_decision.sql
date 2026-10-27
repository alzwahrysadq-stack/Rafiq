-- Rafiq TEST PROJECT ONLY — incremental shift-decision upgrade, NOT the installer.
-- Before running in Supabase SQL Editor, verify the correct test project and
-- that the previously approved single-file pilot schema was installed already.
-- Paste THIS ENTIRE FILE once, in one SQL Editor run. No passwords/API keys here.
-- No Room data is read, moved, cleared, or synchronized by this migration.
-- It does not make the original POS, debts or cash ledger cloud-connected.
-- 'rejected' is an owner's audited decision, distinct from legacy 'canceled'.
begin;

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

commit;
