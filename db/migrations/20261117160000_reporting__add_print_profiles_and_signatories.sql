-- T0C-PRINTCFG-1 (LD-316, LD-319(1), LD-335; founder 2026-11-17 08:39 NPT: own notepad header and footer on printed reports and bills, signer profiles, one plain black and white bill).
-- Two NEW tenant tables and one new column:
--   reporting.print_profile: the print profile per tenant, branch (NULL = the lab default), document kind (report | invoice | credit_note) and recipient type
--     (LD-319(1): patient | doctor | franchise | laboratory | other; NULL = every recipient). paper_mode letterhead_image | typed_header_footer | preprinted_paper | plain.
--     header_text and footer_text are plain text only: at most 8 lines of at most 120 characters, no markup (no < or >), no control character other than the newline.
--     reserve_top_mm 0..80 and reserve_bottom_mm 0..60 (blank space for the lab own pre printed notepad), font_size_pt 8..12, show_seller_pan defaults to true.
--     One ACTIVE row per (tenant, branch, document kind, recipient type); a NULL branch and a NULL recipient type each count as one value; inactive rows are history.
--   reporting.signatory_profile: one row per user (active or not): display_name, title, registration_no, signature_asset_id (an uploaded image file id, nullable;
--     no foreign key here: the file store is T0B-STORAGE-1, the handler checks the id). Only sign-offs by a lab.result.approve holder print as a signature (LD-316, T0B/T0D).
--   billing.print_log.style: full | plain_bw, NOT NULL DEFAULT 'full' (the print record stores the style used; rows printed before read full).
-- Both new tables: RLS enabled and forced, tenant and staff/system scoped policies (patient and partner claims see nothing), lims_app SELECT, INSERT, UPDATE
--   (no DELETE: a profile is deactivated, not deleted), row audit trigger (class M, audited).
-- No data rewrite: new tables only plus one ADD COLUMN with a constant default (no table rewrite); no UPDATE / INSERT / DELETE of rows; print_log grants unchanged (append only).
-- Idempotent: IF NOT EXISTS everywhere, each CREATE POLICY guarded by pg_policy, triggers CREATE OR REPLACE.
-- Cloud apply is a founder step (push-cloud); not done by this task.
-- DOWN (manual, never automatic; drops the lab print settings and signer profiles: founder decision, export first):
--   DROP TABLE IF EXISTS reporting.print_profile; DROP TABLE IF EXISTS reporting.signatory_profile; ALTER TABLE billing.print_log DROP COLUMN IF EXISTS style;
SET LOCAL ROLE lims_owner;

CREATE TABLE IF NOT EXISTS reporting.print_profile (
  id                uuid        NOT NULL,
  tenant_id         uuid        NOT NULL,
  branch_id         uuid,
  document_kind     text        NOT NULL,
  recipient_type    text,
  paper_mode        text        NOT NULL,
  header_text       text        NOT NULL DEFAULT '',
  footer_text       text        NOT NULL DEFAULT '',
  reserve_top_mm    smallint    NOT NULL DEFAULT 0,
  reserve_bottom_mm smallint    NOT NULL DEFAULT 0,
  show_logo         boolean     NOT NULL DEFAULT false,
  show_seller_pan   boolean     NOT NULL DEFAULT true,
  grayscale         boolean     NOT NULL DEFAULT false,
  font_size_pt      smallint    NOT NULL DEFAULT 10,
  is_active         boolean     NOT NULL DEFAULT true,
  version           integer     NOT NULL DEFAULT 1,
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid        NOT NULL,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  updated_by        uuid        NOT NULL,
  CONSTRAINT print_profile__pk PRIMARY KEY (id),
  CONSTRAINT print_profile__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT print_profile__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT print_profile__branch__fk FOREIGN KEY (tenant_id, branch_id) REFERENCES core.branches (tenant_id, id),
  CONSTRAINT print_profile__document_kind__ck CHECK (document_kind IN ('report','invoice','credit_note')),
  CONSTRAINT print_profile__recipient_type__ck CHECK (recipient_type IN ('patient','doctor','franchise','laboratory','other')),
  CONSTRAINT print_profile__paper_mode__ck CHECK (paper_mode IN ('letterhead_image','typed_header_footer','preprinted_paper','plain')),
  -- plain text: at most 8 lines of at most 120 characters, no < or >, no control character except the newline (LD-316)
  CONSTRAINT print_profile__header_text__ck CHECK (header_text ~ '^[^<>\x01-\x1f\x7f]{0,120}(\n[^<>\x01-\x1f\x7f]{0,120}){0,7}$'),
  CONSTRAINT print_profile__footer_text__ck CHECK (footer_text ~ '^[^<>\x01-\x1f\x7f]{0,120}(\n[^<>\x01-\x1f\x7f]{0,120}){0,7}$'),
  CONSTRAINT print_profile__reserve_top_mm__ck CHECK (reserve_top_mm BETWEEN 0 AND 80),
  CONSTRAINT print_profile__reserve_bottom_mm__ck CHECK (reserve_bottom_mm BETWEEN 0 AND 60),
  CONSTRAINT print_profile__font_size_pt__ck CHECK (font_size_pt BETWEEN 8 AND 12),
  CONSTRAINT print_profile__version__ck CHECK (version >= 1)
);
-- one active row per tenant, branch (NULL = lab default, counted once), document kind and recipient type (NULL = every recipient, counted once)
CREATE UNIQUE INDEX IF NOT EXISTS print_profile__active_key__uq ON reporting.print_profile
  (tenant_id, coalesce(branch_id, '00000000-0000-0000-0000-000000000000'::uuid), document_kind, coalesce(recipient_type, ''))
  WHERE is_active;

