# WEB-AUTH-REDIRECT-1 tests (tester)
- `apps/web/src/__tests__/web-auth-redirect.test.ts` (21 tests): behavioural, calls `middleware()` with a mocked session resolver. Covers 307 + literal Location for missing/expired/other-401, JSON stays problem+json 401, public paths (/auth/*, /queue-display/*) never redirected, CSP + security headers + fresh nonce on the redirect, hostile query/Host/X-Forwarded-* never reach Location, no session id echo / no Set-Cookie (REQ-SEC-068), CSRF 403 still first, source guards (LD-200 cited, exempt list unchanged).
- `apps/web/src/__tests__/vitest.web-auth-redirect-1.config.ts`: runs the new test plus web-style, build-config, build-boundaries (must stay green).
- Run: `.orchestra\notes\WEB-AUTH-REDIRECT-1-verify.cmd` (exit non-zero on failure).
- Now (pre-impl): 10 fail, all because middleware returns 401 + HTML stub instead of 307 (and no LD-200 / literal targets in source); 11 new + 57 existing pass.
- Not covered: real `next build` (impl must run `pnpm --filter @lims/web build`); POST+HTML redirect semantics (brief silent; CSRF-first order is asserted).
- web-style.test.ts (e) still passes: sign-in-page.ts stays untouched.
