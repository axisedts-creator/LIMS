# AN-T08 impl (writer)
- New: `repository/rollups.repo.ts` (incomeRows/departmentIncomeRows, bound SQL, allow-listed keys), `service/reports.service.ts` (income/departmentIncome, R2), `mappers/reports.dto.ts`, `handlers/{getIncomeReport,getDepartmentIncomeReport,reportRequest}.ts`; edited `handlers/index.ts` (register 2 ops), `service/context.service.ts` (+`export` on asApiError, reused to rewrap port errors).
- Result: `vitest run src/modules/analytics` 526/526 pass after tester revision per ruling (ad_month windows); no impl change needed.
- [CONV] `freshness: []` until AN-T04's source exists. [CONV] share_bp clamped to 0..1,000,000 (contract Bp), null total -> 0. [CONV] NULL centre under group_by=centre -> key `none`, label "No centre"; unknown dept -> label `Department <last 8 of id>`.
- [CONV] Totals are summed in the service (safe-integer check), not SQL GROUPING SETS; bs_month = day query + metrics.groupByBsMonth. R2 = one extra incomeRows(day) + (only with department_id filter) one unfiltered department query.
- Open: no live-DB/RLS test; handlers import service directly (ctx.services not wired in core yet); tsc --noEmit: no errors in the new files; lint not run.
