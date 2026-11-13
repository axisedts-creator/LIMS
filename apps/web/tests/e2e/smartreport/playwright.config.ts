// C14 nightly E2E config (C14-owned; NOT picked up by the C0 T0D-14 config in tests/web-e2e).
// Run: pnpm exec playwright test --config apps/web/tests/e2e/smartreport/playwright.config.ts
// Needs a running staff web + stub C2 + stubbed /v1/smartreport origin (see SR-T19.review.spec.ts NEEDS); set LIMS_E2E_WEB_URL.
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';

// Ruling C14.T24-ruling.md: apps/web is "type": "module", so __dirname is undefined.
const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  testDir: here,
  testMatch: /.*\.spec\.ts/,
  workers: 1,
  timeout: 60_000,
  use: { baseURL: process.env.LIMS_E2E_WEB_URL ?? 'http://localhost:3100' },
});
