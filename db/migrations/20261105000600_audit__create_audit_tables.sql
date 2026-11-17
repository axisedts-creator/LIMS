-- T0B-03: audit.g_cs_access_actions (class G), audit.audit_log, audit.access_log — class A (05-SCHEMA §3.6, §3.7, §5, §6, §7, §10
-- verbatim; 08 A12.5, A23.3, A28.5, A28.6). [CONV] Created here because the T0B-03 audit-content tests need app.tg_row_audit's
-- target; T0B-04 adds the access-action seed and db/policies/audit.sql. Audit stage sorts after the core stage (02-TRD §4.2).
SET LOCAL ROLE lims_owner;

CREATE TABLE audit.g_cs_access_actions (
  code text NOT NULL, display text NOT NULL, system text NOT NULL DEFAULT 'lims', system_version text NOT NULL DEFAULT '1',
  sort_order integer NOT NULL DEFAULT 0, is_active boolean NOT NULL DEFAULT true,
  CONSTRAINT g_cs_access_actions__pk PRIMARY KEY (code),
  CONSTRAINT g_cs_access_actions__code__ck CHECK (code ~ '^[a-z_]+\.[a-z_]+$')
);
GRANT SELECT ON audit.g_cs_access_actions TO lims_app;   -- class G: RLS-exempt, read-only

CREATE TABLE audit.audit_log (
  id uuid NOT NULL, tenant_id uuid NOT NULL, centre_id uuid,
  schema_name text NOT NULL, table_name text NOT NULL, row_id uuid, action text NOT NULL,
  changed_columns text[] NOT NULL DEFAULT '{}', old_values jsonb, new_values jsonb,
  actor_id uuid, actor_type text NOT NULL, membership_id uuid, support_session_id uuid,   -- actor_id NULL only for maintenance (08 A28.5)
  request_id uuid, client_ip inet, user_agent text,
  detail jsonb,                                                      -- 08 A28.5: {"maintenance": "<function name>"} [CONV column]
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,    -- = actor_id (NULL for maintenance rows)
  CONSTRAINT audit_log__pk PRIMARY KEY (tenant_id, occurred_at, id),
  CONSTRAINT audit_log__action__ck CHECK (action IN ('INSERT','UPDATE','DELETE')),
  CONSTRAINT audit_log__actor__ck CHECK ((actor_id IS NOT NULL AND created_by IS NOT NULL)
     OR (actor_id IS NULL AND created_by IS NULL AND actor_type = 'system' AND coalesce(detail ? 'maintenance', false))),   -- LD-02 (2026-11-07), 08 A28.5
  CONSTRAINT audit_log__ua__ck CHECK (coalesce(char_length(user_agent),0) <= 512)
);
CREATE INDEX audit_log__tenant_id_id__idx ON audit.audit_log (tenant_id, id);
CREATE INDEX audit_log__tenant_id_table_row__idx ON audit.audit_log (tenant_id, schema_name, table_name, row_id, occurred_at DESC);
CREATE INDEX audit_log__tenant_id_actor__idx ON audit.audit_log (tenant_id, actor_id, occurred_at DESC);
CREATE INDEX audit_log__tenant_id_request_id__idx ON audit.audit_log (tenant_id, request_id);                        -- 08 A28.6 (C2 viewer)
CREATE INDEX audit_log__tenant_id_support_session__p_idx ON audit.audit_log (tenant_id, support_session_id, occurred_at DESC)
  WHERE support_session_id IS NOT NULL;                                                                            -- 08 A28.6

ALTER TABLE audit.audit_log ENABLE ROW LEVEL SECURITY;  ALTER TABLE audit.audit_log FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_log__select__tenant ON audit.audit_log FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())            -- guard added (08 A23.3)
         AND (centre_id IS NULL OR (SELECT app.has_all_centres())                                     -- CR-C2-010 centre clause,
              OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));                        -- cast form (08 A28.6, A16.1)
