// C17 nightly E2E config (tester-owned, HC-T30). Run on the compose stack:
//   pnpm exec playwright test --config apps/web/src/features/homecollection/tests/e2e/playwright.config.ts
// Env (all synthetic, see HC-T30.nightly.spec.ts header): LIMS_E2E_API_URL, LIMS_E2E_STAFF_TOKEN, LIMS_E2E_RECEIVER_TOKEN, LIMS_E2E_DEVICE_TOKEN, LIMS_E2E_DEVICE_ID,
// LIMS_E2E_BOOKING_VISIT_ID, LIMS_E2E_PHLEBO_MEMBERSHIP_ID, LIMS_E2E_RECEIVING_CENTRE_ID.
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: __dirname,
  testMatch: /.*\.spec\.ts/,
  workers: 1,
  timeout: 180_000,
  use: { baseURL: process.env.LIMS_E2E_WEB_URL ?? 'https://localhost:3100', ignoreHTTPSErrors: true },
});
