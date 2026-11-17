import { defineConfig } from '@playwright/test';
import { join } from 'node:path';

const here = __dirname; // root package.json has no "type":"module" -> Playwright loads this config as CJS
const PORTAL = 'http://localhost:3201';
const API = 'http://127.0.0.1:4127';

// C6-T42: apps/portal dues payment against a stub of the reporting API with a fake gateway (stub-reporting-pay.mjs). Own ports, so it never clashes with the C6-T30/T37 run (:3200/:4126).
// The spec file is named *.e2e.ts on purpose: the T30 config matches /.*\.spec\.ts/ and must not pick it up.
export default defineConfig({
  testDir: here,
  testMatch: /C6-T42\.pay\.e2e\.ts/,
  workers: 1,
  timeout: 120_000,
  use: { baseURL: PORTAL },
  webServer: [
    { command: `node "${join(here, 'stub-reporting-pay.mjs')}"`, url: `${API}/__health`, reuseExistingServer: false, timeout: 20_000 },
    {
      command: 'pnpm --filter @lims/portal exec next dev -p 3201',
      url: PORTAL,
      reuseExistingServer: false,
      timeout: 180_000,
      env: {
        LIMS_CORE_ENV: 'staging',
        LIMS_ORIGIN_API: API,
        LIMS_ORIGIN_PORTAL: PORTAL,
        LIMS_PORTAL_BFF_KEY_FILE: join(here, 'fixtures', 'bff-key.txt'),
      },
    },
  ],
});
