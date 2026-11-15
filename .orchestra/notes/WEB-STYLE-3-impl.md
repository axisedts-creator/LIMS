# WEB-STYLE-3 impl (writer)
- Files (5): `(auth)/layout.tsx` (panel-body wrapper), `core/shell/shell.css`, `features/admin/auth/PasswordField.tsx` (lims-label-row, lims-input-wrap, lims-input-toggle), `LoginForm.tsx` + `ForgotPasswordForm.tsx` (lims-label-row). No logic change.
- [CONV] LD-205/LD-140: tokens + rem only; `body{margin:0}`, one `100dvh` (with `100vh` fallback) on `.lims-auth-page`; panel flush, stretch, column centred; stepper via `li::before` dot + `li:not(:last-child)::after` line; wordmark 2xl/bold/0.12em; inputs `width:100%`; Show absolute at `inset-inline-end`.
- Tests: `verify.cmd` = 5 files / 109 tests pass (web-style-3 + web-style, web-style-2, build-config, build-boundaries). `pnpm --filter @lims/web build` succeeds (typecheck ok, /auth/* routes built).
- NOT done: Chromium screenshots/scrollbar check at 1440x900, 1920x1080, 390x844 — no browser access from this session (could not search Program Files). Lead checks live.
- Open: `.lims-input-wrap .lims-input` end padding uses `--lims-space-12` (3rem) to clear the Show button; adjust if label "Hide" clips.