CREATE POLICY audit_log__insert__owner_only ON audit.audit_log FOR INSERT TO lims_owner
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id())
           OR ((SELECT app.current_tenant_id()) IS NULL                                   -- 08 A12.5: a core.tenants change in
               AND schema_name = 'core' AND table_name = 'tenants' AND row_id = tenant_id  -- platform context, audited under the
               AND (SELECT app.is_platform_actor()))                                      -- tenant row's own id
           OR ((SELECT app.current_actor_id()) IS NULL                                    -- 08 A28.5: a row changed inside a
               AND actor_id IS NULL AND actor_type = 'system'                             -- maintenance DEFINER (no claims),
               AND nullif(current_setting('app.maintenance', true), '') IS NOT NULL       -- audited under the row's tenant_id
               AND detail ->> 'maintenance' = current_setting('app.maintenance', true)));
GRANT SELECT ON audit.audit_log TO lims_app;   -- append-only: no INSERT for lims_app (AC-0B-5.3), no UPDATE/DELETE policy

-- audit.access_log (class A; shared_with: [partner, portal, patient] — INSERT of own rows only, no non-staff SELECT; 08 A23.3)
CREATE TABLE audit.access_log (
  id uuid NOT NULL, tenant_id uuid NOT NULL, centre_id uuid,
  actor_id uuid NOT NULL, actor_type text NOT NULL, membership_id uuid, support_session_id uuid,
  action text NOT NULL, entity_type text NOT NULL, entity_id uuid, purpose_code text,
  outcome text NOT NULL, detail jsonb NOT NULL DEFAULT '{}',
  request_id uuid, client_ip inet, user_agent text,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  CONSTRAINT access_log__pk PRIMARY KEY (tenant_id, occurred_at, id),
  CONSTRAINT access_log__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT access_log__action__fk FOREIGN KEY (action) REFERENCES audit.g_cs_access_actions (code),
  CONSTRAINT access_log__outcome__ck CHECK (outcome IN ('allowed','denied')),
  CONSTRAINT access_log__text__ck CHECK (char_length(entity_type) BETWEEN 1 AND 40 AND coalesce(char_length(purpose_code),0) <= 64
                                         AND coalesce(char_length(user_agent),0) <= 512 AND octet_length(detail::text) <= 4096)
);
CREATE INDEX access_log__tenant_id_id__idx ON audit.access_log (tenant_id, id);
CREATE INDEX access_log__tenant_id_entity__idx ON audit.access_log (tenant_id, entity_type, entity_id, occurred_at DESC);
CREATE INDEX access_log__tenant_id_actor__idx ON audit.access_log (tenant_id, actor_id, occurred_at DESC);
CREATE INDEX access_log__tenant_id_action__idx ON audit.access_log (tenant_id, action, occurred_at DESC);
CREATE INDEX access_log__tenant_id_request_id__idx ON audit.access_log (tenant_id, request_id);                      -- 08 A28.6
CREATE INDEX access_log__tenant_id_support_session__p_idx ON audit.access_log (tenant_id, support_session_id, occurred_at DESC)
  WHERE support_session_id IS NOT NULL;                                                                            -- 08 A28.6

ALTER TABLE audit.access_log ENABLE ROW LEVEL SECURITY;  ALTER TABLE audit.access_log FORCE ROW LEVEL SECURITY;
CREATE POLICY access_log__select__tenant ON audit.access_log FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND (centre_id IS NULL OR (SELECT app.has_all_centres())                                     -- CR-C2-010 centre clause
              OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));                        -- (08 A28.6, A16.1)
CREATE POLICY access_log__insert__tenant ON audit.access_log FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
              AND (centre_id IS NULL OR (SELECT app.has_all_centres())                                -- LD-21 (CR-C0-T0B-08 item 2)
                   OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));                   -- centre clause on INSERT (08 A16.1)
CREATE POLICY access_log__insert__partner ON audit.access_log FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND actor_id = (SELECT app.current_actor_id())
              AND (SELECT app.current_actor_type()) = 'partner');
CREATE POLICY access_log__insert__portal ON audit.access_log FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND actor_id = (SELECT app.current_actor_id())
              AND (SELECT app.current_actor_type()) = 'portal');
CREATE POLICY access_log__insert__patient ON audit.access_log FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND actor_id = (SELECT app.current_actor_id())
              AND (SELECT app.current_actor_type()) = 'patient');
GRANT SELECT, INSERT ON audit.access_log TO lims_app;
