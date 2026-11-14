// C9 nightly E2E config (C9-owned; NOT picked up by the C0 T0D-14 config in tests/web-e2e).
// Run: pnpm --dir apps/web exec playwright test --config tests/e2e/quality/playwright.config.ts
// The T-27 scenarios read E2E_BASE_URL + per-role tokens from the environment (header of C9.T-27.quality.spec.ts).
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.', // relative to this file; `__dirname` is undefined under apps/web's ESM loader
  testMatch: /.*\.spec\.ts/,
  workers: 1,
  timeout: 240_000, // scenarios wait on the worker (QC sync, TAT evaluator) and on C5 hold/verify
  use: { baseURL: process.env.E2E_BASE_URL ?? process.env.LIMS_E2E_WEB_URL ?? 'http://localhost:3100' },
});
