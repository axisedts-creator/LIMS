TESTS_WRONG — homecollection repositories.test.ts leaves non-spec ACTIVE global reason rows behind; add cleanup there. reasons.test.ts assertions stay unchanged.
1. Spec: g_cs_reasons is global, the only reason source, seed-migration rows only (spec/chunks/C17-home-collection/05-SCHEMA.md:16, :45, :119; 02-TRD.md:196 H20 "global seeds only"). So reasons.test.ts:14 asserting exactly the 05-SCHEMA §2 codes per set is correct.
2. repositories.test.ts:231-233 seeds active visit_cancel_reasons rows hct03_*_a/_b (sort_order 9001/9002) into that global table and never removes them; while it runs (or after it) H20 returns codes the spec says cannot exist. That is fixture pollution, not an implementation defect.
3. Nothing in the T0B-SALES-1 brief or T0C-SALES-1 touches reason codes; the implementation must not filter test rows.
CHANGE (test file services/api/src/modules/homecollection/repository/__tests__/repositories.test.ts only):
- In the 'reasons.repo' describe add afterAll: superuser DELETE FROM homecollection.g_cs_reasons WHERE id = ANY($1) with [A.id, B.id].
- Because files run in parallel on one DB, cleanup alone leaves a window: also run the homecollection test files serially (vitest fileParallelism:false or a sequential project for src/modules/homecollection), or seed these two rows inside a transaction that rolls back. Same isolation fixes the schedule/handovers/guards shared-tenant collisions named in the dispute.
- No assertion deleted, skipped or loosened. Then rerun verify three times on an idle host.
