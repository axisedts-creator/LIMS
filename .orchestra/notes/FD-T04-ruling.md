TESTS_WRONG — boot.test.ts (FD-T01) asserts every handler is a 503 stub forever; the spec only requires that while a handler is still unimplemented.
Reasons:
- spec/chunks/C4-frontdesk-billing/06-IMPLEMENTATION-PLAN.md:11 (FD-T01): not-yet-implemented handlers throw `common.service_unavailable` "until their task merges". After that, the stub requirement ends for that operationId.
- spec/chunks/C4-frontdesk-billing/06-IMPLEMENTATION-PLAN.md:14 (FD-T04): makes searchPatients, createPatient, getPatient, updatePatient, recordPatientConsent and listPatientOrders real handlers. They must not answer service_unavailable, which patients.static.test.ts already asserts.
Required test changes in services/api/src/modules/frontdesk/__tests__/unit/boot.test.ts:
1. Lines 134-144 ("every handler rejects ... 503"): loop over operationIds(spec()) minus the operationIds implemented by merged tasks. Today that means minus the six FD-T04 ops. A good way: derive the list from probes/pending.json (the stub inventory, LD-70), so later tasks need no further test edits.
2. Lines 146-155 ("a stub never echoes request data"): call a handler that is still a stub (for example `anonymisePatient` or `listOrders`) instead of `searchPatients`. Keep the no-PII assertion unchanged.
3. Lines 157-162 ("no handler resolves for an empty request") and lines 100-113 (no unauthenticated call reaches a stub): these stay correct and should not change.
Out of scope: the nav `routeId "staff.catalog.*" not found in contracts/routes.yaml` failure was already there and is not part of this ruling. It needs its own route (FD-T01 or C0 routes owner).
