APPROVE

Reviewed `d7eaa890..HEAD` (AN-T08) against 02-TRD §5 #2/#3, §5.1, §5.2, §6, §6.1, §6.2, §11 metrics; PRD §8.2 M10–M22, US-03.1/.3–.6, US-04.1–.3, R2.
- Names verbatim: operationIds, routes, `analytics.dashboard.read`, group_by enums, `IncomeRow`/`DepartmentIncomeReport` fields, `reconciles_with_income`, `lims_analytics_reconciliation_mismatch_total{rule,family}`, log `reconciliation_mismatch`, error codes (`common.validation_failed` + `common.field_invalid`, `common.not_found`) all match spec. No "commission"/`net_billed_paisa`.
- Tenant/scope: every SQL bound `tenant_id = $1`, `[from,to)`, scope predicate verbatim from §6; group keys from closed allow-list; empty restricted scope returns nothing; foreign/unknown department ids → 404 without echo. No migration in this task (RLS n/a).
- assertRole before any read; GET, idempotency none; rate tier lives in OpenAPI (unchanged). Logs carry ids/dates/aggregate paisa only (no PHI); no secrets. Paths: analytics module + own notes only.
- R2 judged over all departments even with filter; mismatch increments metric + warn log, response still returned.
- Tests: `vitest run src/modules/analytics` → 14 files, 526/526 pass (reviewer run). Cover R2, negative day, group_by incl. bs_month, 2^53 guard, scope probes, 403-before-read, contract schemas.

Non-blocking notes (not defects): totals summed in service with safe-integer guard instead of SQL `GROUPING SETS` (§6.1) — same exact result; `department_id` relies on router delivering an array (a bare string would fail closed with 404). No live-DB/RLS test (out of scope here).
