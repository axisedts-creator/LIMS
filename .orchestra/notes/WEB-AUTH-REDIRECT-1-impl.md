# WEB-AUTH-REDIRECT-1 impl (writer)
- Files: `apps/web/src/middleware.ts` only (1 of 6). Removed `signInPageHtml` import; header comment updated.
- Unauth document request (non-JSON per existing `wantsJson`) → 307, `Location` = relative literal `/auth/login` (missing / other 401) or `/auth/session-expired` (expired); wrapped in `secure()` so CSP report-only + nonce, nosniff, referrer-policy, no-store stay. [CONV] LD-200 cited in code.
- JSON → problem+json 401 unchanged; `SESSION_EXEMPT`, CSRF-first order, session logic, cookies untouched. Relative Location → no Host/X-Forwarded echo, no query, no open redirect.
- `core/shell/sign-in-page.ts` untouched; no non-test caller remains in `apps/web/src` (only `web-style.test.ts` reads it).
- Tests: `WEB-AUTH-REDIRECT-1-verify.cmd` config → 4 files, 78/78 pass.
- Build (2026-11-15, `pnpm --filter @lims/web build`, last 15 lines; only warning = pre-existing middleware→proxy deprecation):
```
├ ƒ /reporting/settings
├ ƒ /reporting/templates
├ ƒ /reporting/templates/[template_id]
├ ƒ /smartreport/library
├ ƒ /smartreport/library/[library_version_id]
├ ƒ /smartreport/library/[library_version_id]/review
├ ƒ /smartreport/summaries
├ ƒ /smartreport/summaries/[summary_id]
└ ƒ /smartreport/wording


ƒ Proxy (Middleware)

○  (Static)   prerendered as static content
ƒ  (Dynamic)  server-rendered on demand
```
exit 0
- Open: full web suite and non-blocking CR to C0-0D (03-APP-FLOW wording) not run/written by writer.
