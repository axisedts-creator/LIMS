APPROVE
T0B-HARDEN-1 review (reviewer, diff 5a24cca3..HEAD)
- Migration 20261115200000 sorts after 20261115192000, starts with SET LOCAL ROLE lims_owner, has no CREATE ROLE, holds only 5 additive CREATE TRIGGER <table>__mutable_columns BEFORE UPDATE FOR EACH ROW statements (same naming as identity.branding_assets__mutable_columns), cites LD-231, and changes no existing object.
- I checked each list against the spec: consumption_facts = C12 05-SCHEMA:259 verbatim; access_slips = C13:1040-1044 array verbatim; pickup_request_manifests = C13:180 (is_open + updated_*); report_order_items and narrative_reports = C6:215 complement of the DDL (reporting migration :274-285, :605-611) minus id, tenant_id, order_id, created_*. No list was guessed.
- The 39 skip CRs exist, one per remaining table, and each names the spec gap. 5 + 39 = 44 = the LD-231 list. The impl note flags the centre_id [CONV] for the lead.
- `node --test tests/db/T0B-HARDEN-1.mutable-columns.test.mjs`: 11/11 pass (reviewer rerun). Tests cover done_when: the static UPDATE scan, trigger-name uniqueness, and the static immutability query.
- The diff adds no PHI, no secrets and no RLS/policy/grant change. All paths are owned by the lane (db/migrations, tests/db, .orchestra/cr|notes).
- Not verified: live DB run (no Docker). After merge the founder runs db/tests/immutability/T0B-08_immutability.test.sql plus the reporting/partners/inventory behaviour suites (LD-231).
