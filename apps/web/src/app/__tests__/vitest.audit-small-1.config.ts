// AUDIT-SMALL-1 test-only vitest config (tester-owned). Run from the repo root via .orchestra/notes/AUDIT-SMALL-1-verify.cmd.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const web = fileURLToPath(new URL('../../../', import.meta.url)); // apps/web/

export default defineConfig({
  root: web,
  resolve: { alias: { '@/': `${web}src/` } },
  test: {
    include: ['src/app/__tests__/root-page.audit-small-1.test.ts'],
    environment: 'node',
    restoreMocks: true,
    testTimeout: 15000,
  },
});
