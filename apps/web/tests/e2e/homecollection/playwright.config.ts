// C17 compose E2E config (tester-owned, HC-T18). Run: pnpm exec playwright test --config apps/web/tests/e2e/homecollection/playwright.config.ts
// Needs the compose stack (or Prism over contracts/openapi/homecollection.yaml behind the BFF): LIMS_E2E_WEB_URL, LIMS_E2E_API_URL, LIMS_E2E_STAFF_TOKEN
// (synthetic dispatcher JWT with homecollection.visit.read/assign + lab.specimen.label_print), LIMS_E2E_CENTRE_ID, LIMS_E2E_VISIT_ID (an unassigned booking visit with
// no address/window), LIMS_E2E_PHLEBO_ID (membership id of "Test Phlebo 01", eligible at that centre).
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: __dirname,
  testMatch: /.*\.spec\.ts/,
  workers: 1,
  timeout: 90_000,
  use: { baseURL: process.env.LIMS_E2E_WEB_URL ?? 'https://localhost:3100', ignoreHTTPSErrors: true },
});
