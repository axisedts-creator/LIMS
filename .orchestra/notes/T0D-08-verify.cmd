cd /d "%~dp0..\.." && pnpm --dir services/api exec vitest run src/core/events/__tests__ src/core/core-repo/__tests__ src/core/audit/__tests__
