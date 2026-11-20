APPROVE

Scope: git diff 1acae2598..HEAD (T0B-SYNC-5, post LD-418).
- Only code change: services/api/src/core/sync/__tests__/hardening/kit.ts (test fixture, owned path). No production file, migration, policy, grant, assertion or done_when touched; load.live.test.ts :40 / :82 and P95_BATCH_MS_BOUND = 30000 unchanged.
- Matches LD-418 exactly: LD-417 counter-first FOR UPDATE removed; batchLockKeys collects s5_patient / s5_order / s5_state keys plus the counter series only when the batch holds billing.record_receipt, dedups (Set) and sorts by key string; lockBatchKeys takes pg_advisory_xact_lock on ctx.tx (the request tx, helpers2.ts:159-161) before pushSyncBatch writes, and re-takes it on every 40001/40P01 whole-request retry (fire2 calls the wrapper per attempt). Op field names (op_type, entity_id, payload.patient_key/order_key) match buildPlans.
- No PHI, no secrets, names unchanged, nothing invented. Retention stays dropped (LD-407).
- Verified: tests/core/T0B-SYNC-5.pg.sh on throwaway PG17: 5 files, 54/54 passed (176 s), 1 run by reviewer; writer reports 3/3.
- Not run by reviewer (permission prompt blocked a widened SYNC5_SUITE): whole src/core/sync suite and boot tests, three in a row. Lead verify should run them before merge.
- Note (not a defect): hashtextextended collision between two distinct keys could in theory reorder locks; 64-bit hash, negligible for a fixture.
