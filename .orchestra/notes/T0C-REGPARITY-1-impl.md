# T0C-REGPARITY-1 impl (LD-310)
- Files: contracts/openapi/frontdesk.yaml (13 optional fields on Patient/NewPatient/PatientUpdate, unset[] +13, new PatientCustomField, examples), db/migrations/20261117100000_frontdesk__add_patient_parity_fields.sql, regenerated contract clients/MSW (codegen).
- [CONV] Wire has no nullable; clear via PatientUpdate.unset[]. title / government_id_type are lower snake_case codes (text + CHECK, no enum type). custom_fields on the wire = closed `[{code, value}]` (maxItems 50) per ruling; DB column jsonb object.
- [CONV] government_id_number + 6 address parts join the D-27a audit exclusion list; absent from PatientSummary; full only in getPatient (frontdesk.patient.read), masked to last 4 elsewhere — masking/log redaction is service work (T0B-REGAPI-*).
- Nepal Individual Privacy Act 2018: lead must confirm retention rules with the lab lawyer (not a blocker).
- FOUNDER STEP: cloud migration via push-cloud.ps1 for 20261117100000_frontdesk__add_patient_parity_fields.sql; not done by this task.
- Open: duplicate external_patient_id error code not in errors.yaml (unique index raises; CR if a named code is wanted); profile_photo_attachment_id has no FK (service-checked).
