CHANGES
1. services/api/src/modules/catalog/__tests__/helpers/testsDb.ts:174 — the tester's review fix put the `// fake compares by code point == COLLATE "C"` comment before `return { ev: parseExpr(mm[1]!), desc: /^DESC$/i.test(mm[2] ?? '') }; });` on the same line, so the comment swallows that code. The file no longer compiles (`testsDb.ts:186:6: ERROR: Expected ")" but found "const"`). Because of that, 5 of the 17 catalog test files fail to load (testsDb.test, orderables.search, tests.handlers, tests.service, perf). None of the T-06 ACs or the perf budget is being checked right now. Fix: put a line break after the comment so `return { ... }; });` starts its own line, or move the comment to the end of the statement. Then re-run the catalog suite; all 17 files must pass.

Round-1 item 1 resolved in code: `repo/tests.repo.ts:88` now ends `ORDER BY ${rank}, LENGTH(code), code COLLATE "C"`. That fix cannot be confirmed by tests until item 1 above is fixed.
Re-checked, no new defect in 7644ea8..HEAD: only owned C3 paths, no logging, no secrets, no new names.
Run here: `vitest run src/modules/catalog` gave 5 files failed (transform error), 12 passed, 1468/1468 tests pass.
Still carried over from T-03 (not T-06): `stampOrderable` has no tenant predicate.
