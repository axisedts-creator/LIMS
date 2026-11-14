// C16.T-Q4 test-only vitest config (tester-owned). Same shape as features/smartreport/__tests__/vitest.sr-t29.config.ts.
// Run: pnpm --dir apps/web exec vitest run -c src/features/engagement/__tests__/vitest.t-q4.config.ts
// TokenSlip (CR-C16-016, C0-0D kit) is not in @lims/ui yet: while packages/ui/src/components/TokenSlip is missing, the alias below maps
// `@lims/ui/components/TokenSlip` to the tester stub so component tests can run. The source test (t-q4.source.test.ts) separately requires the
// real kit import, so it stays red until the kit ships it. Once the kit has TokenSlip the alias is not applied (real component is used).
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const web = fileURLToPath(new URL('../../../../', import.meta.url)); // apps/web/
const kit = fileURLToPath(new URL('../../../../../../packages/ui/src/components/TokenSlip', import.meta.url));
const stub = fileURLToPath(new URL('./t-q4.token-slip.stub.tsx', import.meta.url));
const alias: Record<string, string> = { '@/': `${web}src/` };
if (!existsSync(kit)) alias['@lims/ui/components/TokenSlip'] = stub;

export default defineConfig({
  root: web,
  esbuild: { jsx: 'automatic' },
  resolve: { alias },
  test: {
    include: ['src/features/engagement/__tests__/t-q4.*.test.{ts,tsx}'],
    environment: 'node', // component files opt in with `// @vitest-environment jsdom`
    restoreMocks: true,
    testTimeout: 20000,
  },
});
