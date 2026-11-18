Title: CR-C0-VERLEVEL-1: list lab.critical_ack_required on verifyResult and bulkVerifyResults
From chunk: C0 (T0B-VERLEVEL-1, lane C0-0G)            To owner: C0-0C
Type: api
Blocking? no (T0B-VERLEVEL-1 keeps the gate; only the declared error list is incomplete)
Problem (what you cannot do today, with the user story / acceptance criterion it serves):
  LD-316 / T0C-VERLEVEL-1 made verifyResult the FINAL sign-off when the policy has require_pathologist false and the sign-off reaches signoff_required (lab.yaml:2833 description). A final sign-off approves the result, so the unchanged critical value gate (AC-13.5; T0B-VERLEVEL-1 done_when (7) "critical value acknowledgement, hold and flag gates are unchanged") must run there: services/api/src/modules/lab/service/result.service.ts:452 calls criticalGate when plan.final. That path can return lab.critical_ack_required, which approveResult declares (lab.yaml:3290) but verifyResult (lab.yaml:2829-2854) and bulkVerifyResults (lab.yaml:2972-2995) do not.
Proposed change (exact): contracts/openapi/lab.yaml
  operationId verifyResult, x-error-codes: add `- lab.critical_ack_required` after `- lab.pathologist_required`
  operationId bulkVerifyResults, x-error-codes: add `- lab.critical_ack_required` after `- lab.pathologist_required`
  (bulk reports it per result in the failures list, as bulkApproveResults does at lab.yaml:3420)
Backward compatible? yes (additive error code already defined in the catalogue)
Tenant/security impact: none (no RLS, no PHI, no new surface)
IRD/regulatory impact: none
Alternatives considered: remove the gate from the final verify path. Rejected: it would let a level 1 / no-pathologist policy approve an unacknowledged critical result, against AC-13.5 and done_when (7).
Tests that will prove it: existing lab critical-gate tests on the approve path; contract lint (x-error-codes vs thrown codes) once added.
