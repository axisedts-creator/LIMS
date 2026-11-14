cd /d "%~dp0..\.." && pnpm --filter @lims/api exec vitest run src/modules/catalog/__tests__/integration/imports.test.ts src/modules/catalog/__tests__/probes/imports.probes.test.ts || exit /b 1
