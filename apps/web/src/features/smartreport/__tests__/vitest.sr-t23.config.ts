// C14.T23 test-only vitest config (tester-owned). Same shape as vitest.sr-t21.config.ts. Run from repo root via .orchestra/notes/C14.T23-verify.cmd.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const web = fileURLToPath(new URL('../../../../', import.meta.url)); // apps/web/

export default defineConfig({
  root: web,
  test: {
    include: ['src/features/smartreport/__tests__/sr-t23.*.test.ts'],
    environment: 'node',
    testTimeout: 20000,
  },
});
