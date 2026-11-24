// Multi-Agent Web Verification Playwright Configuration
// Verifies full LIMS lifecycle, multi-tenant boundaries, and UI security through apps/web.
// Run: pnpm --dir apps/web exec playwright test --config tests/e2e/workflow-loops/playwright.config.ts
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './specs',
  testMatch: /.*\.spec\.ts/,
  workers: 1,
  timeout: 60_000,
  retries: 0,
  use: {
    baseURL: process.env.E2E_BASE_URL ?? process.env.LIMS_E2E_WEB_URL ?? 'http://localhost:3000',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        browserName: 'chromium',
        viewport: { width: 1280, height: 720 },
      },
    },
  ],
});
