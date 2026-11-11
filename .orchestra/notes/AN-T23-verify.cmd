cd /d "%~dp0..\.." && pnpm --dir services/api exec vitest run src/modules/analytics/__tests__/perf --testTimeout=120000 --hookTimeout=120000
