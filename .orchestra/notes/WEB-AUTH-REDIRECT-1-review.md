CHANGES

Code review of `760316b4..HEAD` found no defects in the code. The only problem is one missing deliverable in the impl note.

1. `.orchestra/notes/WEB-AUTH-REDIRECT-1-impl.md:6`: LD-200 requires the last 15 lines of the real `pnpm --filter @lims/web build` output in the impl note. The note only paraphrases the build and says "exit status not captured". Fix: replace line 6 with a fenced block holding the verbatim last 15 lines of the build output, followed by `exit 0`. The reviewer re-ran the build on 2026-11-15: it exits 0, the route table ends with `ƒ Proxy (Middleware)`, and the only warning is the old middleware-to-proxy deprecation notice, so pasting that output is enough.

Verified (no action needed):
- `apps/web/src/middleware.ts:91-99`: a non-JSON request without a session gets a 307. Location is the relative literal `/auth/session-expired` when the reason is expired and `/auth/login` otherwise. The response goes through `secure()`, so it keeps the CSP report-only header with a fresh nonce plus nosniff, referrer-policy and no-store. JSON requests still get the unchanged problem+json 401. Resolver failures that are not 401 are still relayed. SESSION_EXEMPT and the CSRF-before-session order are unchanged, so /auth/* and /queue-display are never redirected and nothing loops. LD-200 is cited.
- The redirect target uses no request data, so there is no open redirect and no echo of the query, Host or X-Forwarded-* headers. No cookie is set and no token appears in the response (REQ-SEC-068). Nothing is logged.
- Scope: 6 files, all in owned paths (`apps/web/src/**` and the task's own notes). `sign-in-page.ts` is untouched. Its only remaining caller is `web-style.test.ts`, and the impl note says so. No session, cookie, CSP-value, spec, db or lockfile changes.
- Tests cover done_when and the ACs: 307 with Location for both reasons, JSON unchanged, public paths with and without a stale cookie, CSP on the redirect, hostile query and Host input, CSRF 403 before any redirect, and source guards.
- Reviewer ran the verify.cmd config and got 78/78 passing. `t12.source.test.ts` plus `rs-c6.static.test.ts` gave 50/50 passing. `pnpm --filter @lims/web build` exited 0.
- RLS, idempotency and rate tier do not apply here: the change is middleware only, with no DB or API surface.
