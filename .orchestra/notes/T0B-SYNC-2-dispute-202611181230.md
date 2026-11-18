# T0B-SYNC-2 dispute (writer, 2026-11-18): 4 tests contradict the T0B-SYNC-2 tests or the DB; implementation is complete, nothing loosened
Run: `SYNC2_SUITE=src/core bash tests/core/T0B-SYNC-2.pg.sh` = 3260 pass, 11 fail (all below); `src/core/sync` alone = 250 pass, 7 fail (item 1 only).
1. services/api/src/core/sync/__tests__/pull.live.test.ts:25-26 `insertDoctors` writes doctor_code = 'sync2-pull-' || substr(id, 25) (lowercase, 23 chars),
   which violates catalog.doctors CHECK doctors__code__ck `^[A-Z0-9_\-]{1,20}$` (migration 20261105001500 line 620): `error: new row for relation "doctors"
   violates check constraint "doctors__code__ck"` in all 7 failing tests (lines 46, 63, 74, 92, 111, 160, 189). The pull never runs. Fix (fixture only):
   e.g. `'S2P-' || upper(substr(i::text, 25))` (16 chars) and pass a short upper case tag.
2. services/api/src/core/__tests__/sync1.pending.test.ts:18 and sync2.pending.test.ts:14 build the covered set from health + syncHandlers (part 1 only).
   sync2.registry.static.test.ts:40 (and registry.static.test.ts:33) demand CORE_PENDING_OPERATIONS == [] and bootstrap now merges syncPart2Handlers,
   so the covered set must be health + syncHandlers + syncPart2Handlers: the same ruling the arbiter gave in 68848ac7a ("the handlers bootstrap actually builds").
   Fails today: sync1.pending:27, sync2.pending:26 and :30 ("no handler and not pending: pushSyncBatch, ...").
3. services/api/src/core/observability/__tests__/metrics.test.ts:173 EXPECTED is an exact list; sync2.registry.static.test.ts:85-90 pins the three new names in
   metrics.ts DEFS. Add to EXPECTED: lims_core_sync_operations_total: 'counter', lims_core_sync_batches_total: 'counter', lims_core_sync_oldest_unsynced_age_seconds: 'gauge'.
4. tools/codegen/__tests__/sync2-openapi.test.ts ("errors.yaml holds the nine new sync.* codes") is an exact list of sync.* codes; sync2.registry.static.test.ts:72-80
   demands sync.op_type_not_available in errors.yaml and SyncErrorCode. Add it to that list. Same code also needs IC §8 (registry-equality): .orchestra/cr/T0B-SYNC-2.md.
