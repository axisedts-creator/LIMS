// C11.T-25 test-only vitest config (tester-owned). Same shape as vitest.t23.config.ts. Run from repo root via .orchestra/notes/C11.T-25-verify.cmd.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const web = fileURLToPath(new URL('../../../../', import.meta.url)); // apps/web/

export default defineConfig({
  root: web,
  esbuild: { jsx: 'automatic' },
  resolve: { alias: { '@/': `${web}src/` } },
  test: {
    include: ['src/features/anatomic/__tests__/t25.*.test.{ts,tsx}'],
    environment: 'node',
    restoreMocks: true,
    testTimeout: 15000,
  },
});
