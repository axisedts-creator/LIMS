// C5 nightly E2E config (C5-owned; NOT picked up by the C0 T0D-14 config in tests/web-e2e).
// Run: pnpm exec playwright test --config apps/web/tests/e2e/lab/playwright.config.ts
// LD-134: the T-34 journeys read E2E_BASE_URL + per-role tokens from the environment (see ./README.md); the other specs here keep LIMS_E2E_WEB_URL.
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.', // relative to this file; `__dirname` is undefined under apps/web's ESM loader
  testMatch: /.*\.spec\.ts/,
  workers: 1,
  timeout: 60_000,
  use: { baseURL: process.env.E2E_BASE_URL ?? process.env.LIMS_E2E_WEB_URL ?? 'http://localhost:3100' },
});
