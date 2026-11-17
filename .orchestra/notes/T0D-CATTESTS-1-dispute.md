# T0D-CATTESTS-1 dispute (writer)
Test: `cattests1.tests-page.test.tsx` > creation form > "Save -> one POST ... -> opens the new test" (line 293).
Why it is wrong: the mocked 201 reply is `test(900, 'HGB2', ...)`, and `test(n)` sets `id: ID(100 + n)`, so the created test's id is `ID(1000)` (`...0000000e1000`). The assertion expects a push to `/catalog/tests/${ID(900)}` (`...0000000e0900`), an id the API never returned. The page pushes `/catalog/tests/<id from the 201 reply>`, which is the contract ("success -> push /catalog/tests/{id}").
Fix (tester): expect `ID(1000)` on line 293, or build the reply with `id: ID(900)`. Every other assertion of that test passes (one POST, Idempotency-Key, HGB2, ids, preferred specimen).
Result now: 39 / 40 pass; this is the only failure.
