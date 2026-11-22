// T0D-UIX-1 test-only vitest config (tester-owned): only this task's look test (jsdom for Element.matches).
// Run: pnpm --dir apps/web exec vitest run -c src/core/__tests__/vitest.uix1.config.ts --maxWorkers=1
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const web = fileURLToPath(new URL('../../../', import.meta.url)); // apps/web/

export default defineConfig({
  root: web,
  esbuild: { jsx: 'automatic' },
  resolve: { alias: { '@/': `${web}src/` } },
  test: {
    include: ['src/core/__tests__/uix1.*.test.{ts,tsx}'],
    environment: 'jsdom',
    restoreMocks: true,
    testTimeout: 60000,
    hookTimeout: 30000,
  },
});
