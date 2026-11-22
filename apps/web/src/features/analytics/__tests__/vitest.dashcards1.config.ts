// T0D-DASHCARDS-1 test-only vitest config (tester-owned): the new dashboard tests plus the existing dashboard tests that must stay green.
// Run via .orchestra/notes/T0D-DASHCARDS-1-verify.cmd (pnpm --dir apps/web run build:nav first: core/nav/generated.ts is gitignored). vitest root = apps/web.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const web = fileURLToPath(new URL('../../../../', import.meta.url)); // apps/web/

export default defineConfig({
  root: web,
  esbuild: { jsx: 'automatic' },
  resolve: { alias: { '@/': `${web}src/` } },
  test: {
    include: [
      'src/features/analytics/__tests__/dashcards1.*.test.{ts,tsx}',
      'src/features/analytics/__tests__/uidash1.dashboard.test.tsx',
      'src/features/analytics/__tests__/uidash2.*.test.tsx',
      'src/features/analytics/__tests__/unslop1.dashboard.test.tsx',
      'src/features/analytics/__tests__/rs-c8.dashboard.test.tsx',
      'src/features/analytics/__tests__/rs-c8.screens.test.tsx',
    ],
    environment: 'node', // component files opt in with `// @vitest-environment jsdom`
    restoreMocks: true,
    testTimeout: 60000,
    hookTimeout: 30000,
  },
});
