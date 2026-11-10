REM C3 T-02
cd /d "%~dp0..\.." && pnpm --filter @lims/api exec vitest run src/modules/catalog/domain/__tests__ || exit /b 1
