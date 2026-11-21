// T0D-FINCTRL-1 test-only vitest config (tester-owned). Run: .orchestra/notes/T0D-FINCTRL-1-verify.cmd (from the repo root).
// Runs the new finctrl1.* tests plus EVERY existing billing web test (done_when 8: the billing web suite stays green).
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const web = fileURLToPath(new URL('../../../../', import.meta.url)); // apps/web/

export default defineConfig({
  root: web,
  esbuild: { jsx: 'automatic' },
  resolve: { alias: { '@/': `${web}src/` } },
  test: {
    // acct1/acct2/bl-t20/bl-t23/nav/uidash1 = the existing billing web suite that runs under this setup. NOT included on purpose: printcfg1.invoice (own config, features/reporting
    // printcfg1) and uilist2.* (need the generated nav module, src/core/nav/generated, absent in this checkout: fail before this task).
    include: [
      'src/features/billing/__tests__/finctrl1.*.test.{ts,tsx}',
      'src/features/billing/__tests__/acct1.*.test.{ts,tsx}',
      'src/features/billing/__tests__/acct2.*.test.{ts,tsx}',
      'src/features/billing/__tests__/bl-t20.*.test.{ts,tsx}',
      'src/features/billing/__tests__/bl-t23.*.test.ts',
      'src/features/billing/__tests__/nav-complete.billing.test.ts',
      'src/features/billing/__tests__/nav.manifest.test.ts',
      'src/features/billing/__tests__/uidash1.billing.test.tsx',
    ],
    environment: 'node', // component files opt in with `// @vitest-environment jsdom`
    restoreMocks: true,
    testTimeout: 20000,
  },
});
