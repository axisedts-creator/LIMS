// C11.T-26 nightly config (C11-owned).
// Run: pnpm exec playwright test --config apps/web/src/features/anatomic/__tests__/e2e/playwright.config.ts
// Needs the compose stack (pnpm dev:up) seeded with `pnpm db:seed --scale 1` (or 10 with LIMS_E2E_SCALE=10);
// env: LIMS_E2E_API_URL, LIMS_E2E_TOKEN (pathologist, aal2), LIMS_E2E_HOOKS_URL.
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: __dirname,
  testMatch: /.*\.e2e\.ts/,
  workers: 1,
  timeout: 15 * 60_000,
  use: { extraHTTPHeaders: process.env.LIMS_E2E_TOKEN ? { Authorization: `Bearer ${process.env.LIMS_E2E_TOKEN}` } : {} },
});
