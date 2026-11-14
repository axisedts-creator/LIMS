// WEB-BUILD-2 test-only vitest config (tester-owned; same shape as vitest.web-build-1.config.ts).
// Runs build-config.test.ts plus the WEB-BUILD-1 guard (must stay green). Run via .orchestra/notes/WEB-BUILD-2-verify.cmd
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const web = fileURLToPath(new URL('../../', import.meta.url)); // apps/web/

export default defineConfig({
  root: web,
  resolve: { alias: { '@/': `${web}src/` } },
  test: {
    include: ['src/__tests__/build-config.test.ts', 'src/__tests__/build-boundaries.test.ts'],
    environment: 'node',
    testTimeout: 30000,
  },
});
