APPROVE

Scope note: the given range 916ecfefd..HEAD is empty (HEAD = 916ecfefd, the merge from main). I reviewed the task's real commits 628535496..89c93f215 instead (tester 734974333 through debugger round 3 89c93f215).

Checked:
- Files: 7 product/test files plus notes (frontdesk.yaml, migration 20261117100000_frontdesk__add_patient_parity_fields.sql, pgTAP suite, api-client-ts frontdesk.ts + server/operations.ts, fakes handlers.generated.ts, regparity1-openapi.test.ts). That is within the 8-file limit, all in owned paths, and there is no service or web change.
- Migration: it adds the 13 columns as nullable with no default, using ADD COLUMN IF NOT EXISTS, so there is no data rewrite. title and government_id_type use text + CHECK (no ENUM type). The unique index patients__tenant_id_external_patient_id__p_uq is partial and has tenant_id first, which follows the repo naming pattern. The audit trigger is replaced in place, and the exclusion list now adds government_id_number and the 6 address_* columns. The DOWN note matches the original trigger in 20261105001600 line 596. The comment covers: sensitive column, Privacy Act 2018, lawyer retention check, push-cloud founder step.
- RLS: there is no policy or grant change. The pgTAP suite asserts ENABLE+FORCE, an unchanged policy set, cross-tenant read/update/find on the new columns, and 0 rows for patient/partner/portal actors.
- Contract: the fields are optional with no nullable (per the arbiter ruling), and unset[] is extended (maxLength 27 = profile_photo_attachment_id). custom_fields is a closed [{code,value}] list. government_id_number is absent from PatientSummary (the list response). Examples are synthetic.
- Sensitive-column pattern: no patient-column encryption exists in the repo (pgp/encrypted is used only in identity MFA). The masking and log redaction left to T0B-REGAPI-* is consistent with the brief, which says to follow the existing pattern.
- No secrets and no real PHI found.

Ran: `npx vitest run __tests__/regparity1-openapi.test.ts` (tools/codegen) gave 28/28 passed, including lint and codegen --check. pgTAP: I did not re-run it. I relied on the debugger rounds 1 and 2 (no `not ok`) and on the LD-311 harness fix.

Non-blocking: there is no named error code for a duplicate external_patient_id (noted as open in impl notes). Raise a CR in T0B-REGAPI-1 if a code is needed.
