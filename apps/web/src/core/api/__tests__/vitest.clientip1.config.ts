// T0A-CLIENTIP-1 test-only vitest config (tester-owned). Run from the repo root via .orchestra/notes/T0A-CLIENTIP-1-verify.cmd.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const web = fileURLToPath(new URL('../../../../', import.meta.url)); // apps/web/

export default defineConfig({
  root: web,
  resolve: { alias: { '@/': `${web}src/` } },
  test: {
    include: [
      'src/core/api/__tests__/client-context.test.ts',
      'src/core/api/__tests__/server-fetch.test.ts',
      'src/core/session/__tests__/c2.client-context.test.ts',
      'src/features/admin/auth/__tests__/t12.client-context.test.ts',
      'src/core/api/__tests__/abuse1.single-helper.static.test.ts', // SEC-ABUSE-1
    ],
    environment: 'node',
    restoreMocks: true,
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
