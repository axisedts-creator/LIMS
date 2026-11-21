// T0D-UIREPORT-2 test-only vitest config (tester-owned). Run via .orchestra/notes/T0D-UIREPORT-2-verify.cmd (pnpm --dir apps/web run build:nav first:
// core/nav/generated.ts is gitignored). These suites mock next/navigation, server-only and the session themselves (an-t19 / an-t20 harnesses).
// The Bill of the Day suite needs the misreports1 setup file: vitest.uireport2.mis.config.ts.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const web = fileURLToPath(new URL('../../../../', import.meta.url)); // apps/web/

export default defineConfig({
  root: web,
  esbuild: { jsx: 'automatic' },
  resolve: { alias: { '@/': `${web}src/` } },
  test: {
    include: ['src/features/analytics/__tests__/uireport2.reports.test.tsx', 'src/features/analytics/__tests__/uireport2.referral.test.tsx', 'src/features/analytics/__tests__/uireport2.static.test.ts'],
    environment: 'node', // component files opt in with `// @vitest-environment jsdom`
    restoreMocks: true,
    testTimeout: 60000,
    hookTimeout: 30000,
  },
});
