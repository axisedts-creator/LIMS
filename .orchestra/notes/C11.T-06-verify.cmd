cd /d "%~dp0..\.." && pnpm --dir services/api exec vitest run src/modules/anatomic/__tests__/accession.service.test.ts src/modules/anatomic/__tests__/integration/numbering.live.test.ts
