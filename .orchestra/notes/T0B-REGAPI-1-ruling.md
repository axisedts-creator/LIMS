TESTS_WRONG — regapi.test.ts:351 asserts external_patient_id never appears in audit.audit_log; no spec text or lead decision requires that.
Change: at services/api/src/modules/frontdesk/__tests__/patients/regapi.test.ts:351 remove `ext` from the not.toContain list; keep `no` and the 4 `Syn*Anon` address values. Keep :349 (all 13 new columns, `external_patient_id` included, NULL after anonymise) unchanged.
Reasons:
1. spec/chunks/C4-frontdesk-billing/05-SCHEMA.md:187-190: the D-27a audit exclusion covers only the demographic columns full_name, name_search, birth_on, phone_e164, email, address_text. No identifier column is on that list.
2. Task brief done_when (2) (inbox T0B-REGAPI-1-arbiter.md:19) keeps out of audit diffs only the government id number. LD-310(b) (:29) marks only the government id number as sensitive.
3. The parity migration db/migrations/20261117100000_frontdesk__add_patient_parity_fields.sql:43-44 (T0C-REGPARITY-1, not owned by this task) extends the list with government_id_number and the address_* columns only. external_patient_id is therefore audited on purpose by app.tg_row_audit. The DB trigger writes it at the fixture seed INSERT and in the anonymise UPDATE old_values; no code in this task's paths can prevent that.
4. `grep external_patient_id spec/` returns nothing, so the spec has no rule that this lab MR number must be kept out of audit.
5. If the lead wants the MR number kept out of audit, that needs a new T0C migration to extend the exclusion list. That would be a separate CR. It is not a defect in this implementation.
