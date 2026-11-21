-- T0C-CONTENT-1 (LD-313, LD-325; founder 2026-11-17 04:57 NPT "do not leave any function"; ElabAssist "News and Updates", "Slider / Banner Image Upload",
-- "Upload Special Offers", "Contact Us", "Profile Image Upload").
-- Two NEW tenant tables, nothing else touched (additive, no data rewrite):
--   engagement.portal_content (kind news | banner | offer | contact, title, body (restricted Markdown, LD-313 d), image_attachment_id, link_url (https only),
--     starts_on, ends_on, sort_order, is_active (the brief's "active", named like the neighbouring tables), published_at): staff (user, system) read and write every row of the tenant; a patient actor reads only
--     active rows inside their date window (starts_on <= current_date <= ends_on, open ends allowed) and never writes. Deactivate, never delete.
--   engagement.profile_image (profile_kind doctor | centre | staff, profile_id, image_attachment_id, is_active): one row per (tenant_id, profile_kind, profile_id);
--     set = upsert, clear = is_active false (the row stays). Staff only.
-- Images reuse the existing branding image path (identity.branding_assets, uploadBrandingAsset: re-encoded, size and type limited): composite FK
-- (tenant_id, image_attachment_id) -> identity.branding_assets (tenant_id, id); no new upload table.
-- body: the contract enforces the Markdown subset (headings, bold, italic, lists, https links; no raw HTML, no images); the table holds the
-- defence in depth part: no "<" at all and at most 20000 characters. link_url: https only, at most 2048 characters, no whitespace.
-- Idempotent: IF NOT EXISTS everywhere, constraints inline, each CREATE POLICY guarded by pg_policy, triggers CREATE OR REPLACE.
-- Cloud apply is a founder step (push-cloud), after 20261117120000; not done by this task.
-- DOWN (manual, never automatic; drops the portal content history: founder decision, export first):
--   DROP TABLE IF EXISTS engagement.profile_image, engagement.portal_content;
SET LOCAL ROLE lims_owner;

-- ---------- (1) engagement.portal_content ----------
CREATE TABLE IF NOT EXISTS engagement.portal_content (
  id                  uuid        NOT NULL,
  tenant_id           uuid        NOT NULL,
  kind                text        NOT NULL,
  title               text        NOT NULL,
  body                text,
  image_attachment_id uuid,
  link_url            text,
  starts_on           date,
  ends_on             date,
  sort_order          integer     NOT NULL DEFAULT 0,
  is_active           boolean     NOT NULL DEFAULT true,
  published_at        timestamptz,
  version             integer     NOT NULL DEFAULT 1,
  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid        NOT NULL,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  updated_by          uuid        NOT NULL,
  CONSTRAINT portal_content__pk PRIMARY KEY (id),
  CONSTRAINT portal_content__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT portal_content__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT portal_content__image__fk FOREIGN KEY (tenant_id, image_attachment_id) REFERENCES identity.branding_assets (tenant_id, id),
  CONSTRAINT portal_content__kind__ck CHECK (kind IN ('news','banner','offer','contact')),
  CONSTRAINT portal_content__title__ck CHECK (char_length(title) BETWEEN 1 AND 200 AND position('<' IN title) = 0),
  CONSTRAINT portal_content__body__ck CHECK (body IS NULL OR (char_length(body) <= 20000 AND body !~ '<')),
  CONSTRAINT portal_content__link_url__ck CHECK (link_url IS NULL OR (link_url ~ '^https://[^[:space:]<>"]+$' AND char_length(link_url) <= 2048)),
  CONSTRAINT portal_content__window__ck CHECK (starts_on IS NULL OR ends_on IS NULL OR ends_on >= starts_on),
  CONSTRAINT portal_content__sort_order__ck CHECK (sort_order BETWEEN 0 AND 100000),
  CONSTRAINT portal_content__version__ck CHECK (version >= 1)
);
CREATE INDEX IF NOT EXISTS portal_content__tenant_id_kind_sort_order__idx ON engagement.portal_content (tenant_id, kind, sort_order);

-- ---------- (2) engagement.profile_image ----------
CREATE TABLE IF NOT EXISTS engagement.profile_image (
  id                  uuid        NOT NULL,
  tenant_id           uuid        NOT NULL,
  profile_kind        text        NOT NULL,
  profile_id          uuid        NOT NULL,
  image_attachment_id uuid        NOT NULL,
  is_active           boolean     NOT NULL DEFAULT true,
  version             integer     NOT NULL DEFAULT 1,
  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid        NOT NULL,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  updated_by          uuid        NOT NULL,
  CONSTRAINT profile_image__pk PRIMARY KEY (id),
  CONSTRAINT profile_image__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT profile_image__profile__uq UNIQUE (tenant_id, profile_kind, profile_id),
  CONSTRAINT profile_image__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT profile_image__image__fk FOREIGN KEY (tenant_id, image_attachment_id) REFERENCES identity.branding_assets (tenant_id, id),
  CONSTRAINT profile_image__profile_kind__ck CHECK (profile_kind IN ('doctor','centre','staff')),
  CONSTRAINT profile_image__version__ck CHECK (version >= 1)
);

-- ---------- (3) RLS: staff (user, system) read and write their tenant; patients read active portal_content inside its window; profile_image staff only ----------
ALTER TABLE engagement.portal_content ENABLE ROW LEVEL SECURITY;
ALTER TABLE engagement.portal_content FORCE ROW LEVEL SECURITY;
ALTER TABLE engagement.profile_image ENABLE ROW LEVEL SECURITY;
ALTER TABLE engagement.profile_image FORCE ROW LEVEL SECURITY;
DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'engagement.portal_content'::regclass AND polname = 'portal_content__select__tenant') THEN
  CREATE POLICY portal_content__select__tenant ON engagement.portal_content FOR SELECT TO lims_app
    USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system'));
END IF; END $do$;
DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'engagement.portal_content'::regclass AND polname = 'portal_content__select__patient') THEN
  CREATE POLICY portal_content__select__patient ON engagement.portal_content FOR SELECT TO lims_app
    USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'patient' AND is_active
           AND (starts_on IS NULL OR starts_on <= current_date) AND (ends_on IS NULL OR ends_on >= current_date));
