# WEB-STYLE-1 impl (writer, LD-198)
Files (6): app/layout.tsx (tokens.css before kit.css, body lims-root), next.config.mjs (tokens guard only), core/shell/shell.css (lims-auth-page/card/wordmark/checklist + h1/form/a/p inside card; tokens, rem, % only), app/(auth)/layout.tsx (new, lims-auth-page), app/(auth)/auth/page.tsx (new, redirect('/auth/login')), core/shell/sign-in-page.ts (href /auth/login only).
Tests: web-style + build-config + build-boundaries = 3 files, 57/57 pass (WEB-STYLE-1-verify.cmd config). Real `pnpm --filter @lims/web build` exit 0 (re-run 2026-11-15, round 2). Last 15 lines:
```
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
CSS grep of apps/web/.next/static/**/*.css for `--lims-accent:` and `.lims-auth-card`: both found, only in apps/web/.next/static/chunks/24njjq4-zk5dl.css.
[CONV] lims-btn-md left to tester exception (default size); lims-description/lims-input-group already covered (test green). 100vh used for page height (no px).
Open: 401 stub stays unstyled (CSP, AC-0D-7.2) — non-blocking CR in .orchestra/cr/WEB-STYLE-1.md; real-browser visual check not done.
