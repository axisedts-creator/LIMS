-- T0C-TESTMGMT-1 (LD-318, LD-318 follow-up, LD-325; founder 2026-11-17 08:48 NPT "test management first priority"): ElabAssist Test Management parity in the catalog.
-- Additive only, nothing existing is renamed (LD-318 decision 1): new nullable or constant-defaulted columns on catalog.tests, analytes, analyte_versions, reference_ranges,
-- panels, comment_codes; three CHECK lists widened (result_type, sex, age unit) with every old value kept; two NEW tenant tables:
--   catalog.test_categories (a category under a department; deactivate, never delete: lims_app has no DELETE grant and no DELETE policy),
--   catalog.test_stage_tat_targets (seven stage TAT in minutes: registration, sample_collection, accession, result, approval_1, approval_2, release;
--     catalog.tat_targets (routine / urgent, seconds) is untouched).
-- No data rewrite: no UPDATE / INSERT / DELETE of rows; ADD COLUMN with a constant DEFAULT is metadata only; existing bands keep their age unit and sex meaning;
--   print_on_negative defaults true, so every existing analyte keeps printing negative values. RLS of the altered tables is unchanged (no policy added or changed).
-- Fields that change what a result means (default_value, long_text_value, high_low, require_verification, result_type) live on the analyte VERSION, so a published
--   version stays immutable on them (analyte_versions__mutable_columns allow-list); display-only fields live on the analyte row (LD-318 done_when 4).
-- Notes (comment_codes, comment_code_texts): text is plain text or the safe Markdown subset, never raw HTML: a '<' followed by a letter, '/' or '!' is rejected;
--   "<5 mg/dL" stays legal. These two checks are NOT VALID so an existing row is never re-checked at migration time (no rewrite, no failed cloud apply); every new write is checked.
-- instrument_id and laboratory_id on bands are plain uuids (instruments and branches live in other modules; service checked); method_id, specimen_type_id, category_id are composite tenant FKs.
-- Idempotent: IF NOT EXISTS everywhere, column constraints inline in the guarded ADD COLUMN, extra constraints in DO blocks that check pg_constraint, widened checks re-created
--   only when the new value is missing, each CREATE POLICY guarded by pg_policy, triggers CREATE OR REPLACE. No ENUM types.
-- Cloud apply is a founder step (push-cloud.ps1), after 20261117120000_billing__add_lab_accounting.sql; not done by this task.
-- DOWN (manual, never automatic; drops entered test management data: founder decision, export first):
--   DROP TABLE IF EXISTS catalog.test_stage_tat_targets, catalog.test_categories CASCADE;   -- also drops tests__category__fk / comment_codes__category__fk; stage targets are lost
--   ALTER TABLE catalog.tests DROP COLUMN IF EXISTS short_name, DROP COLUMN IF EXISTS display_name, DROP COLUMN IF EXISTS tags, DROP COLUMN IF EXISTS barcode_text,
--     DROP COLUMN IF EXISTS loyalty_points, DROP COLUMN IF EXISTS display_order, DROP COLUMN IF EXISTS description, DROP COLUMN IF EXISTS report_type,
--     DROP COLUMN IF EXISTS processing_type, DROP COLUMN IF EXISTS template_ref, DROP COLUMN IF EXISTS outsource_name, DROP COLUMN IF EXISTS is_outsourced,
--     DROP COLUMN IF EXISTS is_popular, DROP COLUMN IF EXISTS smart_report, DROP COLUMN IF EXISTS print_category_wise, DROP COLUMN IF EXISTS nabl,
--     DROP COLUMN IF EXISTS accab_logo, DROP COLUMN IF EXISTS auto_approval_enabled, DROP COLUMN IF EXISTS use_normal_range_for_auto_approval,
--     DROP COLUMN IF EXISTS template_test, DROP COLUMN IF EXISTS nabl_processing_centres, DROP COLUMN IF EXISTS font, DROP COLUMN IF EXISTS alert_before_expiry_minutes,
--     DROP COLUMN IF EXISTS category_id;
--   ALTER TABLE catalog.analytes DROP COLUMN IF EXISTS trend_name, DROP COLUMN IF EXISTS specimen_type_id, DROP COLUMN IF EXISTS font, DROP COLUMN IF EXISTS result_display_type,
--     DROP COLUMN IF EXISTS print_on_negative, DROP COLUMN IF EXISTS print_on_worksheet, DROP COLUMN IF EXISTS send_in_sms, DROP COLUMN IF EXISTS nabl,
--     DROP COLUMN IF EXISTS accab_logo, DROP COLUMN IF EXISTS is_trend;
--   ALTER TABLE catalog.analyte_versions DROP COLUMN IF EXISTS default_value, DROP COLUMN IF EXISTS long_text_value, DROP COLUMN IF EXISTS high_low, DROP COLUMN IF EXISTS require_verification;
--   ALTER TABLE catalog.reference_ranges DROP COLUMN IF EXISTS instrument_id, DROP COLUMN IF EXISTS laboratory_id, DROP COLUMN IF EXISTS default_range, DROP COLUMN IF EXISTS method_id,
--     DROP COLUMN IF EXISTS auto_approved_low, DROP COLUMN IF EXISTS auto_approved_high;
--   ALTER TABLE catalog.panels DROP COLUMN IF EXISTS barcode_text, DROP COLUMN IF EXISTS loyalty_points, DROP COLUMN IF EXISTS display_order, DROP COLUMN IF EXISTS is_popular;
--   ALTER TABLE catalog.comment_codes DROP COLUMN IF EXISTS category_id, DROP COLUMN IF EXISTS result_type, DROP COLUMN IF EXISTS is_default_template, DROP COLUMN IF EXISTS text_format;
--   then drop comment_codes__text_no_html__ck / comment_code_texts__text_no_html__ck and re-create the three widened checks with their C3 lists ONLY after no row holds
--   a new value (result_type boolean / test_footer / space / graph / html_descriptive, sex third_gender, age unit hour).
SET LOCAL ROLE lims_owner;

