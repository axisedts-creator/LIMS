# AN-T22 impl (writer)
- NEW `services/worker/src/jobs/analytics/ops/analytics.rules.yml`: 5 rules, expr/for verbatim from TRD §13, no severity/team (C1 adds) [CONV].
- `service/refresh.service.ts`: per-range telemetry (duration histogram, failures counter, `analytics_refresh_run|failed` logs, SQLSTATE only); RefreshCtx gains optional log/metrics/attempt; telemetry wrapped so it never fails a refresh.
- `tasks/build_export.ts`: `export_build_failed` -> `analytics_export_failed` (TRD fields), + `analytics_export_built`, `lims_analytics_exports_total{tenant_id,format,outcome}`, `export_rows`; removed non-TRD `lims_analytics_export_failed_total`.
- BLOCKED: 9 metrics must be added to C0-owned `core/observability/metrics.ts` DEFS (+ its test EXPECTED). Not edited (not C8-owned) -> `.orchestra/cr/AN-T22.md`. Until merged, API ops test: 11 fail (unknown metric); 14 pass. Worker suite: 426 pass.
- Open: nothing sets `family_stale` / `dirty_partitions` / `export_downloads_total`; `reports.service.ts` mismatch log uses camelCase non-TRD fields (not touched); no live `inc` works until CR merges (runtime throws on unknown name, caught by telemetry guard in refresh/export only).
