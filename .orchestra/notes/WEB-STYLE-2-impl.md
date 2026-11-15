# WEB-STYLE-2 impl (writer)
Files: apps/web/src/app/(auth)/layout.tsx (page > lims-auth-main {children} + aria-hidden lims-auth-panel: title + ol of 7 pipeline words), apps/web/src/core/shell/shell.css (new rules, tokens/rem/% only). No auth page or form component edited (2 files total).
[CONV] LD-201: layout idea only, no Watermelon code/dep; no img/URL/inline style; no social/remember-me/sign-up. LD-140 held.
[CONV] Panel hidden by default (display:none), shown at min-width 64rem; page 2 cols (1fr 1fr) from 64rem, below it one centred column (WEB-STYLE-1 card unchanged). From 64rem the card inside the white form column drops border/background (one container level).
Tests: vitest.web-style-2.config.ts: 4 files, 82/82 pass (web-style-2, web-style, build-config, build-boundaries).
Build: `pnpm --filter @lims/web build` exits 0 (Compiled, TypeScript finished, 13/13 static pages). Built CSS apps/web/.next/static/chunks/029uropm6onma.css contains lims-auth-panel/main/steps.
Open: lime dot per step is decorative only (no "current" marker); real rendering not viewed in a browser.
