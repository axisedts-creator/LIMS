# T0B-SYNC-1 dispute (writer, 2026-11-17 23:15 NPT)
TESTS_WRONG: two tests contradict each other; no implementation can satisfy both without gaming one.
- NEW `services/api/src/core/sync/__tests__/registry.static.test.ts:33-35` requires `CORE_PENDING_OPERATIONS` to equal `[]` (LD-325 b: T0B-SYNC-1 removes its 7 ids).
- EXISTING `services/api/src/core/__tests__/sync1.pending.test.ts:23-27` (T0C-SYNC-1) requires every core spec op to be in `createHealthHandlers(okChecks())` OR in `CORE_PENDING_OPERATIONS`, and `checkHandlers('core', spec, healthHandlers, pending)` to pass. Health handlers never hold the sync ops, so with an empty list it fails:
  `AssertionError: no handler and not pending: registerSyncDevice, listSyncDevices, revokeSyncDevice, requestSyncDeviceWipe, ackDeviceWipe, getSyncStatus, reserveNumberBlock`
- Its own header (line 4) says it "stays green on both sides of that move"; line 29 already short-circuits on an empty list, but lines 24-26 were not adapted. The intent of LD-325 b is the empty list, so sync1.pending.test.ts is stale.
- PROPOSED FIX (tester): in sync1.pending.test.ts use `{ ...healthHandlers, ...syncHandlers }` (import from `../sync/index.js`) in lines 24 and 26. Rejected alternative: making createHealthHandlers return the sync handlers (games the test, wrong ownership).
## 2. TESTS_WRONG: counter rewinds collide with blocks already issued (8 live tests)
- `helpers.ts setCounters` rewinds lab.barcode_counters / frontdesk.number_counters (e.g. `{ lab: 0 }`) on a DB where earlier tests already issued blocks in that range. The next reserve correctly hands out [1..n], which overlaps an existing block, so the T0C-SYNC-1 trigger `number_block__no_overlap` (the safety net the tests themselves require, blocks.concurrency.live:76, tables.live:22) refuses: `error: number_block_overlap` at repository.ts insertBlock.
- Failing: blocks.live (size max, maxBlockSize setting, remaining_size, reportBlockSkipped x2, audit), blocks.concurrency.live "20 devices x both series", tables.live "rows written by the service". Exact expectations like `from_value: 1` cannot hold once lower blocks exist in the tenant; outcome also depends on file/test order.
- The implementation must not work around it (skipping past blocks would break "counter + size" and the exact-range expectations; turning off the trigger is forbidden).
- PROPOSED FIX (tester): in `setCounters`, as superuser (fixture only) also remove the tenant's core.number_block rows of that series with to_value > the new value (or set every counter above max(to_value) and assert relative ranges).
- Everything else green on the throwaway PG17: devices, status, permissions, crossTenant, the other blocks/concurrency tests (incl. 20 devices disjoint + gap free, online allocations mixed in).

## 3. Writer change outside the brief's list, flagged for the reviewer
- With core sync handlers real (not pending), `mountSpec` refused boot without LIMS_CORE_JWT_* (boot, health, health-env, perf-http, observability/http suites failed). bootstrap now mounts core without its bearer sync ops when no JWT verifier exists (fail closed, 404, warn `core_sync_unmounted`), reusing `withoutPendingBearer` (now exported). Those 5 suites: 107/107 green.

- State: implementation done (core/sync/*, bootstrap merge, empty pending list, pipeline IdentityPort view for core [CONV]); registry.static green; tsc clean. Waiting for the ruling before impl.md.
