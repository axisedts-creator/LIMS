-- T0C-REGPARITY-1 (LD-310; founder request 2026-11-17 04:49 NPT: all ElabAssist registration fields; LD-310 (b): Nepal equivalents, no India-only items)
-- Adds 13 nullable columns to frontdesk.patients: title, external_patient_id, nationality, government_id_type, government_id_number,
-- address_province, address_district, address_municipality, address_ward, address_tole, address_postal_code (beside address_text),
-- profile_photo_attachment_id, custom_fields (validated against per-tenant definitions in T0C-REGPARITY-2; here only the column).
-- Additive: every column is nullable with no default, so ADD COLUMN is catalog-only and there is no data rewrite. Idempotent: IF NOT EXISTS everywhere,
-- constraints inline in the guarded ADD COLUMN, the audit trigger replaced in place. RLS: the three tenant_id policies are row level and cover the new columns
-- unchanged; the table-level GRANT SELECT, INSERT, UPDATE to lims_app covers them too. No policy, grant or type change.
-- SENSITIVE: government_id_number is sensitive personal data (Nepal Individual Privacy Act 2018). It must never appear in logs, audit diffs or list responses;
-- it is returned in full only by the single patient read (frontdesk.patient.read), masked to the last 4 characters elsewhere (service layer, T0B-REGAPI-*).
-- It is never written to the audit log: it joins the D-27a exclusion list below, with the six structured address parts (same class as address_text).
-- Retention rules under the Privacy Act 2018 are to be confirmed by the lead with the lab lawyer (not a blocker).
-- profile_photo_attachment_id: no FK (the patient attachment store is not owned by this chunk; the service checks it).
-- Cloud apply is a founder step (push-cloud.ps1), not done by this task.
-- DOWN (manual, never automatic): restore the old trigger with
--   CREATE OR REPLACE TRIGGER patients__audit ... app.tg_row_audit('full_name', 'name_search', 'birth_on', 'phone_e164', 'email', 'address_text');
--   DROP INDEX IF EXISTS frontdesk.patients__tenant_id_external_patient_id__p_uq;
--   ALTER TABLE frontdesk.patients DROP COLUMN IF EXISTS title, DROP COLUMN IF EXISTS external_patient_id, DROP COLUMN IF EXISTS nationality,
--     DROP COLUMN IF EXISTS government_id_type, DROP COLUMN IF EXISTS government_id_number, DROP COLUMN IF EXISTS address_province,
--     DROP COLUMN IF EXISTS address_district, DROP COLUMN IF EXISTS address_municipality, DROP COLUMN IF EXISTS address_ward,
--     DROP COLUMN IF EXISTS address_tole, DROP COLUMN IF EXISTS address_postal_code, DROP COLUMN IF EXISTS profile_photo_attachment_id,
--     DROP COLUMN IF EXISTS custom_fields;
--   (DROP COLUMN destroys entered data: founder decision, export first.)
SET LOCAL ROLE lims_owner;

ALTER TABLE frontdesk.patients
  ADD COLUMN IF NOT EXISTS title text CONSTRAINT patients__title__ck CHECK (title IN ('mr','mrs','miss','ms','master','baby','baby_of','dr','prof','capt','col','major','sri','smt','kumari','late','sister','reverend','other')),
  ADD COLUMN IF NOT EXISTS external_patient_id text CONSTRAINT patients__external_patient_id__ck CHECK (char_length(external_patient_id) BETWEEN 1 AND 64),
  ADD COLUMN IF NOT EXISTS nationality text CONSTRAINT patients__nationality__ck CHECK (nationality ~ '^[A-Z]{2}$'),
  ADD COLUMN IF NOT EXISTS government_id_type text CONSTRAINT patients__government_id_type__ck CHECK (government_id_type IN ('citizenship','national_id','passport','driving_licence','voter_id','other')),
  ADD COLUMN IF NOT EXISTS government_id_number text CONSTRAINT patients__government_id_number__ck CHECK (char_length(government_id_number) BETWEEN 1 AND 64),
  ADD COLUMN IF NOT EXISTS address_province text CONSTRAINT patients__address_province__ck CHECK (char_length(address_province) BETWEEN 1 AND 100),
  ADD COLUMN IF NOT EXISTS address_district text CONSTRAINT patients__address_district__ck CHECK (char_length(address_district) BETWEEN 1 AND 100),
  ADD COLUMN IF NOT EXISTS address_municipality text CONSTRAINT patients__address_municipality__ck CHECK (char_length(address_municipality) BETWEEN 1 AND 150),
  ADD COLUMN IF NOT EXISTS address_ward text CONSTRAINT patients__address_ward__ck CHECK (char_length(address_ward) BETWEEN 1 AND 20),
  ADD COLUMN IF NOT EXISTS address_tole text CONSTRAINT patients__address_tole__ck CHECK (char_length(address_tole) BETWEEN 1 AND 150),
  ADD COLUMN IF NOT EXISTS address_postal_code text CONSTRAINT patients__address_postal_code__ck CHECK (char_length(address_postal_code) BETWEEN 1 AND 20),
  ADD COLUMN IF NOT EXISTS profile_photo_attachment_id uuid,
  ADD COLUMN IF NOT EXISTS custom_fields jsonb CONSTRAINT patients__custom_fields__ck CHECK (jsonb_typeof(custom_fields) = 'object');

-- the lab-typed MR / patient number is unique per tenant when present (tenant_id first)
CREATE UNIQUE INDEX IF NOT EXISTS patients__tenant_id_external_patient_id__p_uq ON frontdesk.patients (tenant_id, external_patient_id) WHERE external_patient_id IS NOT NULL;

-- D-27a exclusion list extended (LD-310): government id and the structured address never enter audit.audit_log
CREATE OR REPLACE TRIGGER patients__audit AFTER INSERT OR UPDATE OR DELETE ON frontdesk.patients FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit('full_name', 'name_search', 'birth_on', 'phone_e164', 'email', 'address_text', 'government_id_number', 'address_province', 'address_district', 'address_municipality', 'address_ward', 'address_tole', 'address_postal_code');
