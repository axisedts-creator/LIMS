// T0D-PRINTCFG-1 test-only vitest config (tester-owned). Run via .orchestra/notes/T0D-PRINTCFG-1-verify.cmd.
// Covers the reporting-side and billing-side printcfg1 suites; shared mocks (next/navigation, server-only, session) come from printcfg1.setup.ts.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const web = fileURLToPath(new URL('../../../../', import.meta.url)); // apps/web/

export default defineConfig({
  root: web,
  esbuild: { jsx: 'automatic' }, // tsconfig has jsx:preserve (Next); vitest needs it compiled
  resolve: { alias: { '@/': `${web}src/` } },
  test: {
    include: ['src/features/reporting/__tests__/printcfg1.*.test.{ts,tsx}', 'src/features/billing/__tests__/printcfg1.*.test.{ts,tsx}'],
    setupFiles: ['src/features/reporting/__tests__/printcfg1.setup.ts'],
    environment: 'node', // component suites opt in with `// @vitest-environment jsdom`
    restoreMocks: true,
    testTimeout: 30000,
  },
});
