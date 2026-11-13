// C5.T-33 test-only vitest config (tester-owned; same shape as vitest.lab-t30.config.ts).
// Run from repo root via .orchestra/notes/C5.T-33-verify.cmd
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const web = fileURLToPath(new URL('../../../../', import.meta.url)); // apps/web/

export default defineConfig({
  root: web,
  test: {
    include: ['src/features/lab/__tests__/c5-t33.*.test.ts'],
    environment: 'node',
    restoreMocks: true,
    testTimeout: 30000,
  },
});
