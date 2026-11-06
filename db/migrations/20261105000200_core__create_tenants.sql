-- T0B-03: core.tenants (05-SCHEMA §3.1, §5, §6, §10 verbatim) and the two row-trigger functions every audited class-M table uses
-- (05-SCHEMA §4.4, §10 "triggers"; 08 A12.5, A15.5, A20.3, A25 D-215, A28.5). [CONV] The trigger functions ship in this file because
-- core.tenants is the first table that attaches app.tg_row_audit; audit.audit_log itself is created in the audit stage
-- (plpgsql resolves the INSERT target at first call; migrations insert no rows).
SET LOCAL ROLE lims_owner;

-- ===================================================================== triggers
CREATE FUNCTION app.enforce_mutable_columns() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  -- mutable-column list = trigger arguments; coalesce: with no arguments TG_ARGV is NULL and jsonb - NULL is NULL, which would make
  -- every change look "equal" (NULL IS DISTINCT FROM NULL = false) and allow everything (08 A20.3, same bug as A15.5)
  IF (to_jsonb(OLD) - coalesce(TG_ARGV::text[], '{}')) IS DISTINCT FROM (to_jsonb(NEW) - coalesce(TG_ARGV::text[], '{}')) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'immutable_row', DETAIL = TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION app.tg_row_audit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_claims jsonb := app.current_claims();
  -- excluded columns (CR-C15-013). TG_ARGV is NULL when the trigger has no arguments; without coalesce, jsonb - NULL and
  -- key <> ALL (NULL) are NULL, so INSERT/DELETE rows lost their values and every UPDATE looked like a no-op (08 A15.5).
  v_excl text[] := coalesce(TG_ARGV::text[], '{}');
  v_row jsonb; v_old jsonb; v_new jsonb; v_changed text[] := '{}';
  v_maint text := nullif(current_setting('app.maintenance', true), '');   -- 08 A28.5
  v_sub uuid := nullif(app.current_claims() ->> 'sub', '')::uuid;
BEGIN
  -- 08 A25 D-215: a NULL-tenant row of a mixed table (anything but core.tenants, which has no tenant_id column) is not written to
  -- audit_log (tenant_id NOT NULL there); C2 records those changes in identity.platform_events. Checked first: never raises here.
  IF NOT (TG_TABLE_SCHEMA = 'core' AND TG_TABLE_NAME = 'tenants')
     AND nullif((CASE WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END) ->> 'tenant_id', '') IS NULL THEN
    RETURN NULL;
  END IF;
  -- 08 A28.5: inside a maintenance DEFINER (no claims, app.maintenance set) the row is audited as actor_type 'system', actor_id NULL,
  -- detail.maintenance = <function name>; audit_context_missing only when neither claims sub nor app.maintenance is present.
  IF v_sub IS NULL AND v_maint IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'audit_context_missing', DETAIL = TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME;
  END IF;
  IF TG_OP = 'INSERT' THEN
    v_row := to_jsonb(NEW); v_new := v_row - v_excl;                  -- INSERT records the new row
  ELSIF TG_OP = 'DELETE' THEN
    v_row := to_jsonb(OLD); v_old := v_row - v_excl;                  -- DELETE records the old row
  ELSE                                                               -- UPDATE records the changed columns
    v_row := to_jsonb(NEW);
    SELECT coalesce(array_agg(n.key ORDER BY n.key), '{}'),
           jsonb_object_agg(n.key, o.value), jsonb_object_agg(n.key, n.value)
      INTO v_changed, v_old, v_new
      FROM jsonb_each(to_jsonb(NEW)) n
      JOIN jsonb_each(to_jsonb(OLD)) o ON o.key = n.key
     WHERE n.value IS DISTINCT FROM o.value
       AND n.key NOT IN ('updated_at','updated_by','version')
       AND n.key <> ALL (v_excl);                                      -- excluded columns (CR-C15-013; 08 A15.5)
    IF cardinality(v_changed) = 0 THEN RETURN NULL; END IF;          -- no-op update: nothing to audit
  END IF;
  INSERT INTO audit.audit_log (id, tenant_id, centre_id, schema_name, table_name, row_id, action, changed_columns,
                               old_values, new_values, actor_id, actor_type, membership_id, support_session_id,
                               request_id, client_ip, user_agent, detail, occurred_at, created_at, created_by)
  VALUES (app.uuidv7(),
          -- core.tenants has no tenant_id column: its own id, also when no tenant claim is present (platform context, 08 A12.5)
          coalesce(v_row ->> 'tenant_id', CASE WHEN TG_TABLE_SCHEMA = 'core' AND TG_TABLE_NAME = 'tenants' THEN v_row ->> 'id' END)::uuid,
          nullif(v_row ->> 'centre_id', '')::uuid,
          TG_TABLE_SCHEMA, TG_TABLE_NAME, nullif(v_row ->> 'id', '')::uuid, TG_OP, v_changed, v_old, v_new,
          v_sub, CASE WHEN v_sub IS NULL THEN 'system' ELSE coalesce(v_claims ->> 'actor_type', 'user') END,
          nullif(v_claims ->> 'membership_id', '')::uuid, nullif(v_claims ->> 'support_session_id', '')::uuid,
          nullif(current_setting('app.request_id', true), '')::uuid,
          nullif(current_setting('app.client_ip', true), '')::inet,
          left(nullif(current_setting('app.user_agent', true), ''), 512),
          CASE WHEN v_sub IS NULL THEN jsonb_build_object('maintenance', v_maint) END,   -- 08 A28.5
          now(), now(), v_sub);
  RETURN NULL;                                                       -- AFTER trigger
