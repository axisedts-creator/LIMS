APPROVE

Round 2 (diff 98166f24..da4bcb37). Both items from round 1 are fixed:
1. apps/web/src/__tests__/sec-hyg1.pollers.test.tsx: `mount` is now typed as Promise. `tsc --noEmit -p apps/web` shows no errors in sec-hyg1 or in the five poller files. The 378 web typecheck errors that remain were there before this task (MSW `onUnhandledRequest`, offline tests) and are not in its scope.
2. tools/lint/gen-stubbed-operations.mjs:32: the gate now also matches `notImplemented` and `stub(`. The doc text names a generic fail-closed error. Regenerating gives the same list; `--check` exits 0.

What I checked and found correct:
- `git ls-files` lists no `.tmp` or `test-results/` path.
- .gitignore has `.tmp/`, `*.tmp` and `test-results/`.
- The five pollers still use their original intervals and catch paths.
- homecollection and anatomic, the examples named in LD-240, have no stubs left. The test's independent oracle agrees.
- No PHI, no secrets, no spec, contracts or db edits. Every path is inside the LD-240 file list.
- CR SEC-HYG-1.1.nonblocking.md covers wiring the tests into verify and CI.

Runs:
- `node --test tests/security/sec-hyg1.test.mjs`: 12/12 pass.
- vitest with `vitest.sec-hyg1.config.ts`: 29 pass, 2 skipped by design.
- `pnpm -s verify` is still red, but only because of the web typecheck errors that existed before this task.
