# VERIFY-GREEN-5 impl (writer, round 7, LD-405 option a / LD-413 / LD-419)
- apps/web/tsconfig.json: `"@/*": ["./src/*", "../portal/src/*"]` + LD-405 comment (unchanged since round 3; no new edit this round, per LD-405 "stays").
- Typecheck 2026-11-19 12:2x `tsc -p apps/web/tsconfig.json --noEmit`: @lims/web before 9 non-test (notes/VERIFY-GREEN-5.md), after 0 non-test; rest in test files (VG-6/7/8 scope). `pnpm --dir apps/web build` (next build): green (round 6; no product change since).
- verify.cmd parts (2026-11-19 13:18, after a25c53825): vg5 17/17, web-build-2 37/37, rs-c6 59/60. rs-c6.static middleware pin now green (LD-419 re-pin). Only red: rs-c6.screens `worklist 1` snapshot still stale; __snapshots__/rs-c6.screens.test.tsx.snap unchanged since 2e2dd94ab, so the LD-413 tester `-u` re-record is NOT committed yet. Test file; writer may not touch.
- Whole `vitest run` with default config: 4578 fail / 3742 pass; mass failures are suites needing their own per-feature configs (msw/env), unrelated to a tsconfig paths line. Not chased.
- No money or order code touched: no emitted value, rounding, status or SQL changed. No @ts-ignore, `as any`, skipLibCheck.
- Open: tester re-record of `worklist 1` snapshot (LD-413). No implementation change this round.
