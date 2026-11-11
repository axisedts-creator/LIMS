Title: CR-C8-016: register nine lims_analytics_* metrics in core metrics registry
From chunk: C8            To owner: C0
Type: shared-lib
Blocking? yes (AN-T22 done_when "metrics exported"; observability.test.ts API metric cases)
Problem: `ctx.metrics.inc|observe|set` throws "metrics: unknown ..." for any name outside DEFS in `services/api/src/core/observability/metrics.ts` (C0-owned). C8 already calls `lims_analytics_reconciliation_mismatch_total`; TRD §13 lists nine C8 metrics; none is in DEFS. "metrics in services/tasks" does not exist in this repo.
Proposed change (exact): add to DEFS (02-TRD §13 Metrics, labels verbatim):
  lims_analytics_refresh_duration_seconds: histogram [family]
  lims_analytics_refresh_failures_total: counter [family]
  lims_analytics_family_stale: gauge [tenant_id, family]
  lims_analytics_dirty_partitions: gauge [family]
  lims_analytics_reconciliation_mismatch_total: counter [rule, family]
  lims_analytics_exports_total: counter [tenant_id, format, outcome]
  lims_analytics_export_rows: histogram [report_code]
  lims_analytics_export_downloads_total: counter [tenant_id]
  lims_analytics_schedule_sends_total: counter [outcome]
  and the same nine names in `core/observability/__tests__/metrics.test.ts` EXPECTED.
Backward compatible? yes (additive).
Tenant/security impact: none; tenant_id only on the low-cardinality metrics already allowed by TRD §13; no membership/referrer/export id labels.
IRD/regulatory impact: none.
Alternatives considered: separate C8 registry (breaks the single /metrics exposition every service uses).
Tests that will prove it: services/api/src/modules/analytics/__tests__/ops/observability.test.ts.
