// WEB-T02 test-only vitest config (tester-owned; lives under __tests__ so no non-test file is touched).
// Run from repo root:  node_modules\.bin\vitest run --config apps/web/src/features/instruments/__tests__/vitest.web-t02.config.ts
// Needs (writer adds to apps/web/package.json devDependencies): vitest, msw, jsdom, axe-core,
// @testing-library/react, @testing-library/user-event  — same pins as packages/ui / pnpm store.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const web = fileURLToPath(new URL('../../../../', import.meta.url)); // apps/web/

export default defineConfig({
  root: web,
  esbuild: { jsx: 'automatic' }, // tsconfig has jsx:preserve (Next); vitest needs it compiled
  resolve: { alias: { '@/': `${web}src/` } },
  test: {
    include: ['src/features/instruments/__tests__/web-t02.*.test.{ts,tsx}'],
    environment: 'node', // component file opts in with `// @vitest-environment jsdom`
    restoreMocks: true,
    testTimeout: 15000,
  },
});
