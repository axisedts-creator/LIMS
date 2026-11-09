import { defineConfig } from '@playwright/test';
import { join } from 'node:path';

const here = __dirname; // root package.json has no "type":"module" -> Playwright loads this config as CJS
const PORTAL = 'http://localhost:3200';
const API = 'http://127.0.0.1:4126';

// C6-T30: apps/portal against a stub of the reporting API (stub-reporting.mjs). Synthetic data only.
export default defineConfig({
  testDir: here,
  testMatch: /.*\.spec\.ts/,
  workers: 1,
  timeout: 60_000,
  use: { baseURL: PORTAL },
  webServer: [
    { command: `node "${join(here, 'stub-reporting.mjs')}"`, url: `${API}/__health`, reuseExistingServer: false, timeout: 20_000 },
    {
      command: 'pnpm --filter @lims/portal exec next dev -p 3200',
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
