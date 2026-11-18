# T0C-SYNC-2 dispute (debugger, 2026-11-18)

Test: services/api/src/core/__tests__/sync2.pending.test.ts, line 14 + 27-31
("checkHandlers(core) passes with the pending list: every spec operation is a handler or pending").
Verify log: `no handler and not pending: registerSyncDevice, listSyncDevices, revokeSyncDevice, requestSyncDeviceWipe, ackDeviceWipe, getSyncStatus, reserveNumberBlock`.

Cause: after merging main, the 7 part 1 ops have real handlers (T0B-SYNC-1, core/sync/index.ts `syncHandlers`) and were
removed from CORE_PENDING_OPERATIONS, as LD-325 (b) requires ("every T0B handler task removes the ids it implements from that list").
The test builds its covered set from `createHealthHandlers(okChecks())` only (line 14), ignoring `syncHandlers`.
The sibling test sync1.pending.test.ts:17-18 does it right: `{ ...createHealthHandlers(okChecks()), ...syncHandlers }`
("LD-325 (a)/(b): a handler wins over a pending id, so the covered set is the handlers bootstrap builds").

Only impl workaround: re-add the 7 implemented ids to CORE_PENDING_OPERATIONS. That passes (sync1.pending.test.ts:43 allows them,
handler wins), but undoes T0B-SYNC-1 cleanup, lists implemented ops as pending, and contradicts LD-325 (b). Not done.

Fix needed in the test (not mine to edit): build `healthHandlers` as `{ ...createHealthHandlers(okChecks()), ...syncHandlers }`
(import `syncHandlers` from '../sync/index.js'), same as sync1.pending.test.ts.
Test line 32-35 ("without the pending list ... toThrow") stays valid: part 2 ids still have no handler.
