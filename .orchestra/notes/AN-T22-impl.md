# AN-T22 impl (writer)
- `services/api/src/core/observability/metrics.ts`: +9 `lims_analytics_*` DEFS entries, name/type/labels verbatim from TRD §13 l.846-854 [LD-88 / CR-C8-016]. Nothing else in core/observability touched.
- `services/worker/src/jobs/analytics/ops/analytics.rules.yml`: 5 rules, expr/for verbatim TRD §13, no severity/team (C1 adds) [CONV].
- `service/refresh.service.ts`: per-range duration histogram, failures counter, `analytics_refresh_run|failed` logs (SQLSTATE only); telemetry never fails a refresh.
- `tasks/build_export.ts`: `export_build_failed` -> `analytics_export_failed`, + `analytics_export_built`, `exports_total`, `export_rows`; removed non-TRD `export_failed_total`.
- Tests: API ops + metrics.test.ts 43/43 pass; worker observability 5/5 pass (2 static-scan tests hit the default 5s timeout on a loaded machine, pass with `--testTimeout=60000`; test files not edited).
- Open: nothing sets `family_stale` / `dirty_partitions` / `export_downloads_total` / `schedule_sends_total` (no producer in TRD §9); `reports.service.ts` mismatch log uses camelCase non-TRD fields (untouched). Stale `.orchestra/cr/AN-T22.md` BLOCKED note is superseded by LD-88.
