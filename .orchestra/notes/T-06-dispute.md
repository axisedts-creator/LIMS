# T-06 dispute (writer, review-fix round)
- Test helper `services/api/src/modules/catalog/__tests__/helpers/testsDb.ts` does not compile: `testsDb.ts:186:6: ERROR: Expected ")" but found "const"` (esbuild transform).
- Cause: line 174 lost a newline in the tester's review-fix (`COLLATE "C"` support). The comment `// fake compares by code point == COLLATE "C"` now swallows `return { ev: parseExpr(mm[1]!), desc: … }; });` on the same line.
- Effect: 5 catalog files fail to load (testsDb.test, orderables.search, tests.handlers, tests.service, perf); the other 12 files pass, 1468/1468.
- Fix (tester owns it): put a line break after the comment on line 174, before `return`.
- Writer change applied: `repo/tests.repo.ts:88` ORDER BY `..., LENGTH(code), code COLLATE "C"` (review item 1). Could not be checked against the T-06 tests until the helper compiles.
