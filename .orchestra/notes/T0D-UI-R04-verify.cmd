cd /d "%~dp0..\.." && pnpm --dir apps/web run build:nav && pnpm --dir apps/web exec vitest run --config src/core/shell/__tests__/vitest.r04.config.ts --pool=threads
