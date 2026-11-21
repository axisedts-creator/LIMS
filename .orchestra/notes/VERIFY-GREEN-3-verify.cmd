@cd /d "%~dp0..\.." && pnpm --dir services/api exec vitest run src/modules/frontdesk/__tests__/ci src/modules/billing/__tests__/contract
