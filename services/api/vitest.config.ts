// LD-53 (2), T0D-01: this vitest config edit is authorised by lead decision LD-53. The test-only setup
// (src/__tests__/setup-env.ts) supplies ci env defaults, applied only when unset, so the real modules directory boots.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['./src/__tests__/setup-env.ts'],
  },
});
