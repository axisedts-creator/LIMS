-- T0B-03: core.users, core.memberships, core.membership_centres — class M (05-SCHEMA §3.3, §5, §6, §7, §10 verbatim), the
-- DEFINER centre helpers app.has_all_centres / app.current_centre_ids (CV §5.8, 08 R3) and the §10 "app helper grants".
-- core.membership_branches + app.tg_scope_user_only are T0B-06.
SET LOCAL ROLE lims_owner;

CREATE TABLE core.users (
  tenant_id uuid NOT NULL, id uuid NOT NULL,
  display_name text NOT NULL, staff_code text,
  email_normalized text, phone_e164 text, last_login_at timestamptz,          -- 08 A3.4
  email_hmac bytea,                                                           -- 08 A25 D-217 (written by C2)
  version integer NOT NULL DEFAULT 1, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT users__pk PRIMARY KEY (tenant_id, id),
  CONSTRAINT users__email_hmac__ck CHECK (octet_length(email_hmac) = 32),                           -- 08 A25 D-217 (NULL passes)
  CONSTRAINT users__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT users__text__ck CHECK (char_length(display_name) BETWEEN 1 AND 120 AND coalesce(char_length(staff_code),0) <= 32),
  CONSTRAINT users__email_normalized__ck CHECK (coalesce(char_length(email_normalized),0) <= 254),   -- 08 A3.4
  CONSTRAINT users__phone_e164__ck CHECK (phone_e164 ~ '^\+[1-9][0-9]{7,14}$')                       -- 08 A3.4 (NULL passes)
);
CREATE UNIQUE INDEX users__tenant_id_email_normalized__uq ON core.users (tenant_id, email_normalized);   -- 08 A3.4

ALTER TABLE core.users ENABLE ROW LEVEL SECURITY;  ALTER TABLE core.users FORCE ROW LEVEL SECURITY;
CREATE POLICY users__select__tenant ON core.users FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY users__insert__tenant ON core.users FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY users__update__tenant ON core.users FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY users__select__owner_only ON core.users FOR SELECT TO lims_owner
  USING (id = nullif(current_setting('app.pre_user_id', true), '')::uuid                   -- C2 identity_user_exists
      OR (current_setting('app.maintenance', true) = 'identity_tenants_for_email_hmacs'    -- app.identity_tenants_for_email_hmacs
          AND email_hmac IS NOT NULL));                                                     -- (08 A25 D-217)
GRANT SELECT, INSERT, UPDATE ON core.users TO lims_app;
CREATE TRIGGER users__audit AFTER INSERT OR UPDATE OR DELETE ON core.users FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();

CREATE TABLE core.memberships (
  id uuid NOT NULL, tenant_id uuid NOT NULL, user_id uuid NOT NULL,
  actor_type text NOT NULL, all_centres boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'active',                                       -- 08 A3.4: the writable lifecycle column
  invited_at timestamptz, accepted_at timestamptz,                             -- 08 A3.4
  deactivated_at timestamptz, deactivated_by uuid, deactivation_reason_code text,   -- 08 A3.4
  locked_at timestamptz, locked_by uuid, lock_reason_code text,                -- locked = locked_at IS NOT NULL (no is_locked column, 08 A3.4)
  lock_reason_text text,                                                       -- 08 A3.4
  last_login_at timestamptz,                                                   -- 08 A3.4
  signatory_display_title text, signatory_registration_no text, signature_image_ref text,
  partner_role text,                                                           -- 08 A28.3 (read by C2)
  version integer NOT NULL DEFAULT 1,
  is_active boolean GENERATED ALWAYS AS (status = 'active') STORED,            -- 08 A3.4: generated on this table only; writers set status, never is_active
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT memberships__pk PRIMARY KEY (id),
  CONSTRAINT memberships__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT memberships__user__fk FOREIGN KEY (tenant_id, user_id) REFERENCES core.users (tenant_id, id),
  CONSTRAINT memberships__actor_type__ck CHECK (actor_type IN ('user','patient','partner')),
  CONSTRAINT memberships__all_centres_user_only__ck CHECK (actor_type = 'user' OR NOT all_centres),   -- 08 R3
  CONSTRAINT memberships__lock__ck CHECK ((locked_at IS NULL) = (locked_by IS NULL)),
  CONSTRAINT memberships__partner_role_presence__ck CHECK ((actor_type = 'partner') = (partner_role IS NOT NULL)),   -- 08 A28.3
  CONSTRAINT memberships__partner_role__ck CHECK (partner_role IN ('partner_admin','partner_member')),            -- 08 A28.3 (NULL passes)
  CONSTRAINT memberships__status__ck CHECK (status IN ('invited','active','deactivated')),            -- 08 A3.4
  CONSTRAINT memberships__lock_reason__ck CHECK (lock_reason_code IN
     ('left_organisation','security_concern','policy_violation','other')),                           -- 08 A3.4 (NULL passes)
  CONSTRAINT memberships__deactivation_reason__ck CHECK (deactivation_reason_code IN
     ('left_organisation','security_concern','policy_violation','other')),                           -- 08 A6.3 (same set as lock_reason_code; NULL passes)
  CONSTRAINT memberships__text__ck CHECK (coalesce(char_length(lock_reason_code),0) <= 64
     AND coalesce(char_length(lock_reason_text),0) <= 500                                            -- 08 A3.4
     AND coalesce(char_length(signatory_display_title),0) <= 200 AND coalesce(char_length(signatory_registration_no),0) <= 40
     AND coalesce(char_length(signature_image_ref),0) <= 512)
);
CREATE UNIQUE INDEX memberships__tenant_id_user_id_actor_type__p_uq ON core.memberships (tenant_id, user_id, actor_type)
  WHERE status IN ('invited','active');                                                              -- 08 A3.4: pending invite blocks a duplicate
