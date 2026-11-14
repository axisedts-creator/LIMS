// C12.T-25 test-only vitest config (tester-owned). Same shape as vitest.t20.config.ts. Run from repo root via .orchestra/notes/C12.T-25-verify.cmd.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const web = fileURLToPath(new URL('../../../../', import.meta.url)); // apps/web/

export default defineConfig({
  root: web,
  test: {
    include: ['src/features/inventory/__tests__/t25.*.test.{ts,tsx}'],
    environment: 'node',
    restoreMocks: true,
    testTimeout: 20000,
  },
});
