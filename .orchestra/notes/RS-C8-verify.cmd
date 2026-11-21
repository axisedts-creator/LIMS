cd /d "%~dp0..\.." && set CI=true&& pnpm --dir apps/web exec vitest run --config src/features/analytics/__tests__/vitest.rs-c8.config.ts --pool=threads
