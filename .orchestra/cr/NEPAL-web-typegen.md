Title: CR-C1-901 (nepal series 9xx; also filed as NEPAL-web-typegen): apps/web typecheck must run `next typegen` (and C0-0D test files use msw 3 option name)
From chunk: C1 (nepal)    To owner: C0-0D
Type: bug
Blocking? yes: `pnpm -s verify` (turbo typecheck) fails on a fresh clone.
Problem: `apps/web/next-env.d.ts` is gitignored and produced only by Next, so `tsc` on a fresh clone cannot resolve image imports in `src/core/shell/brand.ts` (4 × TS2307). Separately, msw 3.0.3 (pinned) renamed `onUnhandledRequest` to `onUnhandledFrame`; the old key is ignored at runtime, so `'error'` strictness silently degrades to `'warn'` (188 × TS2353 across chunks, fixed per chunk in commits "[nepal] W2 Cxx").
Proposed change (exact): apps/web/package.json `"typecheck": "pnpm run build:nav && next typegen && tsc -p tsconfig.json --noEmit"`; r04.keys/r04.search tests: `onUnhandledRequest:` → `onUnhandledFrame:` (value unchanged).
Backward compatible? yes. Tenant/security impact: none (test strictness restored). IRD impact: none.
Alternatives considered: committing next-env.d.ts (rejected: Next regenerates it; it is gitignored by design).
Tests that will prove it: `rm apps/web/next-env.d.ts && pnpm --filter @lims/web typecheck` shows no TS2307 for brand.ts; vitest r04 config unchanged pass/fail vs baseline (lead ran: 1 pre-existing failure both before and after).
Also: `apps/web/src/features/webfix1/**` has no owner in tools/lint/ownership.yaml (check-paths: no single owner); its msw rename is left undone until C0-0A assigns one.