-- ---------- (1) test categories (done_when 3) ----------
CREATE TABLE IF NOT EXISTS catalog.test_categories (
  id            uuid        NOT NULL,
  tenant_id     uuid        NOT NULL,
  department_id uuid        NOT NULL,
  name          text        NOT NULL,
  display_order integer     NOT NULL DEFAULT 0,
  print_footer  boolean     NOT NULL DEFAULT false,
  footer_text   text,
  version       integer     NOT NULL DEFAULT 1,
  is_active     boolean     NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid        NOT NULL,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    uuid        NOT NULL,
  CONSTRAINT test_categories__pk PRIMARY KEY (id),
  CONSTRAINT test_categories__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT test_categories__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT test_categories__department__fk FOREIGN KEY (tenant_id, department_id) REFERENCES catalog.departments (tenant_id, id),
  CONSTRAINT test_categories__name__ck CHECK (char_length(name) BETWEEN 1 AND 200),
  CONSTRAINT test_categories__order__ck CHECK (display_order BETWEEN 0 AND 9999),
  CONSTRAINT test_categories__footer__ck CHECK (char_length(footer_text) BETWEEN 1 AND 2000)
);
CREATE UNIQUE INDEX IF NOT EXISTS test_categories__tenant_id_department_id_lower_name__uq ON catalog.test_categories (tenant_id, department_id, lower(name));

