-- T0C-SALES-1 (LD-321, LD-325; founder blanket authority LD-310; founder priority 2026-11-17 09:18 NPT): the sales hierarchy in schema partners and the collector
-- Allow Collection / Allow Pickup flags in schema homecollection. The LIMS split party model (partner, credit party, doctor, referrer) is kept; attributes are added.
-- New tenant tables (deactivate, never delete: lims_app has SELECT, INSERT, UPDATE only and no DELETE policy):
--   partners.sales_designation      level 1..8 (1 = top), unique per tenant over all rows; switched off with is_active.
--   partners.sales_representative   name, phone, email, user_id, designation_id, manager_id (self reference), joining_date, is_active.
--                                   A representative is never its own manager (CHECK) and a manager chain never loops (BEFORE trigger, WITH RECURSIVE walk
--                                   up the chain under a per-tenant transaction advisory lock, so two concurrent moves cannot close a loop together).
--   partners.party_sales_assignment party_kind (partner | credit_party | doctor | referrer) + party_id (polymorphic, service checked) -> representative,
--                                   effective_from .. effective_to (inclusive, NULL = open). The same party and representative may not overlap
--                                   (BEFORE trigger under an advisory lock per party and representative; btree_gist is not assumed present, so no EXCLUDE).
--   partners.service_area           name, district, area_text, centre_id. ElabAssist keys service areas by pincode; Nepal addresses use district and
--                                   municipality, so the area is free text district + area_text and there is no pincode column.
--   homecollection.collector_flags  one row per membership: allow_collection, allow_pickup boolean NOT NULL DEFAULT true. No row = both true,
--                                   so nothing existing changes (the repo has no collector table; collectors are core.memberships).
-- Personal data: sales_representative.phone / email are excluded from the audit row values (tg_row_audit arguments); the audit keeps ids and changed column names.
-- Additive only: new tables, functions, triggers, policies and grants; no ALTER of an existing table, no data rewrite, no ENUM type, no sequence.
-- Idempotent: IF NOT EXISTS on tables and indexes, constraints inline, each CREATE POLICY guarded by pg_policy, functions and triggers CREATE OR REPLACE.
-- Cloud apply is a founder step (push-cloud.ps1) after 20261117170000_catalog__test_management_parity.sql; not done by this task.
-- DOWN (manual, never automatic; drops entered sales data: founder decision, export first):
--   DROP TABLE IF EXISTS partners.party_sales_assignment, partners.sales_representative, partners.sales_designation, partners.service_area,
--     homecollection.collector_flags CASCADE;
--   DROP FUNCTION IF EXISTS partners.sales_representative__manager_guard(), partners.party_sales_assignment__no_overlap();
SET LOCAL ROLE lims_owner;

-- ---------- (1) designations: levels 1 to 8 ----------
CREATE TABLE IF NOT EXISTS partners.sales_designation (
  id          uuid        NOT NULL,
  tenant_id   uuid        NOT NULL,
  name        text        NOT NULL,
  level       smallint    NOT NULL,
  is_active   boolean     NOT NULL DEFAULT true,
  version     integer     NOT NULL DEFAULT 1,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid        NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  uuid        NOT NULL,
  CONSTRAINT sales_designation__pk PRIMARY KEY (id),
  CONSTRAINT sales_designation__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT sales_designation__tenant_id_level__uq UNIQUE (tenant_id, level),
  CONSTRAINT sales_designation__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT sales_designation__name__ck CHECK (char_length(name) BETWEEN 1 AND 120),
  CONSTRAINT sales_designation__level__ck CHECK (level BETWEEN 1 AND 8)
);

