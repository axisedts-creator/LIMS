cd /d "%~dp0..\.." && node --test tests/portal-e2e/C6-T30.static.test.mjs && pnpm --filter @lims/portal exec playwright test -c ../../tests/portal-e2e/playwright.config.ts
