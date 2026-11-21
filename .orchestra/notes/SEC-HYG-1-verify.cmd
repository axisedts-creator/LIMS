@cd /d "%~dp0..\.." && node --test tests/security/sec-hyg1.test.mjs && pnpm --dir apps/web exec vitest run --config src/__tests__/vitest.sec-hyg1.config.ts
