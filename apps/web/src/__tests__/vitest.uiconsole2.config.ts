// T0D-UICONSOLE-2 test-only vitest config (tester-owned; same shape as vitest.uiconsole1.config.ts). Run via .orchestra/notes/T0D-UICONSOLE-2-verify.cmd
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const web = fileURLToPath(new URL('../../', import.meta.url)); // apps/web/

export default defineConfig({
  root: web,
  esbuild: { jsx: 'automatic' },
  resolve: { alias: { '@/': `${web}src/` } },
  test: {
    // + the two older queue tests whose queries moved to the console markup (review items 2): c5-t21.queues, verlevel1.queues
    include: ['src/features/lab/__tests__/uiconsole2.*.test.tsx', 'src/features/lab/__tests__/c5-t21.queues.test.tsx', 'src/features/lab/__tests__/verlevel1.queues.test.tsx'],
    environment: 'node', // component files opt in with `// @vitest-environment jsdom`
    restoreMocks: true,
    testTimeout: 30000,
  },
});