-- ---------- (2) representatives with the manager tree ----------
CREATE TABLE IF NOT EXISTS partners.sales_representative (
  id             uuid        NOT NULL,
  tenant_id      uuid        NOT NULL,
  name           text        NOT NULL,
  phone          text,
  email          text,
  user_id        uuid,
  designation_id uuid        NOT NULL,
  manager_id     uuid,
  joining_date   date,
  is_active      boolean     NOT NULL DEFAULT true,
  version        integer     NOT NULL DEFAULT 1,
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid        NOT NULL,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     uuid        NOT NULL,
  CONSTRAINT sales_representative__pk PRIMARY KEY (id),
  CONSTRAINT sales_representative__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT sales_representative__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT sales_representative__designation__fk FOREIGN KEY (tenant_id, designation_id) REFERENCES partners.sales_designation (tenant_id, id),
  CONSTRAINT sales_representative__manager__fk FOREIGN KEY (tenant_id, manager_id) REFERENCES partners.sales_representative (tenant_id, id),
  CONSTRAINT sales_representative__not_own_manager__ck CHECK (manager_id IS NULL OR manager_id <> id),
  CONSTRAINT sales_representative__name__ck CHECK (char_length(name) BETWEEN 1 AND 200),
  CONSTRAINT sales_representative__phone__ck CHECK (char_length(phone) BETWEEN 1 AND 30),
  CONSTRAINT sales_representative__email__ck CHECK (char_length(email) BETWEEN 3 AND 254)
);
CREATE INDEX IF NOT EXISTS sales_representative__tenant_id_manager_id__idx ON partners.sales_representative (tenant_id, manager_id);
CREATE INDEX IF NOT EXISTS sales_representative__tenant_id_designation_id__idx ON partners.sales_representative (tenant_id, designation_id);
CREATE INDEX IF NOT EXISTS sales_representative__tenant_id_lower_name__idx ON partners.sales_representative (tenant_id, lower(name));

-- a manager chain never loops: walk up from the new manager; reaching the row itself is a loop (the CHECK above covers the direct case)
CREATE OR REPLACE FUNCTION partners.sales_representative__manager_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v_loop boolean;
BEGIN
  IF NEW.manager_id IS NULL THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND NEW.manager_id IS NOT DISTINCT FROM OLD.manager_id AND NEW.id = OLD.id THEN RETURN NEW; END IF;
  IF NEW.manager_id = NEW.id THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'sales_representative_own_manager', DETAIL = NEW.id::text;
  END IF;
  -- one manager change at a time per tenant, so two concurrent moves (a under b, b under a) cannot both pass
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('partners.sales_representative.manager:' || NEW.tenant_id::text, 0));
  WITH RECURSIVE chain (id, manager_id, hops) AS (
    SELECT r.id, r.manager_id, 1
      FROM partners.sales_representative r
     WHERE r.tenant_id = NEW.tenant_id AND r.id = NEW.manager_id
    UNION ALL
    SELECT r.id, r.manager_id, c.hops + 1
      FROM chain c
      JOIN partners.sales_representative r ON r.tenant_id = NEW.tenant_id AND r.id = c.manager_id
     WHERE c.id <> NEW.id AND c.hops < 10000
  )
  SELECT EXISTS (SELECT 1 FROM chain WHERE chain.id = NEW.id) INTO v_loop;
  IF v_loop THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'sales_representative_manager_loop', DETAIL = NEW.id::text;
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER sales_representative__manager_guard BEFORE INSERT OR UPDATE OF manager_id, id ON partners.sales_representative
  FOR EACH ROW EXECUTE FUNCTION partners.sales_representative__manager_guard();

-- ---------- (3) party assignments (effective dated, inclusive, NULL end = open) ----------
CREATE TABLE IF NOT EXISTS partners.party_sales_assignment (
  id                uuid        NOT NULL,
  tenant_id         uuid        NOT NULL,
  party_kind        text        NOT NULL,
  party_id          uuid        NOT NULL,
  representative_id uuid        NOT NULL,
  effective_from    date        NOT NULL,
  effective_to      date,
  version           integer     NOT NULL DEFAULT 1,
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid        NOT NULL,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  updated_by        uuid        NOT NULL,
  CONSTRAINT party_sales_assignment__pk PRIMARY KEY (id),
  CONSTRAINT party_sales_assignment__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT party_sales_assignment__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT party_sales_assignment__representative__fk FOREIGN KEY (tenant_id, representative_id) REFERENCES partners.sales_representative (tenant_id, id),
  CONSTRAINT party_sales_assignment__party_kind__ck CHECK (party_kind IN ('partner','credit_party','doctor','referrer')),
  CONSTRAINT party_sales_assignment__window__ck CHECK (effective_to IS NULL OR effective_to >= effective_from)
);
CREATE INDEX IF NOT EXISTS party_sales_assignment__tenant_id_representative_id__idx ON partners.party_sales_assignment (tenant_id, representative_id, effective_from);
CREATE INDEX IF NOT EXISTS party_sales_assignment__tenant_id_party__idx ON partners.party_sales_assignment (tenant_id, party_kind, party_id);

