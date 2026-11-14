cd /d "%~dp0..\.." && set CI=true&& pnpm --dir apps/web exec vitest run --config src/features/payments/__tests__/vitest.rs-c15.config.ts
