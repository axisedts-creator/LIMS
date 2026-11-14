cd /d "%~dp0..\.." && set CI=true&& pnpm --dir apps/web exec vitest run --config src/features/frontdesk/__tests__/vitest.rs-c4.config.ts --pool=threads
