# Payment gateways runbook (`payments`)

Owner C15. One section per alert in `monitoring/rules/payments.rules.yml` (anchors = lower-case alert names, 02-TRD s11.3; template 04-UI-UX s4.2).
Prometheus and Grafana are reached only through ops nginx on wg0. Dashboard: D15 Modules / Payment gateways.

## PaymentsAmountMismatch
Severity: page   Owner: C15   Last tested: never (new in T-21)
**Means:** A payment was held or reconciled with an amount mismatch.  **Impact:** the Payment gateways module's users or the on-call see degraded behaviour until fixed.
**Check first:** Prometheus query `sum(increase(lims_payments_intents_held_total{reason="amount_mismatch"}[15m])) > 0 or sum(increase(lims_payments_reconciliation_findings_total{kind="amount_mismatch"}[15m])) > 0` (expect: empty when healthy); Grafana D15-payments panel for the metric.
**Fix:** 1. Read the module's error logs in VictoriaLogs around the alert start (no PHI is logged). 2. If the cause is an outside dependency, follow its runbook; if it is module code, hand off to the owner. 3. Confirm the expression returns empty after the fix.
**Escalate when:** not resolved within 30 min, or the cause is in module code → the C15 owner via the LIMS provider on-call.
**Close-out:** `ops-note.sh` line with alert name, tenant id (UUID only) if any, cause and action; incident record for any page longer than 30 min.

## PaymentsCriticalFinding
Severity: page   Owner: C15   Last tested: never (new in T-21)
**Means:** Reconciliation found a critical payments finding.  **Impact:** the Payment gateways module's users or the on-call see degraded behaviour until fixed.
**Check first:** Prometheus query `sum by (kind) (increase(lims_payments_reconciliation_findings_total{kind=~"ledger_entry_missing|late_payment_found|gateway_refund_unrecorded|status_divergence"}[15m])) > 0 or sum(increase(lims_payments_intents_held_total{reason="late_payment_found"}[15m])) > 0` (expect: empty when healthy); Grafana D15-payments panel for the metric.
**Fix:** 1. Read the module's error logs in VictoriaLogs around the alert start (no PHI is logged). 2. If the cause is an outside dependency, follow its runbook; if it is module code, hand off to the owner. 3. Confirm the expression returns empty after the fix.
**Escalate when:** not resolved within 30 min, or the cause is in module code → the C15 owner via the LIMS provider on-call.
**Close-out:** `ops-note.sh` line with alert name, tenant id (UUID only) if any, cause and action; incident record for any page longer than 30 min.

## PaymentsReconciliationMissing
Severity: page   Owner: C15   Last tested: never (new in T-21)
**Means:** Payments reconciliation has not succeeded for a tenant in 26 h.  **Impact:** the Payment gateways module's users or the on-call see degraded behaviour until fixed.
**Check first:** Prometheus query `time() - max by (tenant_id) (lims_payments_reconciliation_last_success_timestamp_seconds) > 93600` (expect: empty when healthy); Grafana D15-payments panel for the metric.
**Fix:** 1. Check the job's last runs in VictoriaLogs (module logs, last 2 h). 2. If the worker is down or the queue is stuck, follow `runtime.md#workerdown` / `runtime.md#queuebacklog`. 3. Re-run the job once the cause is fixed; confirm the gauge falls.
**Escalate when:** not resolved within 30 min, or the cause is in module code → the C15 owner via the LIMS provider on-call.
**Close-out:** `ops-note.sh` line with alert name, tenant id (UUID only) if any, cause and action; incident record for any page longer than 30 min.

## PaymentsReconciliationStalled
Severity: warn   Owner: C15   Last tested: never (new in T-21)
**Means:** A payments reconciliation run is stalled.  **Impact:** the Payment gateways module's users or the on-call see degraded behaviour until fixed.
**Check first:** Prometheus query `max by (tenant_id) (lims_payments_reconciliation_stalled_runs) > 0` (expect: empty when healthy); Grafana D15-payments panel for the metric.
**Fix:** 1. Read the module's error logs in VictoriaLogs around the alert start (no PHI is logged). 2. If the cause is an outside dependency, follow its runbook; if it is module code, hand off to the owner. 3. Confirm the expression returns empty after the fix.
**Escalate when:** still firing after one working day → the C15 owner.
**Close-out:** `ops-note.sh` line with alert name, tenant id (UUID only) if any, cause and action; incident record for any page longer than 30 min.

