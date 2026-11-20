// T0D-MSGDESK-1 test-only vitest config (tester-owned). Run via .orchestra/notes/T0D-MSGDESK-1-verify.cmd.
// Runs the engagement message screens (templates, broadcasts) and the staff ticket inbox (features/partners); mocks in msgdesk1.setup.ts; state lives on globalThis.__TM.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const web = fileURLToPath(new URL('../../../../', import.meta.url)); // apps/web/

export default defineConfig({
  root: web,
  esbuild: { jsx: 'automatic' },
  resolve: { alias: { '@/': `${web}src/` } },
  test: {
    include: ['src/features/engagement/__tests__/msgdesk1.*.test.{ts,tsx}', 'src/features/partners/__tests__/msgdesk1.*.test.{ts,tsx}'],
    setupFiles: ['src/features/engagement/__tests__/msgdesk1.setup.ts'],
    environment: 'node', // the screen suites opt in with `// @vitest-environment jsdom`
    restoreMocks: true,
    testTimeout: 60000,
  },
});
