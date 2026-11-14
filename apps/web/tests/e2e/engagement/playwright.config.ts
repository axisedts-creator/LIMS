// C16 compose E2E config (C16-owned). Run: pnpm exec playwright test --config apps/web/tests/e2e/engagement/playwright.config.ts
// Needs the compose stack: LIMS_E2E_WEB_URL (staff web, https), LIMS_E2E_API_URL, LIMS_E2E_STAFF_TOKEN (synthetic staff JWT with engagement.queue.manage),
// LIMS_E2E_CENTRE_ID, LIMS_E2E_QUEUE_ID.
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: __dirname,
  testMatch: /.*\.spec\.ts/,
  workers: 1,
  timeout: 90_000,
  use: { baseURL: process.env.LIMS_E2E_WEB_URL ?? 'https://localhost:3100', ignoreHTTPSErrors: true },
});
