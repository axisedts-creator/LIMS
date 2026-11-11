cd /d "%~dp0..\.." && pnpm --dir services/api exec vitest run --no-file-parallelism src/modules/catalog/__tests__/perf
