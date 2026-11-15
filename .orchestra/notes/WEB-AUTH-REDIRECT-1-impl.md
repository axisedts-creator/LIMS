# WEB-AUTH-REDIRECT-1 impl (writer)
- Files: `apps/web/src/middleware.ts` only (1 of 6). Removed `signInPageHtml` import; header comment updated.
- Unauth document request (non-JSON per existing `wantsJson`) → 307, `Location` = relative literal `/auth/login` (missing / other 401) or `/auth/session-expired` (expired); wrapped in `secure()` so CSP report-only + nonce, nosniff, referrer-policy, no-store stay. [CONV] LD-200 cited in code.
- JSON → problem+json 401 unchanged; `SESSION_EXEMPT`, CSRF-first order, session logic, cookies untouched. Relative Location → no Host/X-Forwarded echo, no query, no open redirect.
- `core/shell/sign-in-page.ts` untouched; no non-test caller remains in `apps/web/src` (only `web-style.test.ts` reads it).
- Tests: `WEB-AUTH-REDIRECT-1-verify.cmd` config → 4 files, 78/78 pass.
- Build: `pnpm --filter @lims/web build` completed (Compiled, TypeScript finished, 13/13 static pages, route table printed, `ƒ Proxy (Middleware)`); exit status not captured (tool blocked `$?`), no error output. Next warns `middleware` is deprecated → `proxy` (pre-existing, out of scope).
- Open: full web suite and non-blocking CR to C0-0D (03-APP-FLOW wording) not run/written by writer.
