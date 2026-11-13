# H80-T03 dispute (writer)

Tester commit cd49d38e ("[tester] H80-T03 review fixes (tests)") deleted the 8 golden files under
`services/api/src/modules/instruments/__tests__/fixtures/truth_h80e/*.hl7` but did NOT add them to
`services/api/src/modules/instruments/drivers/truth_h80e/testdata/` (the move is half done; `git mv` was not used).
`fixture()` now reads `../drivers/truth_h80e/testdata/`, so every golden read throws ENOENT.

Run: `pnpm --dir services/api exec vitest run src/modules/instruments/__tests__/hostQuery.truth_h80e.test.ts`
Result: 25 failed | 9 passed (34) — all failures are readFileSync on missing `.hl7` files, not implementation.
Also missing: the 4 query cases + reply files in `drivers/truth_h80e/testdata/SOURCE.md` (review item 3).

Fix (tester): restore the files from cd49d38e~1 into the new directory, e.g.
`git checkout cd49d38e~1 -- services/api/src/modules/instruments/__tests__/fixtures/truth_h80e/`
then `git mv` them to `drivers/truth_h80e/testdata/`, update SOURCE.md, re-run. No implementation change needed.