-- one assignment of a party to a representative for any day: refuse an overlapping window (inclusive end, open end = no end)
CREATE OR REPLACE FUNCTION partners.party_sales_assignment__no_overlap() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('partners.party_sales_assignment:' || NEW.tenant_id::text || ':' || NEW.party_kind
    || ':' || NEW.party_id::text || ':' || NEW.representative_id::text, 0));
  IF EXISTS (SELECT 1 FROM partners.party_sales_assignment a
              WHERE a.tenant_id = NEW.tenant_id AND a.party_kind = NEW.party_kind AND a.party_id = NEW.party_id
                AND a.representative_id = NEW.representative_id AND a.id <> NEW.id
                AND a.effective_from <= coalesce(NEW.effective_to, 'infinity'::date)
                AND NEW.effective_from <= coalesce(a.effective_to, 'infinity'::date)) THEN
    RAISE EXCEPTION USING ERRCODE = '23P01', MESSAGE = 'party_sales_assignment_overlap', DETAIL = NEW.party_kind || ' ' || NEW.party_id::text;
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER party_sales_assignment__no_overlap BEFORE INSERT OR UPDATE ON partners.party_sales_assignment
  FOR EACH ROW EXECUTE FUNCTION partners.party_sales_assignment__no_overlap();

-- ---------- (4) service areas: free text district and area ----------
CREATE TABLE IF NOT EXISTS partners.service_area (
  id          uuid        NOT NULL,
  tenant_id   uuid        NOT NULL,
  name        text        NOT NULL,
  district    text        NOT NULL,
  area_text   text,
  centre_id   uuid,
  is_active   boolean     NOT NULL DEFAULT true,
  version     integer     NOT NULL DEFAULT 1,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid        NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  uuid        NOT NULL,
  CONSTRAINT service_area__pk PRIMARY KEY (id),
  CONSTRAINT service_area__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT service_area__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT service_area__centre__fk FOREIGN KEY (tenant_id, centre_id) REFERENCES core.collection_centres (tenant_id, id),
  CONSTRAINT service_area__name__ck CHECK (char_length(name) BETWEEN 1 AND 200),
  CONSTRAINT service_area__district__ck CHECK (char_length(district) BETWEEN 1 AND 100),
  CONSTRAINT service_area__area_text__ck CHECK (char_length(area_text) BETWEEN 1 AND 500)
);
CREATE INDEX IF NOT EXISTS service_area__tenant_id_district__idx ON partners.service_area (tenant_id, lower(district));

-- ---------- (5) collector flags (homecollection) ----------
CREATE TABLE IF NOT EXISTS homecollection.collector_flags (
  id               uuid        NOT NULL,
  tenant_id        uuid        NOT NULL,
  membership_id    uuid        NOT NULL,
  allow_collection boolean     NOT NULL DEFAULT true,
  allow_pickup     boolean     NOT NULL DEFAULT true,
  version          integer     NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid        NOT NULL,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  updated_by       uuid        NOT NULL,
  CONSTRAINT collector_flags__pk PRIMARY KEY (id),
  CONSTRAINT collector_flags__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT collector_flags__tenant_id_membership_id__uq UNIQUE (tenant_id, membership_id),
  CONSTRAINT collector_flags__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT collector_flags__membership__fk FOREIGN KEY (tenant_id, membership_id) REFERENCES core.memberships (tenant_id, id)
);

-- ---------- (6) RLS by tenant (staff and system actors), policies, grants (no DELETE), audit ----------
ALTER TABLE partners.sales_designation ENABLE ROW LEVEL SECURITY;
ALTER TABLE partners.sales_designation FORCE ROW LEVEL SECURITY;
ALTER TABLE partners.sales_representative ENABLE ROW LEVEL SECURITY;
ALTER TABLE partners.sales_representative FORCE ROW LEVEL SECURITY;
ALTER TABLE partners.party_sales_assignment ENABLE ROW LEVEL SECURITY;
ALTER TABLE partners.party_sales_assignment FORCE ROW LEVEL SECURITY;
ALTER TABLE partners.service_area ENABLE ROW LEVEL SECURITY;
ALTER TABLE partners.service_area FORCE ROW LEVEL SECURITY;
ALTER TABLE homecollection.collector_flags ENABLE ROW LEVEL SECURITY;
ALTER TABLE homecollection.collector_flags FORCE ROW LEVEL SECURITY;

DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'partners.sales_designation'::regclass AND polname = 'sales_designation__select__tenant') THEN
  CREATE POLICY sales_designation__select__tenant ON partners.sales_designation FOR SELECT TO lims_app
    USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
END IF; END $do$;
DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'partners.sales_designation'::regclass AND polname = 'sales_designation__insert__tenant') THEN
  CREATE POLICY sales_designation__insert__tenant ON partners.sales_designation FOR INSERT TO lims_app
    WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