CREATE UNIQUE INDEX memberships__user_id__p_uq ON core.memberships (user_id)
  WHERE actor_type = 'user' AND status IN ('invited','active');   -- EXCEPTION (index-exceptions.yaml): one tenant per staff user (08 R27; predicate 08 A3.4)

-- pred_t = tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) — on EVERY __tenant policy,
-- in USING and in WITH CHECK (08 A17 P-16, A23.3).
ALTER TABLE core.memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.memberships FORCE ROW LEVEL SECURITY;
CREATE POLICY memberships__select__tenant ON core.memberships FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY memberships__insert__tenant ON core.memberships FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY memberships__update__tenant ON core.memberships FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY memberships__select__owner_only ON core.memberships FOR SELECT TO lims_owner
  USING (tenant_id = (SELECT app.current_tenant_id())                                -- app.has_all_centres(), app.current_centre_ids()
      OR user_id = nullif(current_setting('app.pre_user_id', true), '')::uuid);      -- C2 pre-tenant lookups (08 A12.1; §4.3 GUC rule)
GRANT SELECT, INSERT, UPDATE ON core.memberships TO lims_app;
CREATE TRIGGER memberships__audit AFTER INSERT OR UPDATE OR DELETE ON core.memberships FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();

CREATE TABLE core.membership_centres (
  tenant_id uuid NOT NULL, membership_id uuid NOT NULL, centre_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  CONSTRAINT membership_centres__pk PRIMARY KEY (tenant_id, membership_id, centre_id),
  CONSTRAINT membership_centres__membership__fk FOREIGN KEY (tenant_id, membership_id) REFERENCES core.memberships (tenant_id, id),
  CONSTRAINT membership_centres__centre__fk FOREIGN KEY (tenant_id, centre_id) REFERENCES core.collection_centres (tenant_id, id)
);

ALTER TABLE core.membership_centres ENABLE ROW LEVEL SECURITY;  ALTER TABLE core.membership_centres FORCE ROW LEVEL SECURITY;
CREATE POLICY membership_centres__select__tenant ON core.membership_centres FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY membership_centres__insert__tenant ON core.membership_centres FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY membership_centres__delete__tenant ON core.membership_centres FOR DELETE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY membership_centres__select__owner_only ON core.membership_centres FOR SELECT TO lims_owner
  USING (tenant_id = (SELECT app.current_tenant_id()));                                     -- app.current_centre_ids() (§4.1)
GRANT SELECT, INSERT, DELETE ON core.membership_centres TO lims_app;
CREATE TRIGGER membership_centres__audit AFTER INSERT OR UPDATE OR DELETE ON core.membership_centres FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();

-- ===================================================================== DEFINER helpers (CV §5.8 verbatim, has_all_centres CASE per 02-CV §5.8 as amended by 08 R3)
CREATE FUNCTION app.has_all_centres() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT CASE app.current_actor_type()
    WHEN 'system' THEN app.current_tenant_id() IS NOT NULL
    WHEN 'user'   THEN coalesce((SELECT m.all_centres FROM core.memberships m
                                 WHERE m.tenant_id = app.current_tenant_id()
                                   AND m.id = nullif(app.current_claims() ->> 'membership_id', '')::uuid
                                   AND m.is_active), false)
    ELSE false                                                  -- device, portal, patient, partner (08 R3)
  END
$$;
CREATE FUNCTION app.current_centre_ids() RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT CASE app.current_actor_type()
    WHEN 'device' THEN coalesce(ARRAY[nullif(app.current_claims() ->> 'centre_id', '')::uuid], '{}')
    ELSE coalesce((SELECT array_agg(mc.centre_id)
                   FROM core.memberships m
                   JOIN core.membership_centres mc ON mc.tenant_id = m.tenant_id AND mc.membership_id = m.id
                   WHERE m.tenant_id = app.current_tenant_id()
                     AND m.id = nullif(app.current_claims() ->> 'membership_id', '')::uuid
                     AND m.is_active), '{}')
  END
$$;
REVOKE ALL ON FUNCTION app.has_all_centres(), app.current_centre_ids() FROM PUBLIC;

-- ===================================================================== app helper grants (05-SCHEMA §10; current_lims_session_id is granted in the helpers stage, T0B-02)
GRANT EXECUTE ON FUNCTION app.current_claims(), app.current_tenant_id(), app.current_actor_id(), app.current_actor_type(),
  app.current_membership_id(), app.has_all_centres(), app.current_centre_ids(), app.is_staff_or_system() TO lims_app, lims_queue;
