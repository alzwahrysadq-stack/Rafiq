-- No devices are changed by this migration. Transfers require the owner's explicit UI choice.
CREATE TABLE public.rfq_pilot_device_transfers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id uuid NOT NULL REFERENCES public.rfq_pilot_stores(id),
  actor_id uuid NOT NULL REFERENCES auth.users(id),
  old_device uuid NOT NULL,
  new_device uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (old_device <> new_device),
  UNIQUE (store_id,old_device,new_device)
);
ALTER TABLE public.rfq_pilot_device_transfers ENABLE ROW LEVEL SECURITY;
CREATE POLICY rfq_pilot_device_transfers_owner ON public.rfq_pilot_device_transfers
FOR SELECT TO authenticated USING ((SELECT public.rfq_pilot_is_owner(store_id)));
REVOKE ALL ON public.rfq_pilot_device_transfers FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.rfq_pilot_device_transfers TO authenticated;

CREATE OR REPLACE FUNCTION public.rfq_pilot_replace_own_device(p_store uuid,p_old uuid,p_new uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE old_row public.rfq_pilot_devices%rowtype; new_row public.rfq_pilot_devices%rowtype;
BEGIN
  IF NOT public.rfq_pilot_is_owner(p_store) OR NOT public.rfq_pilot_license_current(p_store) THEN
    RAISE EXCEPTION 'active_owner_license_required';
  END IF;
  IF p_old IS NULL OR p_new IS NULL OR p_old = p_new THEN RAISE EXCEPTION 'invalid_device_transfer'; END IF;
  PERFORM 1 FROM public.rfq_pilot_stores WHERE id=p_store FOR UPDATE;
  SELECT * INTO old_row FROM public.rfq_pilot_devices WHERE store_id=p_store AND id=p_old FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'own_approved_device_required'; END IF;
  SELECT * INTO new_row FROM public.rfq_pilot_devices WHERE store_id=p_store AND id=p_new FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'own_pending_device_required'; END IF;
  IF old_row.user_id <> auth.uid() OR new_row.user_id <> auth.uid()
     OR old_row.kind NOT IN ('owner_phone','web') OR new_row.kind <> old_row.kind THEN
    RAISE EXCEPTION 'own_same_kind_devices_required';
  END IF;
  IF old_row.status='revoked' AND new_row.status='approved' AND EXISTS (
    SELECT 1 FROM public.rfq_pilot_device_transfers
    WHERE store_id=p_store AND old_device=p_old AND new_device=p_new AND actor_id=auth.uid()
  ) THEN RETURN p_new; END IF;
  IF old_row.status<>'approved' OR new_row.status<>'pending' THEN RAISE EXCEPTION 'device_transfer_state_changed'; END IF;
  IF EXISTS (SELECT 1 FROM public.rfq_pilot_shifts WHERE store_id=p_store AND cashier_device_id=p_old AND status='open')
     OR EXISTS (SELECT 1 FROM public.rfq_pilot_worker_leases WHERE store_id=p_store AND device_id=p_old AND lease_until>now()) THEN
    RAISE EXCEPTION 'old_device_has_active_shift_or_session';
  END IF;
  UPDATE public.rfq_pilot_devices SET status='revoked' WHERE store_id=p_store AND id=p_old;
  UPDATE public.rfq_pilot_devices SET status='approved',approved_by=auth.uid(),approved_at=now()
    WHERE store_id=p_store AND id=p_new;
  INSERT INTO public.rfq_pilot_device_transfers(store_id,actor_id,old_device,new_device)
    VALUES(p_store,auth.uid(),p_old,p_new);
  RETURN p_new;
END;
$function$;
REVOKE ALL ON FUNCTION public.rfq_pilot_replace_own_device(uuid,uuid,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rfq_pilot_replace_own_device(uuid,uuid,uuid) TO authenticated;

-- Re-approving the same device is a no-op, even when all seats are occupied.
CREATE OR REPLACE FUNCTION public.rfq_pilot_approve_device(p_store uuid,p_device uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE v_seats integer; v_count integer; v_status text;
BEGIN
  IF NOT public.rfq_pilot_is_owner(p_store) THEN RAISE EXCEPTION 'owner_required'; END IF;
  IF NOT public.rfq_pilot_license_current(p_store) THEN RAISE EXCEPTION 'license_expired'; END IF;
  SELECT seat_limit INTO v_seats FROM public.rfq_pilot_stores WHERE id=p_store FOR UPDATE;
  SELECT status INTO v_status FROM public.rfq_pilot_devices WHERE store_id=p_store AND id=p_device FOR UPDATE;
  IF v_status='approved' THEN RETURN; END IF;
  IF v_status IS DISTINCT FROM 'pending' THEN RAISE EXCEPTION 'pending_device_required'; END IF;
  SELECT count(*) INTO v_count FROM public.rfq_pilot_devices WHERE store_id=p_store AND status='approved';
  IF v_count>=v_seats THEN RAISE EXCEPTION 'device_limit_reached'; END IF;
  UPDATE public.rfq_pilot_devices SET status='approved',approved_by=auth.uid(),approved_at=now()
    WHERE store_id=p_store AND id=p_device;
END;
$function$;
