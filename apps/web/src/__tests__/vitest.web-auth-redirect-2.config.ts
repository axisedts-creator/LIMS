// WEB-AUTH-REDIRECT-2 test-only vitest config (tester-owned): unit + real-server tests, plus the suites that must stay green.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const web = fileURLToPath(new URL('../../', import.meta.url)); // apps/web/

export default defineConfig({
  root: web,
  resolve: { alias: { '@/': `${web}src/` } },
  test: {
    include: [
      'src/__tests__/web-auth-redirect.test.ts',
      'src/__tests__/web-auth-redirect-server.test.ts',
      'src/__tests__/web-style.test.ts',
      'src/__tests__/build-config.test.ts',
      'src/__tests__/build-boundaries.test.ts',
    ],
    environment: 'node',
    testTimeout: 60000,
    hookTimeout: 900000,
    fileParallelism: false, // the real-server file builds .next; keep files serial
  },
});
