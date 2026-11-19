APPROVE

Scope: 19477369f..HEAD changes one test line (regapi.test.ts:351) plus notes. No product code changed.
- regapi.test.ts:351 drops `ext` from the anonymise audit not.toContain list, per arbiter ruling 78b31ed29. This matches the spec: the audit trigger exclusion list in db/migrations/20261117100000_frontdesk__add_patient_parity_fields.sql:47 (T0C-REGPARITY-1) covers government_id_number and the address_* columns only, and the done_when (2) and LD-310(b) sensitivity rule names only the government id number. The test is not weakened beyond the spec: :349 still asserts all 13 new columns are NULL after anonymise, and :351 still asserts no government id number or address value appears in audit_log or access_log.
- Prior review item 1 is fixed in HEAD: patients.repo.ts:64-66 anonymisePatientRow NULLs all 13 parity columns, and regapi.test.ts:336-352 covers it.
- Notes record verify run 2 at 1677/1677 green. The run 1 search min-length flake comes from the shared-tenant settings in admin/settings.test, not from this diff.
Checked: only owned paths (frontdesk __tests__, .orchestra/notes); no PHI or secrets; no new names, permissions or error codes in the diff.
Tracked, not blocking: CR .orchestra/cr/T0B-REGAPI-1 (interim identity.code_duplicate for the 409); shared-tenant settings flake in parallel runs.
