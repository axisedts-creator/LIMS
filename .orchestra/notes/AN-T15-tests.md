# AN-T15 tests (tester)
- API: `services/api/src/modules/analytics/export/__tests__/writers.test.ts` (layout/Csv/Xlsx/PdfRequest + neutraliseFormula import check) and `handlers/__tests__/exports.handler.test.ts` (#20–#23: gates, registry/flag/pdf, quota X16, own-only, download limits X14, access log, headers).
- Worker: `services/worker/src/jobs/analytics/__tests__/build_export.test.ts` (CSV/XLSX/PDF build, requester revalidation X13/X19, scope ∩ (US-15.5), caps, RenderPort mapping, final attempt).
- Helpers: `export/__tests__/{sqlFake,xlsxRead}.ts`, `handlers/__tests__/t15.helpers.ts`, worker `__tests__/buildExportFake.ts` (SQL/seam contracts in their headers; writer may dispute via reviewer).
- Run: `.orchestra\notes\AN-T15-verify.cmd` (api via `pnpm --dir services/api`, worker via `--root services/worker`).
- Now: 85 api tests fail (export/*.ts missing, handlers #20–#23 are stubs -> common.internal); 38 worker tests fail (tasks/build_export.ts missing). Right reason.
- Writer must create: `export/{layout,CsvWriter,XlsxWriter,PdfRequest}.ts` (signatures: writers.test.ts header), `tasks/build_export.ts` (+ register in worker manifest), handlers, service, repo; quota needs a lock (advisory/FOR UPDATE) before count.
- Not covered here (no DB/Fastify in unit layer): real-Postgres RLS/probe tests P7/P9 SQL, HTTP-level Idempotency-Key, `write-excel-file` real-library output (reader is a hand-written zip parser).

Rev (review #2): buildExportFake now models ONE job tx (db.tx reuses ctx, rollback on reject, SAVEPOINT/ROLLBACK TO, 25P02 after SQL error). build_export.test.ts: final attempt must RESOLVE with committed failed/common.internal; +2 SQL-error cases. Expected to fail until impl adds the savepoint (3 tests).
