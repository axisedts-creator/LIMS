// C13.T19 compose E2E config (tester-owned). Run: pnpm exec playwright test --config apps/partner/tests/e2e/playwright.config.ts
// Needs the compose stack (or Prism over contracts/openapi/partners.yaml behind the partner BFF): LIMS_E2E_PARTNER_URL (default https://localhost:3200) and
// LIMS_E2E_PARTNER_SESSION = the opaque value of a synthetic partner_admin session cookie (__Host-lims_psid), aal2, partner with >= 1 priced orderable and one active referrer.
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: __dirname,
  testMatch: /.*\.spec\.ts/,
  workers: 1,
  timeout: 90_000,
  use: { baseURL: process.env.LIMS_E2E_PARTNER_URL ?? 'https://localhost:3200', ignoreHTTPSErrors: true },
});
