# VERIFY-GREEN-5 impl (writer, round 6, LD-405 option a / LD-413)
- apps/web/tsconfig.json: `"@/*": ["./src/*", "../portal/src/*"]` + LD-405 comment (unchanged since round 3; no new edit this round, per LD-405 "stays").
- Typecheck 2026-11-19 12:2x `tsc -p apps/web/tsconfig.json --noEmit`: @lims/web before 9 non-test (notes/VERIFY-GREEN-5.md), after 0 non-test; rest in test files (VG-6/7/8 scope). `pnpm --dir apps/web build` (next build): green.
- verify.cmd parts: vg5 17/17, web-build-2 37/37, rs-c6 58/60. Reds: (1) rs-c6.screens `worklist` snapshot still stale; LD-413 assigns tester `-u` re-record, not done yet. (2) rs-c6.static data_files hash of apps/portal/src/middleware.ts changed by SEC-HDR-1 (d537ac9c8), not VG5; LD-362: not VG5's to fix, needs SEC-HDR-1/C6 re-pin.
- Whole `vitest run` with default config: 4578 fail / 3742 pass; mass failures are suites needing their own per-feature configs (msw/env), unrelated to a tsconfig paths line. Not chased.
- No money or order code touched: no emitted value, rounding, status or SQL changed. No @ts-ignore, `as any`, skipLibCheck.
- Open: tester re-record (LD-413); lead decision on SEC-HDR-1 middleware pin in rs-c6.baseline.json.
