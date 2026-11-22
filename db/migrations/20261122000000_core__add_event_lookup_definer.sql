-- 20261122000000_core__add_event_lookup_definer.sql
-- T15: Secure definer function to retrieve persisted event_id on idempotency duplicate
-- without non-staff SELECT on core.event_log and without weakening RLS (08 A23.3).
SET LOCAL ROLE lims_owner;

CREATE POLICY event_log__select__owner_lookup ON core.event_log FOR SELECT TO lims_owner
  USING (tenant_id = (SELECT app.current_tenant_id())
         AND current_setting('app.maintenance', true) = 'core_lookup_event_id');

CREATE OR REPLACE FUNCTION app.core_lookup_event_id(p_event_type text, p_idempotency_key text)
RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE
  v_event_id uuid;
  v_prev_maint text;
BEGIN
  v_prev_maint := current_setting('app.maintenance', true);
  PERFORM set_config('app.maintenance', 'core_lookup_event_id', true);

  SELECT e.event_id INTO v_event_id
  FROM core.event_log e
  WHERE e.tenant_id = (SELECT app.current_tenant_id())
    AND e.event_type = p_event_type
    AND e.idempotency_key = p_idempotency_key
    AND (
      (SELECT app.is_staff_or_system())
      OR e.created_by = (SELECT app.current_actor_id())
    )
  LIMIT 1;

  IF v_prev_maint IS NULL THEN
    PERFORM set_config('app.maintenance', '', true);
  ELSE
    PERFORM set_config('app.maintenance', v_prev_maint, true);
  END IF;

  RETURN v_event_id;
END;
$$;

REVOKE ALL ON FUNCTION app.core_lookup_event_id(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.core_lookup_event_id(text, text) TO lims_app;
