APPROVE
# WEB-AUTH-REDIRECT-2 review (reviewer)
- Scope: middleware.ts (document branch of unauth() only) + 3 test files = 4 app files (<= 6, LD-203). JSON branch, problem+json 401, CSP/nonce, CSRF, session, cookies unchanged. No auth pages, package.json, lockfile, spec, db touched.
- Fix: `NextResponse.redirect(new URL(literal, req.nextUrl.origin), 307)` wrapped in secure(); path is a fixed literal (no open redirect); LD-200 + LD-203 cited. Matches LD-203 and ruling item 6.
- Names verbatim: auth.unauthenticated, auth.session_expired, /auth/login, /auth/session-expired. No secrets, no PHI, synthetic hosts only; real-server test is loopback (127.0.0.1) and starts/stops its own server.
- Tests cover done_when: unit exact absolute Location + origin follows request; real server 307 for /, /dashboard, /no-such-page, CSP/nosniff/no-store kept, no set-cookie, hostile query/x-forwarded-host not echoed, 401 problem+json for JSON, 200 for both auth pages. Real-server assertions follow the ruling (relative wire Location resolved against base).
- Ran myself: verify config -> 5 files, 90/90 pass, 51 s (includes `pnpm --filter @lims/web build` exit 0 inside beforeAll).
- RLS / permissions / idempotency / rate tier: not applicable (web middleware only).
