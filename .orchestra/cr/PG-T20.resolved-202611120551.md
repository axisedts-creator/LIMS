Title: CR-C15-T20-001: register twelve lims_payments_* metrics in core metrics registry
From chunk: C15            To owner: C0-0D
Type: shared-lib
Blocking? yes (PG-T20 done_when "TRD §11 metric list exists"; payments observability.test.ts REQUIRED_METRICS + 12 per-metric cases; core metrics.test.ts:78 "REQUIRED_METRICS lists exactly the spec names")
Problem: `ctx.metrics.inc|observe|set` throws for any name outside DEFS in `services/api/src/core/observability/metrics.ts` (C0-0D-owned, 01-CHUNK-MAP §3 line 123). None of the 12 metrics of C15 02-TRD §11 (line 548) is registered, so the sweep/reconcile/callback paths cannot record them (DoD-3.7/3.8; 08 A22.4). Same situation and same fix as CR-C8-016 (LD-88), CR-C5-T31-001, CR-C14-T17-001.
Proposed change (exact): add to DEFS (02-TRD §11 Metrics, labels verbatim):
  lims_payments_intents_created_total: counter [gateway]
  lims_payments_intents_transitions_total: counter [gateway, to_status]
  lims_payments_intents_held_total: counter [gateway, reason]
  lims_payments_gateway_requests_total: counter [gateway, operation, outcome]
  lims_payments_gateway_request_duration_seconds: histogram [gateway, operation]
  lims_payments_callbacks_total: counter [gateway, kind, outcome]
  lims_payments_open_intents_past_deadline: gauge [gateway]
  lims_payments_reconciliation_findings_total: counter [kind, severity]
  lims_payments_reconciliation_last_success_timestamp_seconds: gauge [tenant_id]
  lims_payments_refunds_total: counter [gateway, mode, status]
  lims_payments_held_for_review_oldest_age_seconds: gauge [tenant_id, kind]   (08 A22.4)
  lims_payments_reconciliation_stalled_runs: gauge [tenant_id]                (08 A22.4)
  and the same twelve names/types in `services/api/src/core/observability/__tests__/metrics.test.ts` EXPECTED (comment: "C15 additions — CR-C15-T20-001, names+types verbatim from C15 02-TRD §11 line 548").
Backward compatible? yes (additive).
Tenant/security impact: none; tenant_id only on the three gauges TRD §11 lists; no intent/refund/patient/amount/token labels.
IRD/regulatory impact: none.
Alternatives considered: separate C15 registry (breaks the single /metrics exposition every service uses).
Tests that will prove it: services/api/src/modules/payments/__tests__/unit/observability.test.ts; core metrics.test.ts (with EXPECTED updated).
