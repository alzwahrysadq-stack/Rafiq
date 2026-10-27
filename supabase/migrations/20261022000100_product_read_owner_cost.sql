-- Public catalog fields remain column-scoped and protected by existing RLS.
-- Purchase costs must never become directly readable by the authenticated role.
GRANT SELECT (category) ON TABLE public.rfq_pilot_products TO authenticated;

CREATE OR REPLACE FUNCTION public.rfq_pilot_owner_product_costs(p_store uuid)
RETURNS TABLE(id uuid, cost_cents bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF NOT public.rfq_pilot_is_owner(p_store) THEN
    RAISE EXCEPTION 'owner_required' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
    SELECT p.id, p.cost_cents
    FROM public.rfq_pilot_products p
    WHERE p.store_id = p_store AND p.active;
END;
$function$;
REVOKE ALL ON FUNCTION public.rfq_pilot_owner_product_costs(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.rfq_pilot_owner_product_costs(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.rfq_pilot_owner_product_costs(uuid) TO authenticated;
