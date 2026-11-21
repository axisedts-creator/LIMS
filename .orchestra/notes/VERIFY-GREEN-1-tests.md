# VERIFY-GREEN-1 tests (tester)
- No new test files: brief says "no new tests"; the gate is the existing `pnpm -s verify` (turbo build+typecheck, tools/lint node tests, shared-ts node tests).
- Gate is RED now per LD-253 FACT: @lims/worker#typecheck, 69 TS errors (TS2835/TS5097, TS2883, TS2430). Tester did not re-run it; the baseline is the writer's first step.
- Run: `.orchestra\notes\VERIFY-GREEN-1-verify.cmd` (one line, `pnpm -s verify`, exits non-zero on any failure).
- Re-run after the fix, for touched files: `pnpm --dir services/api exec vitest run src/modules/identity src/modules/analytics` and `node --test "packages/shared-ts/test/*.test.mjs"`.
- Not covered: no test can assert "types/specifiers only". Reviewer checks the diff for no runtime change (LD-189 for confirmEmailToken.ts).
