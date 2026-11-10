REM C3 T-03
cd /d "%~dp0..\.." && pnpm --filter @lims/api exec vitest run src/modules/catalog/__tests__/integration || exit /b 1
