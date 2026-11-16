TESTS_WRONG — `summary.test.ts` miscounts its own fixture: DEEP is 4, not 3. Change line 31 to `{ DEEP: 4, SHALLOW: 1, 'NOT EXERCISED': 1 }` and line 50 to `/DEEP\D{0,12}4\b/`.

Reasons:
- Task done_when (2) (.orchestra/inbox/T0B-SWEEP-2-arbiter.md:20, LD-270 at :31) defines DEEP = reached the service (2xx or a domain answer), SHALLOW = stopped at input validation, NOT EXERCISED = 429/timeout/harness error, and requires counts "per depth and per module". It sets no fixture numbers; the test's numbers must just be correct for its fixture.
- Fixture (summary.test.ts:14-25): `row()` defaults `depth: 'DEEP'` (:16). Rows a, b, e, listWidgets keep that default, so 4 are DEEP; c is SHALLOW (:21); d is NOT EXERCISED (:22).
- The test contradicts itself: :30 expects total 6, :38 requires DEEP+SHALLOW+NOT EXERCISED = total (3+1+1 = 5 ≠ 6), and :32-34 per-module expectations give DEEP lab 2 + billing 1 + identity 1 = 4. No implementation can pass all of them.
- :50 regex `/DEEP\D{0,12}3\b/` carries the same miscount; with the fix it asserts the correct rendered total.
- No other assertion in the file changes. This weakens nothing: the fixed test is stricter (consistent with :32-38) and still covers done_when (2).
- Searched spec/chunks/C0-foundation-contracts/06-IMPLEMENTATION-PLAN.md and spec/program/08-CR-REGISTER.md for T0B-SWEEP-2 / LD-270: no matches. Nothing in the spec conflicts, so no CR is needed.
