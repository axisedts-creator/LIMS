// WEB-AUTH-REDIRECT-1 test-only vitest config (tester-owned; same shape as vitest.web-style-1.config.ts).
// Runs web-auth-redirect.test.ts plus the WEB-STYLE-1 / WEB-BUILD-1/2 suites (must stay green).
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const web = fileURLToPath(new URL('../../', import.meta.url)); // apps/web/

export default defineConfig({
  root: web,
  resolve: { alias: { '@/': `${web}src/` } },
  test: {
    include: [
      'src/__tests__/web-auth-redirect.test.ts',
      'src/__tests__/web-style.test.ts',
      'src/__tests__/build-config.test.ts',
      'src/__tests__/build-boundaries.test.ts',
    ],
    environment: 'node',
    testTimeout: 30000,
  },
});
