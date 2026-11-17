# T0B-SALES-1 dispute (writer, verify run 1 after 1a5a20d76, 2026-11-18) — TESTS_WRONG
Log: .orchestra/notes/T0B-SALES-1-run1.log. Main command: 6 files failed / 79 passed, 2 tests failed / 3446 passed. Timing command (perf + boot, --retry 2): 2/2 files green. Sales, collector, partners and probe files: all green. Implementation unchanged.

1. NEW REGRESSION FROM THE LD-355 (1) FIXTURE: services/api/src/modules/homecollection/repository/__tests__/helpers.ts:89 (added by the tester in 1a5a20d76)
   `superTx(tx => tx.query('DELETE FROM homecollection.settings WHERE tenant_id = $1', ...))` fails with
   `error: new row violates row-level security policy for table "audit_log"` (the delete fires the audit trigger, and the audit_log insert is refused under the claims superTx sets).
   This breaks seedWorld for 5 files: dispatch/assign.test.ts (P-44 suite), visits/phone, visits/routes, visits/visit.detail, visits/visits.list. Those files were green in round 5.
   Fix (tester, isolation only): do not DELETE. Re-read the existing row's id instead (`SELECT ... FROM homecollection.settings WHERE tenant_id = $1`, the second option LD-355 (1) allows), or UPDATE the existing row to the fixture values.
2. handovers/read.test.ts:85 and :132: listHandovers returns handovers from other files (to_centre_id ...a203; rows 39-43 with item_count 0). These are probably handovers left behind when the seedWorld runs above aborted half way (or rows another file creates). This is the same shared-tenant collision class as LD-347. Re-check after fix 1; if it is still red, scope the assertions to this file's own handover ids or clean up the handovers each file creates (isolation only).
Not counted as a green run. Runs 2 and 3 were not started: the result is deterministic until the fixture changes.
