APPROVE

WEB-STYLE-3 review (reviewer, 2026-11-15), diff 7d6f97e1..HEAD.
- Scope: 5 source files (layout.tsx, shell.css, PasswordField/LoginForm/ForgotPasswordForm) + tester files; all within LD-205 scope, <= 10 files. No auth logic, cookie, middleware, CSP, spec, db, package.json, packages/ui or apps/portal|partner change.
- LD-205 fixes: (1) `body{margin:0}`, single 100dvh (100vh fallback) on .lims-auth-page, panel stretch/no padding at >= 64rem; (2) inputs width 100% border-box, Show button absolute inside `.lims-input-wrap` at inline-end, aria-pressed/type=button/tab order unchanged; (3) RequiredNote text moved into `.lims-label-row` on all three field sites (login email, forgot email, PasswordField: login + set-password); aria-required unchanged; (4) panel body wrapper, 2xl/bold title, dot+line stepper, labels verbatim, aria-hidden kept, hidden below 64rem; (5) wordmark 2xl/bold/0.12em, text only.
- LD-140: new CSS tokens/rem/em/% only; tokens used (space-1/2/8/12, font-size-2xl-size, font-weight-bold, radius-full, accent-brand) exist in packages/ui. No hex, px or inline style added.
- No PHI, no secrets, nothing invented.
- Ran: `.orchestra/notes/WEB-STYLE-3-verify.cmd` equivalent: 5 files / 109 tests pass (web-style-3, web-style, web-style-2, build-config, build-boundaries).
- Not verified: live no-scrollbar at 1440x900 / 1920x1080 / 390x844 (static tests cannot prove it; writer had no browser). Lead to check live as LD-205 allows. I did not rerun `pnpm --filter @lims/web build`.
