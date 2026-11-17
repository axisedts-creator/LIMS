// C10.T-19 compose E2E config (tester-owned). Run: pnpm exec playwright test --config apps/web/tests/e2e/micro/playwright.config.ts
// Needs the compose stack (or Prism over contracts/openapi/micro.yaml + lab.yaml behind the BFF): LIMS_E2E_WEB_URL, LIMS_E2E_STAFF_TOKEN (synthetic technologist session with
// micro.culture.read + lab.specimen.read), LIMS_E2E_MICRO_BARCODE (barcode of a specimen with exactly one open culture), LIMS_E2E_MICRO_CULTURE_ID (that culture's id),
// LIMS_E2E_NO_CULTURE_BARCODE (an existing specimen with no culture), LIMS_E2E_UNKNOWN_BARCODE (a barcode that does not exist).
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: __dirname,
  testMatch: /.*\.spec\.ts/,
  workers: 1,
  timeout: 90_000,
  use: { baseURL: process.env.LIMS_E2E_WEB_URL ?? 'https://localhost:3100', ignoreHTTPSErrors: true },
});
