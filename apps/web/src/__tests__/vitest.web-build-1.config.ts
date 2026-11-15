// WEB-BUILD-1 test-only vitest config (tester-owned; same shape as the lab / WEB-T05 configs).
// Run from repo root via .orchestra/notes/WEB-BUILD-1-verify.cmd
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const web = fileURLToPath(new URL('../../', import.meta.url)); // apps/web/

export default defineConfig({
  root: web,
  resolve: { alias: { '@/': `${web}src/` } },
  test: {
    include: ['src/__tests__/build-boundaries.test.ts'],
    environment: 'node',
    testTimeout: 30000,
  },
});
