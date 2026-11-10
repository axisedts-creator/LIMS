cd /d "%~dp0..\.." && pnpm --dir services/api exec vitest run src/modules/analytics/__tests__/probes --testTimeout=120000 --hookTimeout=120000
