cd /d "%~dp0..\.." && pnpm --dir services/worker exec vitest run src/jobs/partners/__tests__/housekeeping src/jobs/partners/__tests__/manifest
