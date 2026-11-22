// T0D-FIX-12 test-only vitest config (tester-owned). Run from the repo root via .orchestra/notes/T0D-FIX-12-verify.cmd.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const web = fileURLToPath(new URL('../../', import.meta.url)); // apps/web/

export default defineConfig({
  root: web,
  esbuild: { jsx: 'automatic' },
  resolve: { alias: { '@/': `${web}src/` } },
  test: {
    include: ['src/__tests__/fix12.burst.test.ts', 'src/core/session/__tests__/fix12.c2-429.test.ts'],
    environment: 'node',
    restoreMocks: true,
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
