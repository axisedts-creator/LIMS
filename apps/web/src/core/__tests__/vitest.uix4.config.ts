// T0D-UIX-4 test-only vitest config (tester-owned): runs only the uix4 markup grep. Run via .orchestra/notes/T0D-UIX-4-verify.cmd
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const web = fileURLToPath(new URL('../../../', import.meta.url)); // apps/web/

export default defineConfig({
  root: web,
  esbuild: { jsx: 'automatic' },
  resolve: { alias: { '@/': `${web}src/` } },
  test: { include: ['src/core/__tests__/uix4.*.test.{ts,tsx}'], environment: 'node', testTimeout: 60000 },
});
