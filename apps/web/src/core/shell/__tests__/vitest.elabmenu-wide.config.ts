// T0D-ELABMENU-1 wide sweep (tester-owned): the shell, nav, app and the analytics, catalog, frontdesk, lab, admin and billing web tests (the brief's list).
//   pnpm --dir apps/web exec vitest run --config src/core/shell/__tests__/vitest.elabmenu-wide.config.ts
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const web = fileURLToPath(new URL('../../../../', import.meta.url)); // apps/web/
const ext = '*.test.{ts,tsx}';

export default defineConfig({
  root: web,
  esbuild: { jsx: 'automatic' },
  resolve: { alias: { '@/': `${web}src/` } },
  test: {
    include: [
      `src/core/shell/__tests__/${ext}`, `src/core/nav/__tests__/${ext}`, `src/app/__tests__/${ext}`,
      ...['analytics', 'catalog', 'frontdesk', 'lab', 'admin', 'billing'].map((f) => `src/features/${f}/**/__tests__/${ext}`),
    ],
    environment: 'node', // component files opt in with `// @vitest-environment jsdom`
    restoreMocks: true,
    testTimeout: 60000,
    hookTimeout: 30000,
  },
});