-- ---------- (2) tests (done_when 2) ----------
ALTER TABLE catalog.tests
  ADD COLUMN IF NOT EXISTS short_name text CONSTRAINT tests__short_name__ck CHECK (char_length(short_name) BETWEEN 1 AND 60),
  ADD COLUMN IF NOT EXISTS display_name text CONSTRAINT tests__display_name__ck CHECK (char_length(display_name) BETWEEN 3 AND 300),
  ADD COLUMN IF NOT EXISTS tags text[] CONSTRAINT tests__tags__ck CHECK (cardinality(tags) <= 20),
  ADD COLUMN IF NOT EXISTS barcode_text text CONSTRAINT tests__barcode_text__ck CHECK (char_length(barcode_text) BETWEEN 1 AND 64),
  ADD COLUMN IF NOT EXISTS loyalty_points integer NOT NULL DEFAULT 0 CONSTRAINT tests__loyalty_points__ck CHECK (loyalty_points BETWEEN 0 AND 1000000),
  ADD COLUMN IF NOT EXISTS display_order integer CONSTRAINT tests__display_order__ck CHECK (display_order BETWEEN 0 AND 9999),
  ADD COLUMN IF NOT EXISTS description text CONSTRAINT tests__description__ck CHECK (char_length(description) BETWEEN 1 AND 2000),
  ADD COLUMN IF NOT EXISTS report_type text CONSTRAINT tests__report_type__ck CHECK (report_type IN
    ('four_column','three_column','two_column','graph','template_based_html','micro_automated','cbc_four_column','micro_manual','histo','four_column_10_font')),
  ADD COLUMN IF NOT EXISTS processing_type text CONSTRAINT tests__processing_type__ck CHECK (processing_type IN ('local','branch_transfer','outsource_branch')),
  ADD COLUMN IF NOT EXISTS template_ref text CONSTRAINT tests__template_ref__ck CHECK (char_length(template_ref) BETWEEN 1 AND 120),
  ADD COLUMN IF NOT EXISTS outsource_name text CONSTRAINT tests__outsource_name__ck CHECK (char_length(outsource_name) BETWEEN 1 AND 200),
  ADD COLUMN IF NOT EXISTS is_outsourced boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_popular boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS smart_report boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS print_category_wise boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS nabl boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS accab_logo boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS auto_approval_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS use_normal_range_for_auto_approval boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS template_test boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS nabl_processing_centres text[] CONSTRAINT tests__nabl_centres__ck CHECK (cardinality(nabl_processing_centres) <= 20),
  ADD COLUMN IF NOT EXISTS font text CONSTRAINT tests__font__ck CHECK (char_length(font) BETWEEN 1 AND 60),
  ADD COLUMN IF NOT EXISTS alert_before_expiry_minutes integer CONSTRAINT tests__alert_expiry__ck CHECK (alert_before_expiry_minutes BETWEEN 0 AND 525600),
  ADD COLUMN IF NOT EXISTS category_id uuid;
DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'catalog.tests'::regclass AND conname = 'tests__category__fk') THEN
    ALTER TABLE catalog.tests ADD CONSTRAINT tests__category__fk FOREIGN KEY (tenant_id, category_id) REFERENCES catalog.test_categories (tenant_id, id);
  END IF;
END $do$;
CREATE INDEX IF NOT EXISTS tests__tenant_id_category_id__idx ON catalog.tests (tenant_id, category_id);

-- ---------- (3) seven stage TAT in minutes (done_when 2) ----------
CREATE TABLE IF NOT EXISTS catalog.test_stage_tat_targets (
  id             uuid        NOT NULL,
  tenant_id      uuid        NOT NULL,
  test_id        uuid        NOT NULL,
  stage          text        NOT NULL,
  target_minutes integer     NOT NULL,
  version        integer     NOT NULL DEFAULT 1,
  is_active      boolean     NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid        NOT NULL,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     uuid        NOT NULL,
  CONSTRAINT test_stage_tat_targets__pk PRIMARY KEY (id),
  CONSTRAINT test_stage_tat_targets__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT test_stage_tat_targets__tenant_id_test_id_stage__uq UNIQUE (tenant_id, test_id, stage),
  CONSTRAINT test_stage_tat_targets__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT test_stage_tat_targets__test__fk FOREIGN KEY (tenant_id, test_id) REFERENCES catalog.tests (tenant_id, id),
  CONSTRAINT test_stage_tat_targets__stage__ck CHECK (stage IN ('registration','sample_collection','accession','result','approval_1','approval_2','release')),
  CONSTRAINT test_stage_tat_targets__minutes__ck CHECK (target_minutes BETWEEN 0 AND 43200)
);

