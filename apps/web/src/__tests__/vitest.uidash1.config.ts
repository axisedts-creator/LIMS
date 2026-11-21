// T0D-UIDASH-1 test-only vitest config (tester-owned; same shape as vitest.an-t18.config.ts). Run via .orchestra/notes/T0D-UIDASH-1-verify.cmd
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const web = fileURLToPath(new URL('../../', import.meta.url)); // apps/web/

export default defineConfig({
  root: web,
  esbuild: { jsx: 'automatic' },
  resolve: { alias: { '@/': `${web}src/` } },
  test: {
    include: [
      'src/features/analytics/__tests__/uidash1.*.test.tsx',
      'src/features/analytics/__tests__/unslop1.dashboard.test.tsx',
      'src/features/lab/__tests__/uidash1.*.test.tsx',
      'src/features/lab/__tests__/lab-t27.board.test.tsx',
      'src/features/billing/__tests__/uidash1.*.test.tsx',
      'src/features/quality/__tests__/uidash1.*.test.tsx',
    ],
    environment: 'node', // component files opt in with `// @vitest-environment jsdom`
    restoreMocks: true,
    testTimeout: 15000,
  },
});
