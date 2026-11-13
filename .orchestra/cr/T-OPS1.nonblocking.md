Title: CR-C16-T-OPS1: register the 13 lims_engagement_* metrics in core/observability/metrics.ts DEFS
From chunk: C16            To owner: C0-0B (observability registry)
Type: shared-lib
Blocking? no for the code in services/api/src/modules/engagement/metrics.ts (best-effort emitters, no-op without a sink); yes for 15 of 32 tests in modules/engagement/__tests__/ops.metrics.test.ts ("core registry" group).
Problem: 02-TRD §13 names 13 lims_engagement_* metrics; /metrics only exposes names in DEFS (createMetrics throws `metrics: unknown counter <name>`). core/observability/metrics.ts and its EXPECTED map test are C0 paths (precedent: LD-88, LD-120 for lab/smartreport).
Proposed change (exact): add to DEFS [kind, labels, help], copied from services/api/src/modules/engagement/metrics.ts ENGAGEMENT_METRICS (TRD §13):
  otp_requests_total counter [outcome]; otp_verifications_total counter [outcome]; link_events_total counter [method,outcome]; projection_lag_seconds histogram [event_type];
  projection_drift_total counter [table]; bookings_total counter [kind,outcome]; slot_conflicts_total counter []; queue_tokens_total counter [event]; queue_wait_seconds histogram [];
  displays_stale gauge []; payment_requests_total counter [gateway,outcome]; reminders_total counter [kind,outcome]; report_downloads_total counter [outcome]  (all prefixed lims_engagement_).
  Add the same 13 rows to core/observability/__tests__/metrics.test.ts EXPECTED.
Backward compatible? yes (additive).
Tenant/security impact: none; labels are codes only (02-CV §9.2), no id/phone/name/token.
Alternatives considered: none; alerts in alerts/engagement.rules.yml use `by (tenant_id)`, which needs C1 to attach tenant_id at scrape/import (open point).
Tests that will prove it: ops.metrics.test.ts "core registry" group (15 tests) + the C0 EXPECTED map test.
