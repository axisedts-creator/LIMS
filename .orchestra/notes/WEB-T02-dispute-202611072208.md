# WEB-T02 dispute (writer)
1. Static guards (web-t02.components.test.tsx:382/394/404) build paths from `process.cwd()` assuming cwd = `apps/web`, but `WEB-T02-verify.cmd` cds to the repo root; vitest `root:` does not chdir. Result: 3 ENOENT failures (`C:\LIMS-lanes\C7\src\features\instruments\components`) unrelated to the code.
   - Evidence: from repo root (verify.cmd) → 41/44 pass, only these 3 fail; `cd apps/web && node ../../node_modules/vitest/vitest.mjs run --config src/features/instruments/__tests__/vitest.web-t02.config.ts` → 44/44 pass.
   - Fix (tester): resolve from the test file (`fileURLToPath(new URL('../components', import.meta.url))`) or make verify.cmd `cd /d "%~dp0..\..\apps\web"` and call `..\..\node_modules\vitest\vitest.mjs`.
2. FYI, not blocking: `tsc` flags `server.listen({ onUnhandledRequest: 'error' })` (both test files, TS2353) against msw 3.0.3 types; runtime is fine.
