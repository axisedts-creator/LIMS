# PG-T20 impl (writer)
- services/worker/src/jobs/payments/tasks/sweep_open_intents.ts: sets held_for_review_oldest_age_seconds{tenant_id,kind}, reconciliation_stalled_runs, open_intents_past_deadline{gateway} via optional ctx.metrics; SQL stays in fake dialect, filtering in JS; still read-only.
- services/worker/src/jobs/payments/ops/payments.rules.yml: the 9 TRD §11 alerts. docs/manual/payments/{screens,runbooks}.md: 6 screens, RB-1..RB-9, alert index.
- [CONV] services/api/src/core/observability/metrics.ts: 12 lims_payments_* in DEFS, names/labels verbatim from TRD §11; authorized by LD-127 (2026-11-12). Tester added the 12 to core metrics.test.ts EXPECTED. .orchestra/cr/PG-T20.md is superseded by LD-127.
- Open: worker JobContext has no `metrics` field (WorkerDeps.metrics only), so sweep/reconcile gauges are no-ops in production until core passes ctx.metrics (core/CR call).
- Review fix: metrics.ts C15 block comment now cites LD-127 2026-11-12 (comment only).
- Run: core metrics.test.ts + observability.test.ts 51/51 pass; worker src/jobs/payments 166/166 pass (incl. sweep_gauges).
