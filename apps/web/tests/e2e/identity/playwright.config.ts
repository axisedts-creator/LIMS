// C2.T12 nightly E2E config (C2-owned). Run: pnpm exec playwright test --config apps/web/tests/e2e/identity/playwright.config.ts
// Needs a running staff web + a stubbed /v1/identity/auth/* origin (see C2.T12.auth.spec.ts header); set LIMS_E2E_WEB_URL.
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: __dirname,
  testMatch: /.*\.spec\.ts/,
  workers: 1,
  timeout: 60_000,
  use: { baseURL: process.env.LIMS_E2E_WEB_URL ?? 'http://localhost:3100' },
});
