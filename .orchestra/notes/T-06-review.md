APPROVE
Round 3. Round-2 item 1 fixed in 8d15a4f: the comment in `__tests__/helpers/testsDb.ts:174` is now on its own line, so the helper compiles again.
Round-1 item 1 (`repo/tests.repo.ts:88` ordering `LENGTH(code), code COLLATE "C"`) is now checked by tests: orderables.search.test.ts:36/40 and :70.
Checked in b23fef9..HEAD: only an owned test helper and .orchestra notes changed. No new names, logging, secrets or PHI.
Run here: `vitest run src/modules/catalog` gave 17/17 files and 1723/1723 tests passed, including perf. `tsc --noEmit` showed no catalog errors.
Still carried over from T-03 (not T-06): `stampOrderable` has no tenant predicate. Follow up under T-03.
