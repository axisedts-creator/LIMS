cd /d "%~dp0..\.." && pnpm --dir services/api exec vitest run src/core/__tests__/idempotency.test.ts
