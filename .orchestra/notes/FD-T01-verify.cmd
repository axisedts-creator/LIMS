cd /d "%~dp0..\.." && pnpm --dir services/api exec vitest run src/modules/frontdesk/__tests__ && node --test tests/frontdesk/FD-T01.paths.test.mjs
