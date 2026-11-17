Title: CR-C0-REGAPI-1: error code for a duplicate external_patient_id
From chunk: C0 (T0B-REGAPI-1, frontdesk patient API)            To owner: C0-0C
Type: api
Blocking? no (interim code in use, see below)
Problem (what you cannot do today, with the user story / acceptance criterion it serves):
  T0B-REGAPI-1 done_when (1): "external_patient_id unique per tenant with a clear 409 error". errors.yaml has no frontdesk 409 for it, and createPatient /
  updatePatient x-error-codes list none. frontdesk.patient_duplicate_suspected (dedupe candidates UI) and common.version_conflict (reload) mean something else.
  Interim: the service throws identity.code_duplicate (409, "Code already used") with errors[] path /external_patient_id. That is a C2 code and toProblem
  renders errors[] only for ERRORS_CODES, so the field path does not reach the client.
Proposed change (exact):
  contracts/errors.yaml: - { code: frontdesk.external_patient_id_duplicate, http: 409, owner: C4, title: "Patient number already used", meaning: "external_patient_id exists in the tenant; errors in errors[]" }
  contracts/openapi/frontdesk.yaml: add it to x-error-codes of createPatient, updatePatient, createRegistration (new_patient) + a 409 response.
  services/api/src/core/errors.ts: add the code to ERRORS_CODES (LD-153 "errors in errors[]" meaning).
  Then frontdesk patient.service.ts uniqueExternalId() switches to the new code (one line).
Backward compatible? yes (additive code; 409 status unchanged)
Tenant/security impact: none. The value is never echoed (fixed message); same answer whatever the other row is.
Alternatives considered: reuse identity.code_duplicate permanently (wrong owner); 400 validation_failed (the brief asks for 409).
Tests that will prove it: regapi.test.ts "(1) external_patient_id is unique per tenant" (status 409 + path), plus a code assertion once named.
