// CR TENANT-LOGO-1 test-only vitest config. Run (after `pnpm --dir apps/web run build:nav`):
//   pnpm --dir apps/web exec vitest run --config src/features/platform/__tests__/vitest.tenantlogo1.config.ts
// Runs this change's tenantlogo1.* files AND the platform (t26, provision1) and shell (m2, r04, elabmenu1, density) files it touches.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const web = fileURLToPath(new URL('../../../../', import.meta.url)); // apps/web/

export default defineConfig({
  root: web,
  esbuild: { jsx: 'automatic' },
  resolve: { alias: { '@/': `${web}src/` } },
  test: {
    include: [
      'src/features/platform/__tests__/{tenantlogo1,provision1,t26}.*.test.{ts,tsx}',
      'src/core/shell/__tests__/{tenantlogo1,m2,r04,elabmenu1,density}.*.test.{ts,tsx}',
      'src/app/__tests__/favicon1.*.test.ts',
    ],
    environment: 'node', // component files opt in with `// @vitest-environment jsdom`
    restoreMocks: true,
    testTimeout: 60000,
    hookTimeout: 30000,
  },
});
