// AUTH-ACTOR-2 test-only vitest config (tester-owned). Run from the repo root via .orchestra/notes/AUTH-ACTOR-2-verify.cmd.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const web = fileURLToPath(new URL('../../../../', import.meta.url)); // apps/web/

export default defineConfig({
  root: web,
  resolve: { alias: { '@/': `${web}src/` } },
  test: {
    include: ['src/core/session/__tests__/c2.permissions.test.ts'],
    environment: 'node',
    restoreMocks: true,
    testTimeout: 15000,
  },
});
