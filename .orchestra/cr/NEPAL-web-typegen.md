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

## Unowned paths blocking a green typecheck (2 errors left, lead 2026-11-18)
- apps/web/src/features/webfix1/__tests__/webfix1.pages.test.tsx:102: `onUnhandledRequest:` -> `onUnhandledFrame:` (same msw 3 rename).
- apps/web/src/__tests__/web-auth-redirect.test.ts:167 (TS2379, exactOptionalPropertyTypes). Proposed patch:
```diff
diff --git a/apps/web/src/__tests__/web-auth-redirect.test.ts b/apps/web/src/__tests__/web-auth-redirect.test.ts
index d991408b..db320a4f 100644
--- a/apps/web/src/__tests__/web-auth-redirect.test.ts
+++ b/apps/web/src/__tests__/web-auth-redirect.test.ts
@@ -17,7 +17,7 @@ const SID = 'sid-synthetic-0123456789';
 const COOKIE = `__Host-lims_sid=${SID}`;
 const HTML = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
 
-const req = (path: string, init: { accept?: string | null; cookie?: string; method?: string; headers?: Record<string, string> } = {}) => {
+const req = (path: string, init: { accept?: string | null; cookie?: string | undefined; method?: string; headers?: Record<string, string> } = {}) => {
   const headers: Record<string, string> = { ...(init.headers ?? {}) };
   if (init.accept !== null) headers.accept = init.accept ?? HTML;
   if (init.cookie) headers.cookie = init.cookie;
```
Ask: C0-0A adds owners for `apps/web/src/features/webfix1/**` and `apps/web/src/__tests__/**` in tools/lint/ownership.yaml; the owner then applies both.
