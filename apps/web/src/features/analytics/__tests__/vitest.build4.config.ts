// T0D-BUILD-4 test-only vitest config (tester-owned): the misreports1 harness takes its mocks (next/navigation, server-only, session) from catalog/__tests__/testmgmt1.setup.ts.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const web = fileURLToPath(new URL('../../../../', import.meta.url)); // apps/web/

export default defineConfig({
  root: web,
  esbuild: { jsx: 'automatic' },
  resolve: { alias: { '@/': `${web}src/` } },
  test: {
    include: ['src/features/analytics/__tests__/build4.*.test.{ts,tsx}'],
    setupFiles: ['src/features/catalog/__tests__/testmgmt1.setup.ts'],
    environment: 'node',
    restoreMocks: true,
    testTimeout: 60000,
    hookTimeout: 30000,
  },
});
