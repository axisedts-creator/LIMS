cd /d "%~dp0..\.." && pnpm --dir services/api exec vitest run src/modules/engagement/service/__tests__/queue.handlers.test.ts
