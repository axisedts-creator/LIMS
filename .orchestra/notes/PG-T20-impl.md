# PG-T20 impl (writer)
- services/worker/src/jobs/payments/tasks/sweep_open_intents.ts: sets held_for_review_oldest_age_seconds{tenant_id,kind}, reconciliation_stalled_runs, open_intents_past_deadline{gateway} via optional ctx.metrics; SQL stays in fake dialect, filtering in JS; still read-only.
- services/worker/src/jobs/payments/ops/payments.rules.yml: the 9 TRD §11 alerts. docs/manual/payments/{screens,runbooks}.md: 6 screens, RB-1..RB-9, alert index.
- [CONV] services/api/src/core/observability/metrics.ts (outside the PG-T20 file list): 12 lims_payments_* added to DEFS (closed registry); needed so ctx.metrics.set/inc do not throw.
- Open: core metrics.test.ts:78 now fails until the tester adds the 12 names to EXPECTED (see PG-T20-dispute.md).
- Open: worker JobContext has no `metrics` field (WorkerDeps.metrics only), so the sweep/reconcile gauges are no-ops in production until core passes ctx.metrics (core/CR call).
- Run: observability.test.ts + sweep_gauges.test.ts pass; worker src/jobs/payments 166/166; worker tsc clean for payments files.
