// HC-T30 test-only vitest config (tester-owned). Same shape as vitest.hc-t20.config.ts. Run from repo root via .orchestra/notes/HC-T30-verify.cmd.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const web = fileURLToPath(new URL('../../../../', import.meta.url)); // apps/web/

export default defineConfig({
  root: web,
  resolve: { alias: { '@/': `${web}src/` } },
  test: {
    include: ['src/features/homecollection/__tests__/hc-t30.*.test.ts'],
    environment: 'node',
    restoreMocks: true,
    testTimeout: 20000,
  },
});