END IF; END $do$;
DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'engagement.portal_content'::regclass AND polname = 'portal_content__insert__tenant') THEN
  CREATE POLICY portal_content__insert__tenant ON engagement.portal_content FOR INSERT TO lims_app
    WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system'));
END IF; END $do$;
DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'engagement.portal_content'::regclass AND polname = 'portal_content__update__tenant') THEN
  CREATE POLICY portal_content__update__tenant ON engagement.portal_content FOR UPDATE TO lims_app
    USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system'))
    WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system'));
END IF; END $do$;
DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'engagement.profile_image'::regclass AND polname = 'profile_image__select__tenant') THEN
  CREATE POLICY profile_image__select__tenant ON engagement.profile_image FOR SELECT TO lims_app
    USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system'));
END IF; END $do$;
DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'engagement.profile_image'::regclass AND polname = 'profile_image__insert__tenant') THEN
  CREATE POLICY profile_image__insert__tenant ON engagement.profile_image FOR INSERT TO lims_app
    WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system'));
END IF; END $do$;
DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'engagement.profile_image'::regclass AND polname = 'profile_image__update__tenant') THEN
  CREATE POLICY profile_image__update__tenant ON engagement.profile_image FOR UPDATE TO lims_app
    USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system'))
    WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system'));
END IF; END $do$;
GRANT SELECT, INSERT, UPDATE ON engagement.portal_content TO lims_app;
GRANT SELECT, INSERT, UPDATE ON engagement.profile_image TO lims_app;
CREATE OR REPLACE TRIGGER portal_content__audit AFTER INSERT OR UPDATE OR DELETE ON engagement.portal_content FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE OR REPLACE TRIGGER profile_image__audit AFTER INSERT OR UPDATE OR DELETE ON engagement.profile_image FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
