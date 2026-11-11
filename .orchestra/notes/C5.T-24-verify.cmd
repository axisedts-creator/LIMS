cd /d "%~dp0..\.." && set "LIMS_T03_CMD=pnpm --dir services/api exec vitest run --no-file-parallelism src/modules/lab/ports/__tests__" && "C:\Program Files\Git\bin\bash.exe" tests/db/c5-t03/run.sh
