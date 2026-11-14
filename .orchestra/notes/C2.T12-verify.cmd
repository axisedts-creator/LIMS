cd /d "%~dp0..\.." && pnpm --dir apps/web run build:nav && node node_modules\vitest\vitest.mjs run --config apps/web/src/features/admin/auth/__tests__/vitest.t12.config.ts
