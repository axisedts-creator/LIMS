# WEB-AUTH-REDIRECT-2 impl (writer)
- Files: apps/web/src/middleware.ts only (unauth() document branch → NextResponse.redirect(new URL(literal, req.nextUrl.origin), 307), secure() kept; LD-203 cited). Unchanged after ruling (ruling item 6).
- Reproduced before: real `next start`, html / /dashboard /no-such-page → 500; log `TypeError: Invalid URL input '/auth/login'`. After: 307 → /auth/login; json 401 problem+json; /auth/login, /auth/session-expired 200.
- Tests (revised per ruling): verify config run → 5 files, 90/90 pass (incl. real-server test).
- Build: `pnpm --filter @lims/web build` exit 0. Last 15 lines: route table ending `├ ƒ /smartreport/summaries/[summary_id]`, `└ ƒ /smartreport/wording`, blank, `ƒ Proxy (Middleware)`, blank, `○  (Static)   prerendered as static content`, `ƒ  (Dynamic)  server-rendered on demand`.
- [CONV] wire Location is relative: Next's server relativises same-origin redirects; middleware emits absolute (unit-tested).
- Open: none. Not covered: real sign-in session loading staff pages (founder staging test).
