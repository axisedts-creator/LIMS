# T0B-SWEEP-2 impl (writer, after lead reset 1 / LD-307)
Files: test-sweep/request.ts (digit ranges sample '1' not '0'; future dates, end/to bound +1 day, end time 23:59; nested minProperties filled; `*_ids` from seeded id), run.ts (ids + branch_id/centre_id; subscribes `tracing:fastify.request.handler:start`), classify.ts (`reachedHandler`), sessions.ts (export BRANCH_A/CENTRE_A), known-failures.json (224, `--write-known`), T0B-SWEEP-2-results.{json,md}.
Run (main merged, header fix T0A-HEADERS-1 in): 1114 ops, 0 x 429, 0 NOT EXERCISED; DEEP 1103 / SHALLOW 11; WIRED 890, DEFECT 224 = BUG 117, CONFIG 107, HARNESS 0. Gate run ok; verify.cmd vitest 87/87 pass.
[CONV] 400 common.validation_failed counts DEEP only when fastify published handler:start for that request id (it fires after schema validation passed), i.e. the service's own field check (coded set, row lookup); schema-stage 400s stay SHALLOW.
[CONV] top-level bodies stay required-only (request.test.ts), so ~22 PATCH ops send {} and get the service's "nothing to change" 400 (now DEEP via handler:start).
Review 06997f057: both items were tester steps (gate.test.ts retarget, reachedHandler DEEP/SHALLOW cases), done in d88f6be1d; no implementation change needed. Full `vitest run test-sweep/__tests__`: 13 files, 132/132 pass (2026-11-17 22:46).
BUG list by root-cause guess: end of T0B-SWEEP-2-results.md.
