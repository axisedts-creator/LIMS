// C13.T16 compose E2E config (tester-owned). Run: pnpm exec playwright test --config apps/web/tests/e2e/partners/playwright.config.ts
// Needs the compose stack (or Prism over contracts/openapi/partners.yaml behind the BFF): LIMS_E2E_WEB_URL, LIMS_E2E_API_URL, LIMS_E2E_STAFF_TOKEN (synthetic staff JWT with
// partners.manifest.receive + partners.partner.read/manage + frontdesk.patient.read, aal2), LIMS_E2E_MANIFEST_ID (a submitted manifest of >= 2 lines whose partner sample refs are
// LIMS_E2E_REF_1 and LIMS_E2E_REF_2, at the staff user's centre).
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: __dirname,
  testMatch: /.*\.spec\.ts/,
  workers: 1,
  timeout: 90_000,
  use: { baseURL: process.env.LIMS_E2E_WEB_URL ?? 'https://localhost:3100', ignoreHTTPSErrors: true },
});
