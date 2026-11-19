# VERIFY-GREEN-5 impl (writer, round 5, per LD-405 option a)
- apps/web/tsconfig.json: `"@/*": ["./src/*", "../portal/src/*"]` + LD-405 comment (unchanged since round 3; no new edit this round). No collision with apps/web/src.
- Typecheck `turbo run typecheck --continue`: @lims/web before 9 non-test (portal pages, notes/VERIFY-GREEN-5.md), after 0 non-test; remaining errors all in test files (VG-6/7/8 scope). Other 10 packages 0.
- Run 2026-11-19 08:58: vg5 17/17, web-build-2 37/37, rs-c6 59/60. Only fail = `worklist` outline snapshot (stale .snap, lacks `button Ready to release`); arbiter 4a738f3ff ruled TESTS_WRONG, tester must re-record under T0D-UILIST-1/LD-362. Writer may not edit .snap; no VG5 impl change.
- No money or order code touched: no emitted value, rounding, status or SQL changed. No @ts-ignore, `as any`, skipLibCheck.
- Open: tester re-record of rs-c6.screens worklist snapshot; whole web suite not run.
