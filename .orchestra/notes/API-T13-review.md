APPROVE
Round 2 re-review of 51ffaaab..HEAD (fixes in 709b1874, 50e597c8).
1. Fixed: E38 200 body now `{ ...res, preview: !live }` (reprocess.service.ts:251), per openapi E38 `required: [run, records, preview]` / 02-TRD.md:741. Tests assert preview=false (live) and preview=true (shadow).
2. Fixed: E39 no longer calls `driverOf`. The run takes `run_driver_code`/`run_driver_version` from the source record's run (reprocess.repo.ts findRecord JOIN processing_runs, tenant-predicated), so `instruments.driver_not_available` cannot be thrown on re-match. A new test (getDriver undefined) asserts 200 and that the source driver is carried into insertRun.
Ran: vitest reprocess.service + reprocess.handlers 63/63 pass; tsc --noEmit shows no errors under src/modules/instruments.
Round-1 checks still hold (names verbatim, tenant predicates, INSERT-only, no PHI in logs, owned paths only, no new tables).
Not blocking (unchanged): a concurrent reprocess hits the run_no unique constraint and returns 500 instead of 409; idempotency and rate tier are enforced by the pipeline and not covered by these unit tests.
