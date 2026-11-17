Title: CR-C0-TESTFIX-2: frontdesk suite cannot be green until the 18 REGPARITY-2 operations have handlers; verify of T0B-REGAPI-1 depends on it
From chunk: C0 (T0B-TESTFIX-2, lane C0-0B)            To owner: lead / C0 plan (task order)
Type: plan-dependency (product gap, not a test defect)
Blocking? yes for T0B-TESTFIX-2 done_when (4) "three green runs"; also for T0B-REGAPI-1 verify (its script runs the whole src/modules/frontdesk suite)
Problem:
  Merge 53b234149 brought T0C-REGPARITY-2 (b6d160947): contracts/openapi/frontdesk.yaml now has 47 operations (was 29): 18 new ones
  (list/create/get/deleteRegistrationDraft, list/add/removeFavouriteTest, previewRegistrationNumbers, list/create/updateCustomFieldDefinition,
  list/create/updateCoupon, list/create/updateIcdCode, getPatientRewards) and migration 20261117110000 adds 6 tables (coupons, custom_field_definitions,
  favourite_tests, icd_codes, registration_drafts, reward_points_ledger). services/api/src/modules/frontdesk/handlers/index.ts has no handler for them.
  The handlers are follow-up work (REGPARITY-2 impl notes: "T0B-REGAPI-1/2 service follow-ups"; REGAPI-2 waits on REGAPI-1, which waits on TESTFIX-2) -> circular wait.
  65 tests fail after the stale-expectation and flake fixes of this task, ALL from that gap (real product defect = missing handlers; per brief (5) no product change here):
   - unit/boot.test.ts x6: "module frontdesk: missing handler for operationId listRegistrationDrafts"; handlers/index.ts exports 29 of 47 names.
   - probes/registry.static.test.ts x20, probes/crossTenant.live.test.ts x19, probes/uploads.live.test.ts x18: "no probe request for <op>" / "expected 47 to have a length of 29" (probe kit.ts has no case for the 18 ops).
   - probes/tables.live.test.ts x2: EXPECTED lacks the 6 new tables; "DELETE/TRUNCATE: expected [registration_drafts, favourite_tests] to deeply equal []" (migration grants lims_app DELETE on them; the test says lims_app never has DELETE).
Proposed change:
  (a) Lead: either implement the 18 handlers (stubs that throw common.service_unavailable are enough for boot) BEFORE T0B-REGAPI-1 verify, or accept that REGAPI-1 verify runs a suite with these 65 known failures. I did not narrow the verify (LD-314).
  (b) With the handlers: tester adds probe-kit cases + EXPECTED rows for the 6 tables, and rules on DELETE (drafts/favourites are user-deletable by design: change the test's rule to an explicit allow-list for those two tables, or revoke DELETE and delete via a function).
Backward compatible? n/a
Tenant/security impact: the new tables must be cross-tenant probed (tables.live / crossTenant.live) before ship; today they are not.
Tests that will prove it: the same 65 tests, green, three runs in a row.
