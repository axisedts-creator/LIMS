// H80-T06 nightly E2E config (tester-owned). Run: pnpm exec playwright test --config apps/web/tests/e2e/instruments/playwright.config.ts
// Needs the compose stack with the truth_h80e driver row (H80-T05 / CR-C7-020, status generic): LIMS_E2E_WEB_URL (staff web) and
// LIMS_E2E_STAFF_SID (synthetic session id for a user with instruments.instrument.read + instruments.instrument.manage).
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: __dirname,
  testMatch: /.*\.spec\.ts/,
  workers: 1,
  timeout: 60_000,
  use: { baseURL: process.env.LIMS_E2E_WEB_URL ?? 'https://localhost:3100', ignoreHTTPSErrors: true },
});