CREATE TABLE IF NOT EXISTS reporting.signatory_profile (
  id                 uuid        NOT NULL,
  tenant_id          uuid        NOT NULL,
  user_id            uuid        NOT NULL,
  display_name       text        NOT NULL,
  title              text,
  registration_no    text,
  signature_asset_id uuid,
  is_active          boolean     NOT NULL DEFAULT true,
  version            integer     NOT NULL DEFAULT 1,
  created_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid        NOT NULL,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  updated_by         uuid        NOT NULL,
  CONSTRAINT signatory_profile__pk PRIMARY KEY (id),
  CONSTRAINT signatory_profile__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT signatory_profile__tenant_id_user_id__uq UNIQUE (tenant_id, user_id),
  CONSTRAINT signatory_profile__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT signatory_profile__user__fk FOREIGN KEY (tenant_id, user_id) REFERENCES core.users (tenant_id, id),
  CONSTRAINT signatory_profile__display_name__ck CHECK (char_length(display_name) BETWEEN 1 AND 120 AND display_name !~ '[<>\x01-\x1f\x7f]'),
  CONSTRAINT signatory_profile__title__ck CHECK (char_length(title) <= 120 AND title !~ '[<>\x01-\x1f\x7f]'),
  CONSTRAINT signatory_profile__registration_no__ck CHECK (char_length(registration_no) <= 60 AND registration_no !~ '[<>\x01-\x1f\x7f]'),
  CONSTRAINT signatory_profile__version__ck CHECK (version >= 1)
);

-- billing.print_log.style: the print record stores the style used (LD-316); constant default, so no table rewrite and old rows read 'full'
ALTER TABLE billing.print_log ADD COLUMN IF NOT EXISTS style text NOT NULL DEFAULT 'full'
  CONSTRAINT print_log__style__ck CHECK (style IN ('full','plain_bw'));

-- RLS (tenant and staff/system, like the neighbouring reporting master tables), policies, grants, audit
ALTER TABLE reporting.print_profile ENABLE ROW LEVEL SECURITY;
ALTER TABLE reporting.print_profile FORCE ROW LEVEL SECURITY;
ALTER TABLE reporting.signatory_profile ENABLE ROW LEVEL SECURITY;
ALTER TABLE reporting.signatory_profile FORCE ROW LEVEL SECURITY;
DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'reporting.print_profile'::regclass AND polname = 'print_profile__select__tenant') THEN
  CREATE POLICY print_profile__select__tenant ON reporting.print_profile FOR SELECT TO lims_app
    USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
END IF; END $do$;
DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'reporting.print_profile'::regclass AND polname = 'print_profile__insert__tenant') THEN
  CREATE POLICY print_profile__insert__tenant ON reporting.print_profile FOR INSERT TO lims_app
    WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
END IF; END $do$;
DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'reporting.print_profile'::regclass AND polname = 'print_profile__update__tenant') THEN
  CREATE POLICY print_profile__update__tenant ON reporting.print_profile FOR UPDATE TO lims_app
    USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
    WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
END IF; END $do$;
DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'reporting.signatory_profile'::regclass AND polname = 'signatory_profile__select__tenant') THEN
  CREATE POLICY signatory_profile__select__tenant ON reporting.signatory_profile FOR SELECT TO lims_app
    USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
END IF; END $do$;
DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'reporting.signatory_profile'::regclass AND polname = 'signatory_profile__insert__tenant') THEN
  CREATE POLICY signatory_profile__insert__tenant ON reporting.signatory_profile FOR INSERT TO lims_app
    WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
END IF; END $do$;
DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'reporting.signatory_profile'::regclass AND polname = 'signatory_profile__update__tenant') THEN
  CREATE POLICY signatory_profile__update__tenant ON reporting.signatory_profile FOR UPDATE TO lims_app
    USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
    WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
END IF; END $do$;
GRANT SELECT, INSERT, UPDATE ON reporting.print_profile TO lims_app;
GRANT SELECT, INSERT, UPDATE ON reporting.signatory_profile TO lims_app;
CREATE OR REPLACE TRIGGER print_profile__audit AFTER INSERT OR UPDATE OR DELETE ON reporting.print_profile FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE OR REPLACE TRIGGER signatory_profile__audit AFTER INSERT OR UPDATE OR DELETE ON reporting.signatory_profile FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
