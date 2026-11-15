# WEB-STYLE-1 tests (tester)
Files: apps/web/src/__tests__/web-style.test.ts, vitest.web-style-1.config.ts, fixtures/shell.baseline.css (copy of shell.css before the change; "new CSS" = lines not in it).
Run: .orchestra/notes/WEB-STYLE-1-verify.cmd (also runs build-config + build-boundaries; static, no build, no network).
Now: 8 fail for the right reasons (no tokens.css import / lims-root, no tokens guard, lims-auth-card + lims-wordmark + lims-checklist have no rule, no new CSS, no (auth)/auth/page.tsx, stub href is /auth/); 49 pass (planted-failure fixtures + WEB-BUILD suites).
Planted fixtures: layout order/body class, tokens guard, class coverage (exception list), hex/px/rgb, stub href + CSS-free stub.
Exception (1 of max 3): lims-btn-md, default button size, kit.css has only -sm (packages/ui untouched). lims-checklist needs a real rule in shell.css.
No existing test asserted the old stub href (/auth/), so no assertion was changed.
Not tested: real rendering (needs the build + grep step in the impl note, LD-198 (e)).
