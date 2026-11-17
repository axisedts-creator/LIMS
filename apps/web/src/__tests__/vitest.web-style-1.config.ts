// WEB-STYLE-1 test-only vitest config (tester-owned; same shape as vitest.web-build-2.config.ts).
// Runs web-style.test.ts plus the WEB-BUILD-1/2 suites (must stay green). Run via .orchestra/notes/WEB-STYLE-1-verify.cmd
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const web = fileURLToPath(new URL('../../', import.meta.url)); // apps/web/

export default defineConfig({
  root: web,
  resolve: { alias: { '@/': `${web}src/` } },
  test: {
    include: ['src/__tests__/web-style.test.ts', 'src/__tests__/build-config.test.ts', 'src/__tests__/build-boundaries.test.ts'],
    environment: 'node',
    testTimeout: 30000,
  },
});
