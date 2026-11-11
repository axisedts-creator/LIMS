# PG-T09 dispute (writer) — 1 test is wrong
`callbacks.http.test.ts` AC-PG-14.2 test (~l.528-530, also l.55, l.520, l.528 `t.callbacks(A|B)`): `const A = TENANTS.A, B = TENANTS.B` are UUIDs, but the harness `callbacks(t: Tenant = 'A')` takes `'A' | 'B'` and does `TENANTS[t]`. `t.callbacks(B)` -> `TENANTS[<uuid>]` = undefined -> default tenant A, so the test reads A's rows and expects 1 -> got 0. Same bug makes `t.callbacks(B)/(A)` assertions elsewhere vacuous (l.55, l.520, l.530).
Proof: a scratch test (deleted) with `t.callbacks('B')` -> 1 row, `t.callbacks('A')` -> 0 rows passes against the implementation.
Fix (tester): call `t.callbacks('B')` / `t.callbacks('A')`. Not edited by writer (test files are read-only for this role).