-- ---------- (4) analytes: display-only fields (done_when 4) ----------
ALTER TABLE catalog.analytes
  ADD COLUMN IF NOT EXISTS trend_name text CONSTRAINT analytes__trend_name__ck CHECK (char_length(trend_name) BETWEEN 1 AND 120),
  ADD COLUMN IF NOT EXISTS specimen_type_id uuid,
  ADD COLUMN IF NOT EXISTS font text CONSTRAINT analytes__font__ck CHECK (char_length(font) BETWEEN 1 AND 60),
  ADD COLUMN IF NOT EXISTS result_display_type text CONSTRAINT analytes__result_display_type__ck CHECK (result_display_type IN
    ('table','note_value_only','list_note','one_column','two_column','three_column','four_column','comment','hidden','table_with_subheader','merge_two_column')),
  ADD COLUMN IF NOT EXISTS print_on_negative boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS print_on_worksheet boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS send_in_sms boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS nabl boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS accab_logo boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_trend boolean NOT NULL DEFAULT false;
DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'catalog.analytes'::regclass AND conname = 'analytes__specimen_type__fk') THEN
    ALTER TABLE catalog.analytes ADD CONSTRAINT analytes__specimen_type__fk FOREIGN KEY (tenant_id, specimen_type_id) REFERENCES catalog.specimen_types (tenant_id, id);
  END IF;
END $do$;

-- ---------- (5) analyte versions: fields that change what a result means (done_when 4) ----------
ALTER TABLE catalog.analyte_versions
  ADD COLUMN IF NOT EXISTS default_value text CONSTRAINT analyte_versions__default_value__ck CHECK (char_length(default_value) BETWEEN 1 AND 500),
  ADD COLUMN IF NOT EXISTS long_text_value text CONSTRAINT analyte_versions__long_text_value__ck CHECK (char_length(long_text_value) BETWEEN 1 AND 20000),
  ADD COLUMN IF NOT EXISTS high_low numeric,
  ADD COLUMN IF NOT EXISTS require_verification boolean NOT NULL DEFAULT false;
-- result_type widened: old six kept, ElabAssist Boolean, Test_Footer, Space, Graph, Html Descriptive added (Integer / Float / Equation = numeric, List = coded,
-- Long Text / Single Line Text = text, Descriptive = narrative, Image = attachment)
DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'catalog.analyte_versions'::regclass AND conname = 'analyte_versions__result_type__ck'
                 AND pg_get_constraintdef(oid) LIKE '%html_descriptive%') THEN
    ALTER TABLE catalog.analyte_versions DROP CONSTRAINT IF EXISTS analyte_versions__result_type__ck;
    ALTER TABLE catalog.analyte_versions ADD CONSTRAINT analyte_versions__result_type__ck CHECK (result_type IN
      ('numeric','text','ordinal','coded','attachment','narrative','boolean','test_footer','space','graph','html_descriptive'));
  END IF;
END $do$;

-- ---------- (6) reference range bands (done_when 5); critical bands keep their own set (sex and age unit widened only) ----------
ALTER TABLE catalog.reference_ranges
  ADD COLUMN IF NOT EXISTS instrument_id uuid,
  ADD COLUMN IF NOT EXISTS laboratory_id uuid,
  ADD COLUMN IF NOT EXISTS default_range boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS method_id uuid,
  ADD COLUMN IF NOT EXISTS auto_approved_low numeric,
  ADD COLUMN IF NOT EXISTS auto_approved_high numeric;
DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'catalog.reference_ranges'::regclass AND conname = 'reference_ranges__method__fk') THEN
    ALTER TABLE catalog.reference_ranges ADD CONSTRAINT reference_ranges__method__fk FOREIGN KEY (tenant_id, method_id) REFERENCES catalog.methods (tenant_id, id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'catalog.reference_ranges'::regclass AND conname = 'reference_ranges__auto_approved__ck') THEN
    ALTER TABLE catalog.reference_ranges ADD CONSTRAINT reference_ranges__auto_approved__ck
      CHECK (auto_approved_low IS NULL OR auto_approved_high IS NULL OR auto_approved_low <= auto_approved_high);
  END IF;
