# HC-T11 impl (writer)
- Files: `snapshot.service.ts`, `handlers/{getSyncSnapshot,ackSync}.ts`, `index.ts` (A2/A4 wired), `repository/routes.repo.ts` (+`updateRouteStamps`), `device.service.ts` (export validators). Ruling round 2 items were test-side.
- LD-156 (2) applied: per-visit `lookupSpecimens` + `getOrderBalance` (changed) and balances (unchanged) run 8 at a time (`settledPortCalls`); [CONV] one `ctx.db.tx` savepoint per group, since core `tx.savepoint` (core/db/tx.ts:87) cannot interleave on one connection; a failed call rolls the group savepoint back, fulfilled results still used; an SQL error may degrade siblings in the group to `*_stale` for that pull (ponytail comment).
- access_log NOT batched: core writer `core/audit/access.ts` has no batch API (one INSERT per visit, REQ-SEC-096 kept).
- [CONV] route stamps without version bump; A4 wipe only from `wipe_requested`; only caller's own routes stamped.
- Run (real PG17, `HC-T11-impl-run.log`): 81/84; 3 perf.test failures. Changed p95 4968 ms (runs 2583-4968; was 13.9 s serial), unchanged p95 786 ms (runs 273-786), all-lookups-fail 9988 ms. tsc clean for touched files.
- NOT a quiet run: lane container `lims_c12t03_*` and another container (~24% CPU) were active. Port time with fakes is now ~150 ms of the pull; remainder is DB/host. Per LD-156 (3) a dispute needs a quiet-run breakdown: not written yet; rerun perf.test alone on an idle machine first.
- Open: `__tests__/boot.test.ts` (HC-T01) still treats all 26 ops as stubs.
