// T0D-BUILD-1 test-only vitest config (tester-owned). Run via .orchestra/notes/T0D-BUILD-1-verify.cmd (pnpm --dir apps/web run build:nav first: core/nav/generated.ts is gitignored).
// The new build1.* test plus every existing billing web test that runs under the plain setup (done_when 4: the existing billing web tests stay green).
// NOT included on purpose: printcfg1.invoice and misreports1.botd (own configs / other features).
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const web = fileURLToPath(new URL('../../', import.meta.url)); // apps/web/

export default defineConfig({
  root: web,
  esbuild: { jsx: 'automatic' },
  resolve: { alias: { '@/': `${web}src/` } },
  test: {
    include: [
      'src/features/billing/__tests__/build1.*.test.{ts,tsx}',
      'src/features/billing/__tests__/uilist2.*.test.{ts,tsx}',
      'src/features/billing/__tests__/acct1.*.test.{ts,tsx}',
      'src/features/billing/__tests__/acct2.*.test.{ts,tsx}',
      'src/features/billing/__tests__/finctrl1.*.test.{ts,tsx}',
      'src/features/billing/__tests__/bl-t20.*.test.{ts,tsx}',
      'src/features/billing/__tests__/bl-t23.*.test.ts',
      'src/features/billing/__tests__/nav-complete.billing.test.ts',
      'src/features/billing/__tests__/nav.manifest.test.ts',
      'src/features/billing/__tests__/uidash1.billing.test.tsx',
    ],
    environment: 'node', // component files opt in with `// @vitest-environment jsdom`
    restoreMocks: true,
    testTimeout: 60000,
    hookTimeout: 30000,
  },
});