END $do$;
-- sex gains third_gender; age unit gains hour (an existing band keeps its unit, so its meaning is unchanged)
DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'catalog.reference_ranges'::regclass AND conname = 'reference_ranges__sex__ck'
                 AND pg_get_constraintdef(oid) LIKE '%third_gender%') THEN
    ALTER TABLE catalog.reference_ranges DROP CONSTRAINT IF EXISTS reference_ranges__sex__ck;
    ALTER TABLE catalog.reference_ranges ADD CONSTRAINT reference_ranges__sex__ck CHECK (sex IN ('any','male','female','third_gender'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'catalog.reference_ranges'::regclass AND conname = 'reference_ranges__age_low_unit__ck'
                 AND pg_get_constraintdef(oid) LIKE '%hour%') THEN
    ALTER TABLE catalog.reference_ranges DROP CONSTRAINT IF EXISTS reference_ranges__age_low_unit__ck;
    ALTER TABLE catalog.reference_ranges ADD CONSTRAINT reference_ranges__age_low_unit__ck CHECK (age_low_unit IN ('hour','day','week','month','year'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'catalog.reference_ranges'::regclass AND conname = 'reference_ranges__age_high_unit__ck'
                 AND pg_get_constraintdef(oid) LIKE '%hour%') THEN
    ALTER TABLE catalog.reference_ranges DROP CONSTRAINT IF EXISTS reference_ranges__age_high_unit__ck;
    ALTER TABLE catalog.reference_ranges ADD CONSTRAINT reference_ranges__age_high_unit__ck CHECK (age_high_unit IN ('hour','day','week','month','year'));
  END IF;
END $do$;
DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'catalog.critical_limits'::regclass AND conname = 'critical_limits__sex__ck'
                 AND pg_get_constraintdef(oid) LIKE '%third_gender%') THEN
    ALTER TABLE catalog.critical_limits DROP CONSTRAINT IF EXISTS critical_limits__sex__ck;
    ALTER TABLE catalog.critical_limits ADD CONSTRAINT critical_limits__sex__ck CHECK (sex IN ('any','male','female','third_gender'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'catalog.critical_limits'::regclass AND conname = 'critical_limits__age_low_unit__ck'
                 AND pg_get_constraintdef(oid) LIKE '%hour%') THEN
    ALTER TABLE catalog.critical_limits DROP CONSTRAINT IF EXISTS critical_limits__age_low_unit__ck;
    ALTER TABLE catalog.critical_limits ADD CONSTRAINT critical_limits__age_low_unit__ck CHECK (age_low_unit IN ('hour','day','week','month','year'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'catalog.critical_limits'::regclass AND conname = 'critical_limits__age_high_unit__ck'
                 AND pg_get_constraintdef(oid) LIKE '%hour%') THEN
    ALTER TABLE catalog.critical_limits DROP CONSTRAINT IF EXISTS critical_limits__age_high_unit__ck;
    ALTER TABLE catalog.critical_limits ADD CONSTRAINT critical_limits__age_high_unit__ck CHECK (age_high_unit IN ('hour','day','week','month','year'));
  END IF;
END $do$;

-- ---------- (7) panels: profile / package (done_when 6) ----------
ALTER TABLE catalog.panels
  ADD COLUMN IF NOT EXISTS barcode_text text CONSTRAINT panels__barcode_text__ck CHECK (char_length(barcode_text) BETWEEN 1 AND 64),
  ADD COLUMN IF NOT EXISTS loyalty_points integer NOT NULL DEFAULT 0 CONSTRAINT panels__loyalty_points__ck CHECK (loyalty_points BETWEEN 0 AND 1000000),
  ADD COLUMN IF NOT EXISTS display_order integer CONSTRAINT panels__display_order__ck CHECK (display_order BETWEEN 0 AND 9999),
  ADD COLUMN IF NOT EXISTS is_popular boolean NOT NULL DEFAULT false;

-- ---------- (8) notes = comment codes (done_when 7) ----------
ALTER TABLE catalog.comment_codes
  ADD COLUMN IF NOT EXISTS category_id uuid,
  ADD COLUMN IF NOT EXISTS result_type text CONSTRAINT comment_codes__result_type__ck CHECK (result_type IN
    ('numeric','text','ordinal','coded','attachment','narrative','boolean','test_footer','space','graph','html_descriptive')),
  ADD COLUMN IF NOT EXISTS is_default_template boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS text_format text NOT NULL DEFAULT 'plain' CONSTRAINT comment_codes__text_format__ck CHECK (text_format IN ('plain','markdown'));
DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'catalog.comment_codes'::regclass AND conname = 'comment_codes__category__fk') THEN
    ALTER TABLE catalog.comment_codes ADD CONSTRAINT comment_codes__category__fk FOREIGN KEY (tenant_id, category_id) REFERENCES catalog.test_categories (tenant_id, id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'catalog.comment_codes'::regclass AND conname = 'comment_codes__text_no_html__ck') THEN
    ALTER TABLE catalog.comment_codes ADD CONSTRAINT comment_codes__text_no_html__ck CHECK (text !~ '<[A-Za-z/!]') NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'catalog.comment_code_texts'::regclass AND conname = 'comment_code_texts__text_no_html__ck') THEN
    ALTER TABLE catalog.comment_code_texts ADD CONSTRAINT comment_code_texts__text_no_html__ck CHECK (text !~ '<[A-Za-z/!]') NOT VALID;
  END IF;
END $do$;

-- ---------- (9) RLS (tenant, like the neighbouring catalog tables), policies, grants, audit on the two new tables ----------
ALTER TABLE catalog.test_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog.test_categories FORCE ROW LEVEL SECURITY;
DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'catalog.test_categories'::regclass AND polname = 'test_categories__select__tenant') THEN
  CREATE POLICY test_categories__select__tenant ON catalog.test_categories FOR SELECT TO lims_app
    USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
