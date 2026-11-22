// T0D-FIX-11 test-only vitest config (tester-owned). Run via .orchestra/notes/T0D-FIX-11-verify.cmd (pnpm --dir apps/web run build:nav first:
// core/nav/generated.ts is gitignored). Each suite mocks next/navigation, server-only and the session itself.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const web = fileURLToPath(new URL('../../', import.meta.url)); // apps/web/

export default defineConfig({
  root: web,
  esbuild: { jsx: 'automatic' },
  resolve: { alias: { '@/': `${web}src/` } },
  test: {
    include: [
      'src/features/billing/__tests__/fix11.billing.test.tsx',
      'src/features/lab/__tests__/fix11.statusboard.test.tsx',
      'src/features/analytics/__tests__/fix11.reports.test.tsx',
      'src/features/analytics/__tests__/fix11.referral.test.tsx',
      // re-pinned per notes/T0D-FIX-11-ruling.md (LD-455)
      'src/features/analytics/__tests__/an-t20.referral.test.tsx',
      'src/features/lab/__tests__/lab-t27.page.test.tsx',
      'src/features/billing/__tests__/uidash1.billing.test.tsx',
      'src/features/billing/__tests__/bl-t20.screens.test.tsx',
    ],
    environment: 'node', // component files opt in with `// @vitest-environment jsdom`
    restoreMocks: true,
    fileParallelism: false, // one worker at a time: the cold import of a page tree is slow and parallel workers time out on start
    testTimeout: 180000,
    hookTimeout: 120000,
    teardownTimeout: 60000,
  },
});