END IF; END $do$;
DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'partners.sales_designation'::regclass AND polname = 'sales_designation__update__tenant') THEN
  CREATE POLICY sales_designation__update__tenant ON partners.sales_designation FOR UPDATE TO lims_app
    USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
    WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
END IF; END $do$;

DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'partners.sales_representative'::regclass AND polname = 'sales_representative__select__tenant') THEN
  CREATE POLICY sales_representative__select__tenant ON partners.sales_representative FOR SELECT TO lims_app
    USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
END IF; END $do$;
DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'partners.sales_representative'::regclass AND polname = 'sales_representative__insert__tenant') THEN
  CREATE POLICY sales_representative__insert__tenant ON partners.sales_representative FOR INSERT TO lims_app
    WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
END IF; END $do$;
DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'partners.sales_representative'::regclass AND polname = 'sales_representative__update__tenant') THEN
  CREATE POLICY sales_representative__update__tenant ON partners.sales_representative FOR UPDATE TO lims_app
    USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
    WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
END IF; END $do$;

DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'partners.party_sales_assignment'::regclass AND polname = 'party_sales_assignment__select__tenant') THEN
  CREATE POLICY party_sales_assignment__select__tenant ON partners.party_sales_assignment FOR SELECT TO lims_app
    USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
END IF; END $do$;
DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'partners.party_sales_assignment'::regclass AND polname = 'party_sales_assignment__insert__tenant') THEN
  CREATE POLICY party_sales_assignment__insert__tenant ON partners.party_sales_assignment FOR INSERT TO lims_app
    WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
END IF; END $do$;
DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'partners.party_sales_assignment'::regclass AND polname = 'party_sales_assignment__update__tenant') THEN
  CREATE POLICY party_sales_assignment__update__tenant ON partners.party_sales_assignment FOR UPDATE TO lims_app
    USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
    WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
END IF; END $do$;

DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'partners.service_area'::regclass AND polname = 'service_area__select__tenant') THEN
  CREATE POLICY service_area__select__tenant ON partners.service_area FOR SELECT TO lims_app
    USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
END IF; END $do$;
DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'partners.service_area'::regclass AND polname = 'service_area__insert__tenant') THEN
  CREATE POLICY service_area__insert__tenant ON partners.service_area FOR INSERT TO lims_app
    WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
END IF; END $do$;
DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'partners.service_area'::regclass AND polname = 'service_area__update__tenant') THEN
  CREATE POLICY service_area__update__tenant ON partners.service_area FOR UPDATE TO lims_app
    USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
    WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
END IF; END $do$;

DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'homecollection.collector_flags'::regclass AND polname = 'collector_flags__select__tenant') THEN
  CREATE POLICY collector_flags__select__tenant ON homecollection.collector_flags FOR SELECT TO lims_app
    USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
END IF; END $do$;
DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'homecollection.collector_flags'::regclass AND polname = 'collector_flags__insert__tenant') THEN
  CREATE POLICY collector_flags__insert__tenant ON homecollection.collector_flags FOR INSERT TO lims_app
    WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
END IF; END $do$;
DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'homecollection.collector_flags'::regclass AND polname = 'collector_flags__update__tenant') THEN
  CREATE POLICY collector_flags__update__tenant ON homecollection.collector_flags FOR UPDATE TO lims_app
    USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
    WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
END IF; END $do$;

GRANT SELECT, INSERT, UPDATE ON partners.sales_designation TO lims_app;
GRANT SELECT, INSERT, UPDATE ON partners.sales_representative TO lims_app;
GRANT SELECT, INSERT, UPDATE ON partners.party_sales_assignment TO lims_app;
GRANT SELECT, INSERT, UPDATE ON partners.service_area TO lims_app;
GRANT SELECT, INSERT, UPDATE ON homecollection.collector_flags TO lims_app;

CREATE OR REPLACE TRIGGER sales_designation__audit AFTER INSERT OR UPDATE OR DELETE ON partners.sales_designation FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE OR REPLACE TRIGGER sales_representative__audit AFTER INSERT OR UPDATE OR DELETE ON partners.sales_representative FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit('phone', 'email');
CREATE OR REPLACE TRIGGER party_sales_assignment__audit AFTER INSERT OR UPDATE OR DELETE ON partners.party_sales_assignment FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE OR REPLACE TRIGGER service_area__audit AFTER INSERT OR UPDATE OR DELETE ON partners.service_area FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE OR REPLACE TRIGGER collector_flags__audit AFTER INSERT OR UPDATE OR DELETE ON homecollection.collector_flags FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
