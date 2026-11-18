# DISPUTE T0B-SALES-1 (debugger, 2026-11-18)
Failing: services/api/src/modules/partners/__tests__/sales/permissions.test.ts:35 `expect(pending).toEqual([])` (verify log: 1 failed | 3491 passed; the only red).
Actual pending list = 10 MSGDESK ids (createPartnerTicket ... replyMyPartnerTicket), services/api/src/modules/partners/index.ts:78-81. All 15 sales ids have handlers and are NOT pending (line 34 passes).
Spec: LD-321 + LD-325(b) (T0C-MSGDESK-1 adds its ids to partners pendingOperations until T0B-MSGDESK-1 implements them); LD-349 (msgdesk1.pending.test.ts:29 requires those ids in the list; same exact-pin pattern, TESTS_WRONG).
Removing them breaks that test and the boot check (no handler). Implementation is correct; no impl change possible.
Fix (tester): line 35 -> every id left in pending is not a sales operation id (e.g. `expect(pending.filter((id) => OPS.some((o) => o.id === id))).toEqual([])`; line 34 already covers it). No assertion deleted.
