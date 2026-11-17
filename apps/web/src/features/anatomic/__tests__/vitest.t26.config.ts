// C11.T-26 test-only vitest config (tester-owned). Same shape as vitest.t25.config.ts. Run from repo root via .orchestra/notes/C11.T-26-verify.cmd.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const web = fileURLToPath(new URL('../../../../', import.meta.url)); // apps/web/

export default defineConfig({
  root: web,
  test: {
    include: ['src/features/anatomic/__tests__/t26.*.test.ts'],
    environment: 'node',
    restoreMocks: true,
    testTimeout: 15000,
  },
});
