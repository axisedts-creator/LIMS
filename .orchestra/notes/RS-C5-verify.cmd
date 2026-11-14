cd /d "%~dp0..\.." && set CI=true&& pnpm --dir apps/web exec vitest run --config src/features/lab/__tests__/vitest.rs-c5.config.ts
