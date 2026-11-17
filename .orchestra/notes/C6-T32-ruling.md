TESTS_WRONG — the fixture builds report_order_items rows that a real DB could never hold; the spec does not require the implementation to tolerate a missing item_status.
Reasons:
1. spec/chunks/C6-reporting-delivery/05-SCHEMA.md:564 — `item_status text NOT NULL DEFAULT 'active'`; CHECK at :580 limits it to ('active','removed','cancelled'). A persisted row always has a value, so the absence of one is a fixture artefact.
2. services/worker/src/jobs/reporting/__tests__/assemble.modules.helpers.ts:32-34 — `item()` pushes rows straight into `s.db.store`, skipping the DDL defaults, so `item_status` is undefined and the active-only filter in assemble drops both module items. No module view read or section rendering happens, which is why the IS-20/21/22 assertions fail.
3. Same class of fault as the C6-T14 ruling (fixture bypassed DDL defaults).
Required test change (tester): in `item()` in assemble.modules.helpers.ts, add the DDL defaults for every NOT NULL DEFAULT column of 05-SCHEMA.md:563-569 that the row omits: `item_status: 'active'`, `narrative_test_ids: []`, `approved_results: 0` (or the actual approved count, 1, if the assertions depend on it), `amendment_pending: false`, `version: 1`. Leave the assertions unchanged.
Implementation: do NOT add `?? 'active'` to assemble_report.ts. It would be dead code against a NOT NULL column and would hide real fixture bugs.