END IF; END $do$;
DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'catalog.test_categories'::regclass AND polname = 'test_categories__insert__tenant') THEN
  CREATE POLICY test_categories__insert__tenant ON catalog.test_categories FOR INSERT TO lims_app
    WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
END IF; END $do$;
DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'catalog.test_categories'::regclass AND polname = 'test_categories__update__tenant') THEN
  CREATE POLICY test_categories__update__tenant ON catalog.test_categories FOR UPDATE TO lims_app
    USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
    WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
END IF; END $do$;
GRANT SELECT, INSERT, UPDATE ON catalog.test_categories TO lims_app;
CREATE OR REPLACE TRIGGER test_categories__audit AFTER INSERT OR UPDATE OR DELETE ON catalog.test_categories FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();

ALTER TABLE catalog.test_stage_tat_targets ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog.test_stage_tat_targets FORCE ROW LEVEL SECURITY;
DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'catalog.test_stage_tat_targets'::regclass AND polname = 'test_stage_tat_targets__select__tenant') THEN
  CREATE POLICY test_stage_tat_targets__select__tenant ON catalog.test_stage_tat_targets FOR SELECT TO lims_app
    USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
END IF; END $do$;
DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'catalog.test_stage_tat_targets'::regclass AND polname = 'test_stage_tat_targets__insert__tenant') THEN
  CREATE POLICY test_stage_tat_targets__insert__tenant ON catalog.test_stage_tat_targets FOR INSERT TO lims_app
    WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
END IF; END $do$;
DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'catalog.test_stage_tat_targets'::regclass AND polname = 'test_stage_tat_targets__update__tenant') THEN
  CREATE POLICY test_stage_tat_targets__update__tenant ON catalog.test_stage_tat_targets FOR UPDATE TO lims_app
    USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
    WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
END IF; END $do$;
GRANT SELECT, INSERT, UPDATE ON catalog.test_stage_tat_targets TO lims_app;
CREATE OR REPLACE TRIGGER test_stage_tat_targets__audit AFTER INSERT OR UPDATE OR DELETE ON catalog.test_stage_tat_targets FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
