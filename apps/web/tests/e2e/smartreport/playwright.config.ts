// C14 nightly E2E config (C14-owned; NOT picked up by the C0 T0D-14 config in tests/web-e2e).
// Run: pnpm exec playwright test --config apps/web/tests/e2e/smartreport/playwright.config.ts
// Needs a running staff web + stub C2 + stubbed /v1/smartreport origin (see SR-T19.review.spec.ts NEEDS); set LIMS_E2E_WEB_URL.
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: __dirname,
  testMatch: /.*\.spec\.ts/,
  workers: 1,
  timeout: 60_000,
  use: { baseURL: process.env.LIMS_E2E_WEB_URL ?? 'http://localhost:3100' },
});
