// T0D-UIGUARD-1-PARTNERS test-only vitest config (tester-owned): only this task's partners source tests. vitest root = apps/web.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const web = fileURLToPath(new URL('../../../../', import.meta.url)); // apps/web/

export default defineConfig({
  root: web,
  esbuild: { jsx: 'automatic' },
  resolve: { alias: { '@/': `${web}src/` } },
  test: { include: ['src/features/partners/__tests__/uiguard1-partners.*.test.{ts,tsx}'], environment: 'node', testTimeout: 60000 },
});
