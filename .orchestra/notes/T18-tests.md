# T18 tests (tester)
Files (services/api/src/modules/identity/__tests__/): audit-view.helpers.ts (fake tx, not a test), audit-view.service.test.ts, audit-view.handlers.test.ts, audit-view.static.test.ts.
Run: `.orchestra\notes\T18-verify.cmd` (vitest, only these). Expected now: all fail on missing ../service|repository|handlers modules.
Covers US-D1/D2/D3, D-T3 (access-log failure fails the detail), P-3 tenant probes, C-1 centre-scoped admin (list, filter, detail->not_found), 31-day rule, keyset paging with ties, perf 1x vs 10x (constant statements, <=limit+1 rows read, no OFFSET).
ASSUMED API (file headers): createAuditViewService({}) -> listAuditEntries(ctx,query) / getAuditEntry(ctx,{auditId}) / listAccessLogEntries / listAuthEvents; handlers/<opId>.ts export `<opId>`; ctx = {tenantId, requestId, actor, centreScope:{all,centreIds}, tx, audit:{access}}.
Fake tx reads SQL content: plain `col = $n`, `occurred_at >=/</BETWEEN`, keyset `(occurred_at,id) < ($a,$b)` or OR-form, `centre_id IS NULL ... ANY($n)` clause, ORDER BY/LIMIT; write SQL in those forms. Access log is observed via ctx.audit.access OR INSERT INTO audit.access_log on ctx.tx.
Contract choice: getAuditEntry old_values/new_values are JSON TEXT (identity.yaml header note), not objects (TRD says objects). Detail of an out-of-scope/other-tenant entry -> common.not_found, no view logged.
Not covered: live Postgres/RLS (db/tests/isolation/audit.*.sql exist), real EXPLAIN plans at 10x, HTTP pipeline (identity manifest not built yet), a centre `all` flag passed as SQL param is not verified.
