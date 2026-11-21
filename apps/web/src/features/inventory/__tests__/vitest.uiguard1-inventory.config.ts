// T0D-UIGUARD-1-INVENTORY test-only vitest config (tester-owned): only this task's tests. Run via .orchestra/notes/T0D-UIGUARD-1-INVENTORY-verify.cmd
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const web = fileURLToPath(new URL('../../../../', import.meta.url)); // apps/web/

export default defineConfig({
  root: web,
  esbuild: { jsx: 'automatic' },
  resolve: { alias: { '@/': `${web}src/` } },
  test: {
    include: ['src/features/inventory/__tests__/uiguard1.inventory.test.ts', 'src/core/__tests__/uiguard1.guard.test.ts'],
    environment: 'node',
    restoreMocks: true,
    testTimeout: 60000,
    hookTimeout: 30000,
  },
});
