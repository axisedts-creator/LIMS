// T0D-UIREPORT-2 test-only vitest config (tester-owned) for the Bill of the Day screen: the misreports1 harness takes its mocks (next/navigation, server-only,
// session) from catalog/__tests__/testmgmt1.setup.ts. The other uireport2 suites mock them themselves: see vitest.uireport2.config.ts.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const web = fileURLToPath(new URL('../../../../', import.meta.url)); // apps/web/

export default defineConfig({
  root: web,
  esbuild: { jsx: 'automatic' },
  resolve: { alias: { '@/': `${web}src/` } },
  test: {
    include: ['src/features/analytics/__tests__/uireport2.botd.test.tsx'],
    setupFiles: ['src/features/catalog/__tests__/testmgmt1.setup.ts'],
    environment: 'node',
    restoreMocks: true,
    testTimeout: 60000,
    hookTimeout: 30000,
  },
});
