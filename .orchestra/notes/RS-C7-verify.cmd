cd /d "%~dp0..\.." && set CI=true&& pnpm --dir apps/web exec vitest run --config src/features/instruments/__tests__/vitest.rs-c7.config.ts
