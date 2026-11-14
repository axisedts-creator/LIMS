// AN-T24 test-only vitest config (tester-owned). Same shape as vitest.an-t20.config.ts; file-system tests only (node env). Run from repo root via .orchestra/notes/AN-T24-verify.cmd.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const web = fileURLToPath(new URL('../../../../', import.meta.url)); // apps/web/

export default defineConfig({
  root: web,
  test: {
    include: ['src/features/analytics/__tests__/an-t24.*.test.{ts,tsx}'],
    environment: 'node',
    restoreMocks: true,
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
