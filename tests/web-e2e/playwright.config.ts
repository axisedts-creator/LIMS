import { defineConfig } from '@playwright/test';
import { join } from 'node:path';

const here = __dirname; // root package.json has no "type":"module" -> Playwright loads this config as CJS
const WEB = 'http://localhost:3100';
const C2 = 'http://127.0.0.1:4100';

export default defineConfig({
  testDir: here,
  testMatch: /.*\.spec\.ts/,
  workers: 1,
  timeout: 60_000,
  use: { baseURL: WEB },
  webServer: [
    { command: `node "${join(here, 'stub-c2.mjs')}"`, url: `${C2}/__health`, reuseExistingServer: false, timeout: 20_000 },
    {
      // staging path: the BFF must call C2 resolveSession (dev in-memory store refuses to load in staging/production)
      command: 'pnpm --filter @lims/web run build:nav && pnpm --filter @lims/web exec next dev -p 3100',
      url: WEB,
      reuseExistingServer: false,
      timeout: 180_000,
      env: {
        LIMS_CORE_ENV: 'staging',
        LIMS_ORIGIN_API: C2,
        LIMS_ORIGIN_STAFF_WEB: WEB,
        LIMS_WEB_BFF_KEY_FILE: join(here, 'fixtures', 'bff-key.txt'),
        LIMS_WEB_FEATURES_DIR: join(here, 'fixtures', 'features-ok'),
      },
    },
  ],
});
