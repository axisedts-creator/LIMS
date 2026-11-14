cd /d "%~dp0..\.." && pnpm --dir services/api exec vitest run src/modules/anatomic/__tests__/report-content.test.ts src/modules/anatomic/__tests__/report.signout.handlers.test.ts
