# C6-T42 debug (2026-11-11)
- Cause: not an implementation defect. Verify run failed 2 pay E2E (tests 4, 6); my rerun failed 3 DIFFERENT ones (AC-18.1, AC-18.2, AC-18.6) — all 60s test timeouts (`Test timeout of 60000ms exceeded`), never assertion mismatches. api 31/31, worker 23/23, static 5/5 green; tests that pass take 35-47s each under cold `next dev` + machine load (login alone 6-45s).
- Fix: none in impl code. Flake is the Playwright harness (tests/portal-e2e/playwright.pay.config.ts: `next dev`, timeout 60_000) — tester-owned. Suggest tester: `next build && next start` webServer and/or `timeout: 120_000`; rerun when machine idle.

## Round 2 (verify: worker E2E AC-18.3 timed out at 30s)
- Cause: not a T42 impl defect. First E2E `w.run` does `import('../index.js')` (portal.helpers.ts:357) = whole reporting module -> domain/sanitise.ts loads jsdom synchronously at import ([CONV] pre-warm). jsdom cold load is 25-45s here (C6-T33 obs 3644). Reproduced alone: whichever E2E runs first times out (46s / 65s); the other passes warm (7s). Test file sets `vi.setConfig({ testTimeout: 30_000 })`.
- Fix: none in impl code (changing sanitise.ts laziness would break the [CONV] and is another task's file). Tester: warm-import in a `beforeAll(..., 120_000)` or `{ timeout: 120_000 }` on the E2E `it`s; same advice as round 1 for the Playwright harness.

## Round 3 (verify: portal.payment.test.ts "both operations have a registered handler" timed out 30s; 30/31 pass)
- Cause: not a T42 impl defect. Test does first `await import('../index.js')` in the file (l.41); reporting index pulls domain/sanitise.ts -> jsdom sync pre-warm ([CONV]); cold load took 59s under load (same as round 2 / C6-T33 obs 3644). Handlers exist, all behaviour tests pass.
- Fix: none in impl (sanitise.ts laziness is another task's file and would break [CONV]). Tester: warm-import in `beforeAll(..., 120_000)` or `{ timeout: 120_000 }` on that `it`; raise the file-level `vi.setConfig({ testTimeout })` above 30_000.
