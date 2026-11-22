// T0D-UIX-2 test-only vitest config (tester-owned). Run via .orchestra/notes/T0D-UIX-2-verify.cmd.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const web = fileURLToPath(new URL('../../../../', import.meta.url)); // apps/web/

export default defineConfig({
  root: web,
  esbuild: { jsx: 'automatic' },
  resolve: { alias: { '@/': `${web}src/` } },
  test: {
    include: ['src/features/catalog/__tests__/uix2.*.test.{ts,tsx}'],
    environment: 'node',
    restoreMocks: true,
    testTimeout: 60000,
  },
});
