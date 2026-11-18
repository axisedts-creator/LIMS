TESTS_WRONG — the test asserts something the spec does not require (say precisely what to change in the test)

Reasons and exact change (tester; no implementation change; no contract or migration change):
1. permissions.test.ts:35 `expect(pending).toEqual([])` requires the whole partners pendingOperations list to be empty. No spec line requires that. The 10 partner ticket ids in services/api/src/modules/partners/index.ts:79-80 are MSGDESK operations, and they belong in that list until T0B-MSGDESK-1 implements them (LD-325(b), task brief line 35; LD-321 MSGDESK = partner message to lab tickets, line 34).
2. LD-349 (brief line 37) already ruled the reverse exact pin TESTS_WRONG: MSGDESK and sales ids share the partners list. LD-373 (brief line 41) rules this same line 35 TESTS_WRONG, and says the writer and debugger must NOT remove those ids or stub them.
3. Line 34 already checks every one of the 15 sales ids: each is in the contract, has a function handler, and is not pending. So this is the sales rule the task needs (done_when (1)).
4. CHANGE (permissions.test.ts:35 only): delete `expect(pending).toEqual([]);` as LD-373 says. Or replace it with the narrower check from the dispute, `expect(pending.filter((id) => OPS.some((o) => o.id === id))).toEqual([]);`. Leave every other assertion in that file exactly as it is.
5. Do not edit index.ts, the pending list, msgdesk1.pending.test.ts or the contract. Then run the verify (main command and timing command) three times in a row (LD-363, LD-355 (3)).