END $$;
REVOKE ALL ON FUNCTION app.enforce_mutable_columns(), app.tg_row_audit() FROM PUBLIC;   -- trigger functions: no direct EXECUTE

-- ===================================================================== core.tenants (class M, root)
CREATE TABLE core.tenants (
  id            uuid        NOT NULL,
  tenant_code   text        NOT NULL,
  legal_name    text        NOT NULL,
  display_name  text        NOT NULL,
  status        text        NOT NULL DEFAULT 'provisioning',
  timezone      text        NOT NULL DEFAULT 'Asia/Kathmandu',
  status_reason text,                                                 -- 08 A3.4
  activated_at  timestamptz,                                          -- 08 A3.4 (lifecycle timestamps, set by C2)
  suspended_at  timestamptz,
  offboarded_at timestamptz,                                          -- 08 A3.4 (C2's former terminated_at)
  billing_live_on date,                                               -- 08 A3.4
  version       integer     NOT NULL DEFAULT 1,
  is_active     boolean     NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid        NOT NULL,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    uuid        NOT NULL,
  CONSTRAINT tenants__pk PRIMARY KEY (id),
  CONSTRAINT tenants__tenant_code__ck CHECK (tenant_code ~ '^[a-z][a-z0-9_]{2,31}$'),
  CONSTRAINT tenants__names__ck CHECK (char_length(legal_name) BETWEEN 1 AND 200 AND char_length(display_name) BETWEEN 1 AND 120),
  CONSTRAINT tenants__status__ck CHECK (status IN ('provisioning','active','suspended','offboarded')),
  CONSTRAINT tenants__timezone__ck CHECK (char_length(timezone) BETWEEN 1 AND 64),
  CONSTRAINT tenants__status_reason__ck CHECK (coalesce(char_length(status_reason),0) <= 500)   -- 08 A3.4
);
CREATE UNIQUE INDEX tenants__tenant_code__uq ON core.tenants (tenant_code);

ALTER TABLE core.tenants ENABLE ROW LEVEL SECURITY;  ALTER TABLE core.tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenants__select__tenant ON core.tenants FOR SELECT TO lims_app
  USING (id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));                 -- guard added (08 A23.3)
CREATE POLICY tenants__insert__tenant ON core.tenants FOR INSERT TO lims_app
  WITH CHECK (id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY tenants__update__tenant ON core.tenants FOR UPDATE TO lims_app
  USING (id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
-- Owner policies on core tables for GUC-bound DEFINERs (§4.3 GUC rule; 08 A12.1, A12.3). TO lims_owner only: a lims_app session that
-- sets these GUCs gains nothing. The functions set them with set_config(…, true) and reset them to '' before returning.
-- One owner SELECT policy per table, so the branches are ORed.
CREATE POLICY tenants__select__owner_only ON core.tenants FOR SELECT TO lims_owner
  USING (id = nullif(current_setting('app.pre_tenant_id', true), '')::uuid                -- C2 identity_resolve_session / identity_login_context (A12.1, A20.1)
      OR current_setting('app.maintenance', true) = 'platform_list_tenants'               -- app.platform_list_tenants (every tenant row)
      OR (current_setting('app.maintenance', true) = 'cron_tenant_ids'                    -- app.cron_tenant_ids (08 A23.1)
          AND status IN ('active','suspended'))
      OR tenant_code = nullif(current_setting('app.pre_tenant_code', true), ''));         -- app.core_resolve_tenant_code (08 A19 D-121)
GRANT SELECT, INSERT, UPDATE ON core.tenants TO lims_app;

-- audited: no trigger arguments (08 A12.5, A15.5)
CREATE TRIGGER tenants__audit AFTER INSERT OR UPDATE OR DELETE ON core.tenants FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
