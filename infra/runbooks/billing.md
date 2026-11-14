# Billing runbook (`billing`)

Owner C4. One section per alert in `monitoring/rules/imported/billing.rules.yml` (anchors = lower-case alert names, 02-TRD s11.3; template 04-UI-UX s4.2).
Prometheus and Grafana are reached only through ops nginx on wg0. Dashboard: D15 Modules / Billing.

## BillingIntegrityViolation
Severity: page   Owner: C4   Last tested: never (new in T-21)
**Means:** A billing integrity violation was recorded in the last day.  **Impact:** the Billing module's users or the on-call see degraded behaviour until fixed.
**Check first:** Prometheus query `increase(lims_billing_integrity_violations_total[1d]) > 0` (expect: empty when healthy); Grafana D15-billing panel for the metric.
**Fix:** 1. Read the module's error logs in VictoriaLogs around the alert start (no PHI is logged). 2. If the cause is an outside dependency, follow its runbook; if it is module code, hand off to the owner. 3. Confirm the expression returns empty after the fix.
**Escalate when:** not resolved within 30 min, or the cause is in module code → the C4 owner via the LIMS provider on-call.
**Close-out:** `ops-note.sh` line with alert name, tenant id (UUID only) if any, cause and action; incident record for any page longer than 30 min.

## BillingCounterBusy
Severity: warn   Owner: C4   Last tested: never (new in T-21)
**Means:** Invoice number counter busy more than 5 times in 5 min.  **Impact:** the Billing module's users or the on-call see degraded behaviour until fixed.
**Check first:** Prometheus query `increase(lims_billing_counter_busy_total[5m]) > 5` (expect: empty when healthy); Grafana D15-billing panel for the metric.
**Fix:** 1. Read the module's error logs in VictoriaLogs around the alert start (no PHI is logged). 2. If the cause is an outside dependency, follow its runbook; if it is module code, hand off to the owner. 3. Confirm the expression returns empty after the fix.
**Escalate when:** still firing after one working day → the C4 owner.
**Close-out:** `ops-note.sh` line with alert name, tenant id (UUID only) if any, cause and action; incident record for any page longer than 30 min.

## BillingNumberingPatternInvalid
Severity: warn   Owner: C4   Last tested: never (new in T-21)
**Means:** A tenant's invoice numbering pattern was rejected as invalid in the last 15 min.  **Impact:** the Billing module's users or the on-call see degraded behaviour until fixed.
**Check first:** Prometheus query `increase(lims_billing_numbering_pattern_invalid_total[15m]) > 0` (expect: empty when healthy); Grafana D15-billing panel for the metric.
**Fix:** 1. Read the module's error logs in VictoriaLogs around the alert start (no PHI is logged). 2. If the cause is an outside dependency, follow its runbook; if it is module code, hand off to the owner. 3. Confirm the expression returns empty after the fix.
**Escalate when:** still firing after one working day → the C4 owner.
**Close-out:** `ops-note.sh` line with alert name, tenant id (UUID only) if any, cause and action; incident record for any page longer than 30 min.