## PaymentsHeldForReviewStale
Severity: warn   Owner: C15   Last tested: never (new in T-21)
**Means:** A payment held for review is older than 24 h.  **Impact:** the Payment gateways module's users or the on-call see degraded behaviour until fixed.
**Check first:** Prometheus query `max by (tenant_id, kind) (lims_payments_held_for_review_oldest_age_seconds) > 86400` (expect: empty when healthy); Grafana D15-payments panel for the metric.
**Fix:** 1. Check the job's last runs in VictoriaLogs (module logs, last 2 h). 2. If the worker is down or the queue is stuck, follow `runtime.md#workerdown` / `runtime.md#queuebacklog`. 3. Re-run the job once the cause is fixed; confirm the gauge falls.
**Escalate when:** still firing after one working day → the C15 owner.
**Close-out:** `ops-note.sh` line with alert name, tenant id (UUID only) if any, cause and action; incident record for any page longer than 30 min.

## PaymentsCallbackSignatureInvalid
Severity: warn   Owner: C15   Last tested: never (new in T-21)
**Means:** A gateway callback failed signature verification.  **Impact:** the Payment gateways module's users or the on-call see degraded behaviour until fixed.
**Check first:** Prometheus query `sum by (gateway) (increase(lims_payments_callbacks_total{outcome="payments.signature_invalid"}[15m])) > 0` (expect: empty when healthy); Grafana D15-payments panel for the metric.
**Fix:** 1. Read the module's error logs in VictoriaLogs around the alert start (no PHI is logged). 2. If the cause is an outside dependency, follow its runbook; if it is module code, hand off to the owner. 3. Confirm the expression returns empty after the fix.
**Escalate when:** still firing after one working day → the C15 owner.
**Close-out:** `ops-note.sh` line with alert name, tenant id (UUID only) if any, cause and action; incident record for any page longer than 30 min.

## PaymentsGatewayErrorRatio
Severity: warn   Owner: C15   Last tested: never (new in T-21)
**Means:** More than 20 % of calls to one gateway failing for 10 min.  **Impact:** the Payment gateways module's users or the on-call see degraded behaviour until fixed.
**Check first:** Prometheus query `sum by (gateway) (rate(lims_payments_gateway_requests_total{outcome=~"service_unavailable|timeout|network_error|http_error|invalid_response|auth_error"}[10m])) / sum by (gateway) (rate(lims_payments_gateway_requests_total[10m])) > 0.2` (expect: empty when healthy); Grafana D15-payments panel for the metric.
**Fix:** 1. Read the module's error logs in VictoriaLogs around the alert start (no PHI is logged). 2. If the cause is an outside dependency, follow its runbook; if it is module code, hand off to the owner. 3. Confirm the expression returns empty after the fix.
**Escalate when:** still firing after one working day → the C15 owner.
**Close-out:** `ops-note.sh` line with alert name, tenant id (UUID only) if any, cause and action; incident record for any page longer than 30 min.

## PaymentsCredentialRejected
Severity: warn   Owner: C15   Last tested: never (new in T-21)
**Means:** A gateway rejected the tenant's credentials (auth_error).  **Impact:** the Payment gateways module's users or the on-call see degraded behaviour until fixed.
**Check first:** Prometheus query `sum by (gateway) (increase(lims_payments_gateway_requests_total{outcome="auth_error"}[15m])) > 0` (expect: empty when healthy); Grafana D15-payments panel for the metric.
**Fix:** 1. Read the module's error logs in VictoriaLogs around the alert start (no PHI is logged). 2. If the cause is an outside dependency, follow its runbook; if it is module code, hand off to the owner. 3. Confirm the expression returns empty after the fix.
**Escalate when:** still firing after one working day → the C15 owner.
**Close-out:** `ops-note.sh` line with alert name, tenant id (UUID only) if any, cause and action; incident record for any page longer than 30 min.

## PaymentsOpenIntentsPastDeadline
Severity: warn   Owner: C15   Last tested: never (new in T-21)
**Means:** Open payment intents past deadline + 30 min.  **Impact:** the Payment gateways module's users or the on-call see degraded behaviour until fixed.
**Check first:** Prometheus query `max by (gateway) (lims_payments_open_intents_past_deadline) > 0` (expect: empty when healthy); Grafana D15-payments panel for the metric.
**Fix:** 1. Read the module's error logs in VictoriaLogs around the alert start (no PHI is logged). 2. If the cause is an outside dependency, follow its runbook; if it is module code, hand off to the owner. 3. Confirm the expression returns empty after the fix.
**Escalate when:** still firing after one working day → the C15 owner.
**Close-out:** `ops-note.sh` line with alert name, tenant id (UUID only) if any, cause and action; incident record for any page longer than 30 min.
