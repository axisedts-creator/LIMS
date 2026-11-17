# Analytics & MIS runbook (`analytics`)

Owner C8. One section per alert in `monitoring/rules/imported/analytics.rules.yml` (anchors = lower-case alert names, 02-TRD s11.3; template 04-UI-UX s4.2).
Prometheus and Grafana are reached only through ops nginx on wg0. Dashboard: D15 Modules / Analytics & MIS.

## AnalyticsFamilyStale
Severity: warn   Owner: C8   Last tested: never (new in T-21)
**Means:** An analytics family has been stale for 60 min.  **Impact:** the Analytics & MIS module's users or the on-call see degraded behaviour until fixed.
**Check first:** Prometheus query `max by (tenant_id, family) (lims_analytics_family_stale) == 1` (expect: empty when healthy); Grafana D15-analytics panel for the metric.
**Fix:** 1. Check the job's last runs in VictoriaLogs (module logs, last 2 h). 2. If the worker is down or the queue is stuck, follow `runtime.md#workerdown` / `runtime.md#queuebacklog`. 3. Re-run the job once the cause is fixed; confirm the gauge falls.
**Escalate when:** still firing after one working day → the C8 owner.
**Close-out:** `ops-note.sh` line with alert name, tenant id (UUID only) if any, cause and action; incident record for any page longer than 30 min.

## AnalyticsRefreshFailing
Severity: page   Owner: C8   Last tested: never (new in T-21)
**Means:** An analytics family refresh failed 3 or more times in 30 min.  **Impact:** the Analytics & MIS module's users or the on-call see degraded behaviour until fixed.
**Check first:** Prometheus query `sum by (family) (increase(lims_analytics_refresh_failures_total[30m])) >= 3` (expect: empty when healthy); Grafana D15-analytics panel for the metric.
**Fix:** 1. Read the module's error logs in VictoriaLogs around the alert start (no PHI is logged). 2. If the cause is an outside dependency, follow its runbook; if it is module code, hand off to the owner. 3. Confirm the expression returns empty after the fix.
**Escalate when:** not resolved within 30 min, or the cause is in module code → the C8 owner via the LIMS provider on-call.
**Close-out:** `ops-note.sh` line with alert name, tenant id (UUID only) if any, cause and action; incident record for any page longer than 30 min.

## AnalyticsReconciliationMismatch
Severity: page   Owner: C8   Last tested: never (new in T-21)
**Means:** Analytics reconciliation found a mismatch against the source module.  **Impact:** the Analytics & MIS module's users or the on-call see degraded behaviour until fixed.
**Check first:** Prometheus query `sum by (rule, family) (increase(lims_analytics_reconciliation_mismatch_total[15m])) > 0` (expect: empty when healthy); Grafana D15-analytics panel for the metric.
**Fix:** 1. Read the module's error logs in VictoriaLogs around the alert start (no PHI is logged). 2. If the cause is an outside dependency, follow its runbook; if it is module code, hand off to the owner. 3. Confirm the expression returns empty after the fix.
**Escalate when:** not resolved within 30 min, or the cause is in module code → the C8 owner via the LIMS provider on-call.
**Close-out:** `ops-note.sh` line with alert name, tenant id (UUID only) if any, cause and action; incident record for any page longer than 30 min.

## AnalyticsExportSpike
Severity: page   Owner: C8   Last tested: never (new in T-21)
**Means:** A tenant's analytics exports in 24 h exceed 3x the 14-day daily mean.  **Impact:** the Analytics & MIS module's users or the on-call see degraded behaviour until fixed.
**Check first:** Prometheus query `sum by (tenant_id) (increase(lims_analytics_exports_total[24h])) > 3 * (sum by (tenant_id) (increase(lims_analytics_exports_total[14d])) / 14) and sum by (tenant_id) (increase(lims_analytics_exports_total[24h])) >= 10` (expect: empty when healthy); Grafana D15-analytics panel for the metric.
**Fix:** 1. Read the module's error logs in VictoriaLogs around the alert start (no PHI is logged). 2. If the cause is an outside dependency, follow its runbook; if it is module code, hand off to the owner. 3. Confirm the expression returns empty after the fix.
**Escalate when:** not resolved within 30 min, or the cause is in module code → the C8 owner via the LIMS provider on-call.
**Close-out:** `ops-note.sh` line with alert name, tenant id (UUID only) if any, cause and action; incident record for any page longer than 30 min.

## AnalyticsConsumerDeadLetter
Severity: warn   Owner: C8   Last tested: never (new in T-21)
**Means:** An analytics event consumer dead-lettered.  **Impact:** the Analytics & MIS module's users or the on-call see degraded behaviour until fixed.
**Check first:** Prometheus query `increase(lims_core_dead_letters_total{task=~"(evt\\.)?analytics\\..*"}[5m]) > 0` (expect: empty when healthy); Grafana D15-analytics panel for the metric.
**Fix:** 1. Find the dead letter in the C2 platform console (dead letters, filter by task). 2. Read the error in VictoriaLogs (`dead_letter_created`, same task, last 30 min). 3. Fix the cause, then replay from the console; never edit rows by hand (see `runtime.md`).
**Escalate when:** still firing after one working day → the C8 owner.
**Close-out:** `ops-note.sh` line with alert name, tenant id (UUID only) if any, cause and action; incident record for any page longer than 30 min.
