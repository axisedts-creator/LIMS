// T0D-CONTENT-1 test-only vitest config (tester-owned). Run: .orchestra/notes/T0D-CONTENT-1-verify.cmd (from the repo root).
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const web = fileURLToPath(new URL('../../../../', import.meta.url)); // apps/web/

export default defineConfig({
  root: web,
  esbuild: { jsx: 'automatic' },
  resolve: { alias: { '@/': `${web}src/` } },
  test: {
    include: [
      'src/features/engagement/__tests__/content1.*.test.{ts,tsx}',
      'src/features/engagement/__tests__/nav-complete.engagement.test.ts',
    ],
    environment: 'node', // component file opts in with `// @vitest-environment jsdom`
    restoreMocks: true,
    testTimeout: 20000,
  },
});
