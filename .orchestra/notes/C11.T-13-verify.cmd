cd /d "%~dp0..\.." && pnpm --dir services/api exec vitest run src/modules/anatomic/__tests__/report.draft.handlers.test.ts src/modules/anatomic/__tests__/integration/report.draft.live.test.ts
