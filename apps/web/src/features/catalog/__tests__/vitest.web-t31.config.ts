// C3.T-31 test-only vitest config (tester-owned; lives under __tests__ so no non-test file is touched).
// Run from repo root:  node node_modules\vitest\vitest.mjs run --config apps/web/src/features/catalog/__tests__/vitest.web-t31.config.ts
// Needs (writer adds to apps/web/package.json devDependencies; same pins as WEB-T02 / packages/ui): vitest, msw, jsdom, axe-core,
// @testing-library/react, @testing-library/user-event.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const web = fileURLToPath(new URL('../../../../', import.meta.url)); // apps/web/

export default defineConfig({
  root: web,
  esbuild: { jsx: 'automatic' }, // tsconfig has jsx:preserve (Next); vitest needs it compiled
  resolve: { alias: { '@/': `${web}src/` } },
  test: {
    include: ['src/features/catalog/__tests__/web-t31.*.test.{ts,tsx}'],
    environment: 'node', // component file opts in with `// @vitest-environment jsdom`
    restoreMocks: true,
    testTimeout: 60000, // LD-76: keystroke-heavy component tests exceed 15s on this machine
  },
});
