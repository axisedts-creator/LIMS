APPROVE

Round 2 review of `760316b4..HEAD` (HEAD a2b43d19).

- Round-1 item 1 is fixed. `.orchestra/notes/WEB-AUTH-REDIRECT-1-impl.md` now holds the verbatim last 15 lines of `pnpm --filter @lims/web build`, ending with `ƒ Proxy (Middleware)`, followed by `exit 0`. This matches the reviewer's own build run on 2026-11-15.
- Nothing else changed since round 1 (a2b43d19 touches only the impl note), so the round-1 code findings still hold:
  - `apps/web/src/middleware.ts:91-99`: a document request without a session gets a 307 to the literal `/auth/session-expired` (expired) or `/auth/login` (missing or other 401).
  - The redirect goes through `secure()`, so it keeps CSP with a fresh nonce, nosniff, referrer-policy and no-store.
  - JSON requests still get the unchanged problem+json 401.
  - SESSION_EXEMPT and the CSRF-before-session order are unchanged, so nothing loops.
  - No request data reaches Location, so there is no open redirect. No token or cookie is echoed (REQ-SEC-068). LD-200 is cited.
- Scope: 6 files, all in owned paths. `sign-in-page.ts` is untouched; its only remaining caller is a test, and the impl note says so.
- The reviewer re-ran the verify.cmd config: 4 files, 78/78 passing.
- RLS, idempotency and rate tier do not apply: the change is middleware only, with no DB or API surface.
- Non-blocking: the impl note says the non-blocking CR to C0-0D (03-APP-FLOW wording, per LD-200) is not written yet. The lead should track it; it does not block this task.
