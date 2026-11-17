# AN-T02 impl (writer)
- Files: `services/api/src/modules/analytics/domain/{period,scope,freshness,metrics,csv,families,reportRegistry}.ts`. No test files touched. Run: `.orchestra\notes\AN-T02-verify.cmd` → 7 files / 182 tests pass. `tsc --noEmit`: only error is pre-existing `shared-ts/bsdate/index.ts(2,48) TS5097`; none in analytics. No eslint installed, not run.
- [CONV] shared-ts imported by relative path (no alias yet, as billing/catalog). csv.ts imports `neutraliseFormula` from `.../spreadsheet/index.js`, no local guard.
- [CONV] period: `BsDateError` mapped to `LimsError` (`viaBs`) so no 500; last valid FY label = 2098/99 (end Shrawan 1 of 2100 is outside table); `businessDateOf` uses fixed UTC+05:45 and requires a `Z`/offset suffix.
- [CONV] metrics: ratios via BigInt, half away from zero; `delta.percentBp` divides by `|previous|`; `groupByBsMonth` throws on non-safe-integer sums.
- [CONV] reportRegistry `exportColumns` are NOT pinned by spec (names taken from OpenAPI row schemas where they exist: income, department_income, collections, tat, referral_incentive; the rest are my choice). Only `referral_incentive` has `net_billed_paisa`; `pending_tests` has no identifiers.
- Open: confirm `exportColumns` with AN export task (build_export) before it consumes them; `ReportDef.code`/`liveSources` etc. typed as plain `string` (no `ReportCode` union).
