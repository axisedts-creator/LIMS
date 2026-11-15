# WEB-STYLE-1 impl (writer, LD-198)
Files (6): app/layout.tsx (tokens.css before kit.css, body lims-root), next.config.mjs (tokens guard only), core/shell/shell.css (lims-auth-page/card/wordmark/checklist + h1/form/a/p inside card; tokens, rem, % only), app/(auth)/layout.tsx (new, lims-auth-page), app/(auth)/auth/page.tsx (new, redirect('/auth/login')), core/shell/sign-in-page.ts (href /auth/login only).
Tests: web-style + build-config + build-boundaries = 3 files, 57/57 pass (WEB-STYLE-1-verify.cmd config). Real `pnpm --filter @lims/web build` exit 0.
Build tail (last lines): `○ /auth` and `○ /auth/forgot`, `ƒ /auth/login` … `└ ƒ /smartreport/wording`, `ƒ Proxy (Middleware)`, `○ (Static)  ƒ (Dynamic)`; "Compiled successfully", "Finished TypeScript", "Generating static pages (13/13)". Full 15-line tail is just the route list end above.
CSS grep of apps/web/.next/static: `--lims-accent:` 1 hit and `.lims-auth-card` 1 hit, both in .next/static/chunks/24njjq4-zk5dl.css.
[CONV] lims-btn-md left to tester exception (default size); lims-description/lims-input-group already covered (test green). 100vh used for page height (no px).
Open: 401 stub stays unstyled (CSP, AC-0D-7.2) — non-blocking CR not written yet; real-browser visual check not done.
