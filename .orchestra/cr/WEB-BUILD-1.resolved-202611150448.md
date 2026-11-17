Title: CR-C1-WEB-BUILD-1: next build type-check fails with 279 errors in 165 files (beyond LD-194 mechanical scope)
From chunk: C1            To owner: founder (via lead); affected: C0-0D (ui-kit), catalog lane, reporting/portal lane, all lanes with apps/web tests
Type: bug
Blocking? yes — C1 WEB-BUILD-1 done_when (`pnpm --filter @lims/web build` exits 0). LD-194 RULES (b): >15 files, and some fixes need an API/design decision.
Problem: After the LD-194 fixes (a)-(c), Turbopack compile now passes ("Compiled successfully in 26.4s"; the 8 boundary errors are gone). Next then runs TypeScript over apps/web/tsconfig.json, which includes src/**/*.ts(x) = every test file. `tsc --noEmit -p apps/web`: 279 errors in 165 files.
  1. 160 files are tests (__tests__/ or *.test.*): e.g. vitest 5 `onUnhandledRequest` option no longer typed (many files), exactOptionalPropertyTypes mismatches, possibly-undefined calls (web-t32.server.test.ts), fixture shape drift (web-t33/t34 `code`/`name`).
  2. 2 files are apps/portal (../portal/src/app/r/[token]/page.tsx, report/page.tsx): pulled in by apps/web/src/features/reporting/__tests__/rs-c6.portal.test.tsx relative import; their `@/` aliases resolve to apps/web/src, so TS2307.
  3. 3 real app files (catalog), ui-kit prop contract mismatches, not mechanical:
     - catalog/components/PriceListDetail.tsx:67 TextField missing required `maxLength` (read-only field).
     - SurchargeRulesScreen.tsx:121, TaxScreen.tsx:157 search fn `(q, kind?)` vs ui-kit `(query, signal: AbortSignal)`.
     - SurchargeRulesScreen.tsx:125-126, TaxScreen.tsx:196,221 `inputMode="decimal"` not in ui-kit union `email|numeric|tel|text`.
Proposed change (needs decision, not done):
  A. apps/web/tsconfig.json: exclude test files from the app type-check (`"exclude": ["node_modules", "src/**/__tests__/**", "src/**/*.test.ts", "src/**/*.test.tsx"]`), with a separate tsconfig for tests owned by each lane. Removes groups 1 and 2 (162 files) from the build. Changes type-check coverage of tests, so it needs a decision.
  B. Group 3: either ui-kit (C0-0D) widens TextField `maxLength` to optional / adds `"decimal"` to inputMode / accepts the search signature, or the catalog lane adapts its calls. Either way an API choice, 3 app files + maybe packages/ui.
  Not proposed: `typescript.ignoreBuildErrors` (hides real errors).
Backward compatible? A: yes for runtime; test type errors stay until lanes fix them. B: depends on option.
Tenant/security impact: none (no RLS, no PHI, no new public surface).
Alternatives considered: fix all 165 files mechanically (exceeds the LD-194 15-file cap; test files belong to other lanes' testers).
Tests that will prove it: `pnpm --filter @lims/web build` exits 0; `tsc --noEmit -p apps/web` 0 errors; apps/web/src/__tests__/build-boundaries.test.ts stays 16/16.
