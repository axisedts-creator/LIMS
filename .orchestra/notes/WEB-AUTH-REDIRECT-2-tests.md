# WEB-AUTH-REDIRECT-2 tests (tester)
- Edited apps/web/src/__tests__/web-auth-redirect.test.ts: Location parsed with no base (relative fails); new block asserts exact `<origin>/auth/login|session-expired` and that origin follows the request; source guard requires LD-203 cited in middleware.ts.
- New apps/web/src/__tests__/web-auth-redirect-server.test.ts: real server. beforeAll runs `pnpm --filter @lims/web build`, then `next start -H 127.0.0.1` on a free port. Asserts 307 + absolute Location for /, /dashboard, /no-such-page (html); CSP/headers kept; no open redirect; 401 problem+json (json); 200 for /auth/login and /auth/session-expired. Server killed in afterAll.
- New apps/web/src/__tests__/vitest.web-auth-redirect-2.config.ts (also keeps web-style, build-config, build-boundaries green; files serial).
- Run: .orchestra\notes\WEB-AUTH-REDIRECT-2-verify.cmd (slow: includes the full web build).
- Expected now: unit absolute-Location tests and real-server 307 tests fail (relative Location / 500). JSON and 200 tests should pass. NOT yet run by tester (see report).
