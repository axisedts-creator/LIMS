# SEC-HYG-1.1 (non-blocking)

```
Title: CR-C1-SEC-HYG-1.1: wire the SEC-HYG-1 freshness and poller tests into pnpm -s verify / CI
From chunk: C1            To owner: C1
Type: bug
Blocking? no
Problem (what you cannot do today, with the user story / acceptance criterion it serves):
  LD-240 done_when "a test fails when it is stale": tests/security/sec-hyg1.test.mjs (runs
  `node tools/lint/gen-stubbed-operations.mjs --check`) and apps/web/src/__tests__/sec-hyg1.pollers.test.tsx
  (own config vitest.sec-hyg1.config.ts) are not run by `pnpm -s verify` or .github/workflows, so a stale
  docs/stubbed-operations.md only fails when someone runs the test by hand. Wiring them needs files
  outside the LD-240 file list (root package.json / turbo pipeline or .github/workflows/pr.yml).
Proposed change (exact): add a CI step (pr.yml) or verify script entry running
  `node tools/lint/gen-stubbed-operations.mjs --check` and
  `pnpm --dir apps/web exec vitest run --config src/__tests__/vitest.sec-hyg1.config.ts`.
Backward compatible? yes
Tenant/security impact: none (static check, no RLS, no PHI, no new surface)
IRD/regulatory impact: none
Alternatives considered: leave manual (rejected: freshness guarantee is then advisory only).
Tests that will prove it: CI run fails after editing docs/stubbed-operations.md by hand.
```
