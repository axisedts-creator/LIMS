# T0C-MSGDESK-1 dispute (debugger)
Failing: tools/codegen/__tests__/c16-openapi.test.ts "§5.1 DTO field lists exactly" — Profile fields 8 vs 7 (extra `version`).
Spec: spec/chunks/C16-patient-engagement/02-TRD*.md line 408 lists Profile without `version`; test matches spec.
Cause: commit 8666eb72e (T-L6 review fixes, 2026-11-14) added required Profile.version to engagement.yaml + patient_app/api-client. Not touched by T0C-MSGDESK-1 (byte-identical Profile block before/after; MSGDESK diff has no Profile change).
Not fixed: removing `version` would break T-L6 patient app/generated clients; editing the test is forbidden. Needs lead: either CR to add `version` to TRD §5.1 (then tester updates c16 pin) or revert T-L6 field. Same as ruling item 6; must not block MSGDESK.
