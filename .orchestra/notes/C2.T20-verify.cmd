cd /d "%~dp0..\.." && pnpm --dir apps/web run build:nav && node node_modules\vitest\vitest.mjs run --config apps/web/src/features/admin/__tests__/vitest.t20.config.ts
