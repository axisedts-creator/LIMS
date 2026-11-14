cd /d "%~dp0..\.." && pnpm --dir services/worker exec vitest run src/jobs/engagement/__tests__/patient_events.test.ts
