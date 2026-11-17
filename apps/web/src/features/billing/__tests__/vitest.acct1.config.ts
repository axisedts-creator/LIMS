// T0D-ACCT-1 test-only vitest config (tester-owned). Run: .orchestra/notes/T0D-ACCT-1-verify.cmd (from the repo root).
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const web = fileURLToPath(new URL('../../../../', import.meta.url)); // apps/web/

export default defineConfig({
  root: web,
  esbuild: { jsx: 'automatic' },
  resolve: { alias: { '@/': `${web}src/` } },
  test: {
    include: [
      'src/features/billing/__tests__/acct1.*.test.{ts,tsx}',
      'src/features/billing/__tests__/nav-complete.billing.test.ts',
      'src/features/billing/__tests__/nav.manifest.test.ts',
      'src/features/billing/__tests__/bl-t20.*.test.{ts,tsx}',
      'src/features/billing/__tests__/bl-t23.*.test.ts',
    ],
    environment: 'node', // component file opts in with `// @vitest-environment jsdom`
    restoreMocks: true,
    testTimeout: 20000,
  },
});
