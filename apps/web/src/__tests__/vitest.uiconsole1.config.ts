// T0D-UICONSOLE-1 test-only vitest config (tester-owned; same shape as vitest.uidash1.config.ts). Run via .orchestra/notes/T0D-UICONSOLE-1-verify.cmd
// Includes the new uiconsole1.* tests and the old tests of the five screens that were updated for the console markup (never loosened).
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const web = fileURLToPath(new URL('../../', import.meta.url)); // apps/web/

export default defineConfig({
  root: web,
  esbuild: { jsx: 'automatic' },
  resolve: { alias: { '@/': `${web}src/` } },
  test: {
    include: [
      'src/features/lab/__tests__/uiconsole1.*.test.tsx',
      'src/features/lab/__tests__/adminpage-lab-1.critical-values.test.tsx',
      'src/features/lab/__tests__/c5-t23.exceptions.test.tsx',
      'src/features/payments/__tests__/uiconsole1.*.test.tsx',
      'src/features/payments/__tests__/pg-t18.review.test.tsx',
      'src/features/payments/__tests__/pg-t19.refunds.test.tsx',
      'src/features/inventory/__tests__/uiconsole1.*.test.tsx',
      'src/features/inventory/__tests__/t24.unresolved.test.tsx',
    ],
    environment: 'node', // component files opt in with `// @vitest-environment jsdom`
    restoreMocks: true,
    testTimeout: 30000,
  },
});
