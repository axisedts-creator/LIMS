APPROVE

Re-review after 9e5a679f. Both prior defects are fixed:
1. selfreg.service.ts:52 now uses the registered sub-code `common.field_invalid` (contracts/errors.yaml:4).
2. create_self_patient.ts:13 and :35 now fall back to the registered `common.internal` (contracts/errors.yaml:22). No leftover `engagement.self_registration_failed` or `common.field_conflict` in services/ or the impl notes.

The earlier "checked, no defect" list still holds: names, permissions, RLS, tenant predicates, no P2 in logs, owned paths, and done_when (duplicate-suspected links the NEW patient).
Checks run: api selfreg.handlers 57/57 pass; worker create_self_patient 26/26 pass. tsc reports no errors in T-L4 files. The tsc errors that remain are in contracts/ports/common.ts, packages/shared-ts and reporting/send_delivery.ts, which were there before this task and are outside its paths.
