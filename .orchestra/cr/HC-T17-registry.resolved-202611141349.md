Title: CR-C17-HC-T17-REG: register the 8 lims_homecollection_* metrics in core/observability/metrics.ts DEFS
From chunk: C17
To owner: C0-0B (observability registry)
Type: shared-lib
Blocking? no for the code in services/api/src/modules/homecollection/metrics.ts (best-effort emitters, swallowed until registered); yes for HC-T17 tests: observability.test.ts "metrics registry" group and the metric assertions of logscan.live.test.ts.
Problem: 02-TRD §14 names 8 lims_homecollection_* metrics; /metrics only exposes names in DEFS (createMetrics throws `metrics: unknown <kind> <name>`). core/observability/metrics.ts and its EXPECTED map test are C0 paths (precedent: LD-88 analytics, LD-120 lab, LD-142 engagement, LD-147 identity).
Proposed change (exact): add to DEFS [kind, labels, help], copied from services/api/src/modules/homecollection/metrics.ts HOMECOLLECTION_METRICS (TRD §14):
  lims_homecollection_mutations_total counter [type, outcome]; lims_homecollection_push_duration_seconds histogram []; lims_homecollection_snapshot_duration_seconds histogram [changed];
  lims_homecollection_held_open gauge [tenant_id]; lims_homecollection_clock_skew_seconds histogram [clock_source]; lims_homecollection_devices_stale_total gauge [tenant_id];
  lims_homecollection_handover_overdue_open gauge [tenant_id]; lims_homecollection_events_published_total counter [].
  Add the same 8 rows to core/observability/__tests__/metrics.test.ts EXPECTED. Open point: C1 attaches tenant_id at scrape/import for `max by (tenant_id)` only if the gauges' own tenant_id label is not enough (it is set by the module).
Backward compatible? yes (additive).
Tenant/security impact: none; labels are codes only (02-CV §9.2), tenant_id only on the three gauges, no visit / device / patient / barcode / name / phone / GPS label.
Alternatives considered: a private registry in the module (rejected by observability.test.ts: one /metrics, one registry).
Tests that will prove it: observability.test.ts (registry group, 8 types/labels, PHI-label rejection), logscan.live.test.ts (push pipeline metrics), and the C0 EXPECTED map test.
Resolution: APPROVED by LD-162 (2026-11-14). Eight DEFS rows added to core/observability/metrics.ts and eight EXPECTED rows to its metrics.test.ts; nothing else changed.
