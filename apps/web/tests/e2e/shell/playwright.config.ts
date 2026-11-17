// T0D-UI-R04 nightly E2E config (C0-owned). Run: pnpm exec playwright test --config apps/web/tests/e2e/shell/playwright.config.ts
// Needs a running staff web + stubbed API origin (see T0D-UI-R04.shell.spec.ts header); set LIMS_E2E_WEB_URL.
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: __dirname,
  testMatch: /.*\.spec\.ts/,
  workers: 1,
  timeout: 60_000,
  use: { baseURL: process.env.LIMS_E2E_WEB_URL ?? 'http://localhost:3100' },
});
