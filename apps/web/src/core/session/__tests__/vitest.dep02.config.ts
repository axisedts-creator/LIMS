// T0D-DEP-02 test-only vitest config (tester-owned). Run from repo root via .orchestra/notes/T0D-DEP-02-verify.cmd.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const web = fileURLToPath(new URL('../../../../', import.meta.url)); // apps/web/

export default defineConfig({
  root: web,
  resolve: { alias: { '@/': `${web}src/` } },
  test: {
    include: ['src/core/session/__tests__/bff-key.test.ts'],
    environment: 'node',
    restoreMocks: true,
    testTimeout: 15000,
  },
});
