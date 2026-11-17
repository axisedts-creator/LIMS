// C3.T-32 test-only vitest config (tester-owned; same shape as instruments/__tests__/vitest.web-t02.config.ts).
// Run from repo root:  node node_modules\vitest\vitest.mjs run --config apps/web/src/features/catalog/__tests__/vitest.web-t32.config.ts
// Needs (writer adds to apps/web/package.json devDependencies, same pins as packages/ui): vitest, msw, jsdom, axe-core,
// @testing-library/react, @testing-library/user-event.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const web = fileURLToPath(new URL('../../../../', import.meta.url)); // apps/web/

export default defineConfig({
  root: web,
  esbuild: { jsx: 'automatic' },
  resolve: { alias: { '@/': `${web}src/` } },
  test: {
    include: ['src/features/catalog/__tests__/web-t32.*.test.{ts,tsx}'],
    environment: 'node', // component file opts in with `// @vitest-environment jsdom`
    restoreMocks: true,
    testTimeout: 15000,
    env: { TZ: 'Asia/Kathmandu' }, // 04-UI-UX / 03-APP-FLOW §5 example "effective 06/11/2026 00:00" = 2026-11-05T18:15Z in Nepal time
  },
});
