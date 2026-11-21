// T0D-UIGUARD-1-REPORTING test-only vitest config (tester-owned): only this task's tests. Run via .orchestra/notes/T0D-UIGUARD-1-REPORTING-verify.cmd
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const web = fileURLToPath(new URL('../../../../', import.meta.url)); // apps/web/

export default defineConfig({
  root: web,
  esbuild: { jsx: 'automatic' },
  resolve: { alias: { '@/': `${web}src/` } },
  test: {
    include: [
      'src/features/reporting/__tests__/uiguard1.reporting.test.ts',
      'src/features/reporting/__tests__/uiguard1.reporting.render.test.tsx',
      'src/features/reporting/__tests__/uilist1.reporting.test.tsx', // its tab bar pin changed to the Tabs look
      'src/core/__tests__/uiguard1.guard.test.ts',
    ],
    environment: 'node',
    restoreMocks: true,
    testTimeout: 60000,
    hookTimeout: 30000,
  },
});
