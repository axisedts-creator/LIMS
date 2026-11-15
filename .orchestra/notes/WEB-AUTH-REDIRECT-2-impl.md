# WEB-AUTH-REDIRECT-2 impl (writer)
- Files: apps/web/src/middleware.ts only (unauth() document branch → NextResponse.redirect(new URL(literal, req.nextUrl.origin), 307), secure() kept; LD-203 cited).
- Reproduced before: real `next start`, html / /dashboard /no-such-page → 500; log `TypeError: Invalid URL input '/auth/login'`. After: 307 → /auth/login; json 401 problem+json; /auth/login, /auth/session-expired 200.
- Tests: 85/90 pass. 5 fail on test-side assumptions → see WEB-AUTH-REDIRECT-2-dispute.md (wire Location is relative because Next relativises same-origin redirects; NextURL maps 127.0.0.1→localhost).
- Build: `pnpm --filter @lims/web build` ran after the fix, compiled and generated all pages (exit code not captured through the pipe; the test suite's beforeAll build ran OK).
- Last build lines: Route table ends `└ ƒ /smartreport/wording`, `ƒ Proxy (Middleware)`, `○ (Static)`, `ƒ (Dynamic)`.
- Open: dispute above; not covered: real sign-in session loading staff pages (founder staging test).
