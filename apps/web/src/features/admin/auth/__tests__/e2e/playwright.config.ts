// T0D-MSERIES-5 Playwright config (tester-owned). See m5-entry.e2e.ts for how to run; needs LIMS_E2E_WEB_URL.
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: __dirname,
  testMatch: /.*\.e2e\.ts/,
  workers: 1,
  timeout: 60_000,
});
