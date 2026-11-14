# Smart report runbook (`smartreport`)

Owner C14. One section per alert in `monitoring/rules/imported/smartreport.rules.yml` (anchors = lower-case alert names, 02-TRD s11.3; template 04-UI-UX s4.2).
Prometheus and Grafana are reached only through ops nginx on wg0. Dashboard: D15 Modules / Smart report.

## SmartBuildErrors
Severity: warn   Owner: C14   Last tested: never (new in T-21)
**Means:** More than 5 % of smart report builds errored over 15 min.  **Impact:** the Smart report module's users or the on-call see degraded behaviour until fixed.
**Check first:** Prometheus query `sum(rate(lims_smartreport_builds_total{outcome="error"}[15m])) / sum(rate(lims_smartreport_builds_total[15m])) > 0.05` (expect: empty when healthy); Grafana D15-smartreport panel for the metric.
**Fix:** 1. Read the module's error logs in VictoriaLogs around the alert start (no PHI is logged). 2. If the cause is an outside dependency, follow its runbook; if it is module code, hand off to the owner. 3. Confirm the expression returns empty after the fix.
**Escalate when:** still firing after one working day → the C14 owner.
**Close-out:** `ops-note.sh` line with alert name, tenant id (UUID only) if any, cause and action; incident record for any page longer than 30 min.

## SmartDraftsStale
Severity: warn   Owner: C14   Last tested: never (new in T-21)
**Means:** A smart report draft is older than 24 h.  **Impact:** the Smart report module's users or the on-call see degraded behaviour until fixed.
**Check first:** Prometheus query `max by (tenant_id) (lims_smartreport_drafts_oldest_age_seconds) > 86400` (expect: empty when healthy); Grafana D15-smartreport panel for the metric.
**Fix:** 1. Check the job's last runs in VictoriaLogs (module logs, last 2 h). 2. If the worker is down or the queue is stuck, follow `runtime.md#workerdown` / `runtime.md#queuebacklog`. 3. Re-run the job once the cause is fixed; confirm the gauge falls.
**Escalate when:** still firing after one working day → the C14 owner.
**Close-out:** `ops-note.sh` line with alert name, tenant id (UUID only) if any, cause and action; incident record for any page longer than 30 min.

## SmartLlmCallWhileDisabled
Severity: page   Owner: C14   Last tested: never (new in T-21)
**Means:** An LLM call was made while the LLM feature is disabled.  **Impact:** the Smart report module's users or the on-call see degraded behaviour until fixed.
**Check first:** Prometheus query `increase(lims_smartreport_llm_calls_while_disabled_total[5m]) > 0` (expect: empty when healthy); Grafana D15-smartreport panel for the metric.
**Fix:** 1. Read the module's error logs in VictoriaLogs around the alert start (no PHI is logged). 2. If the cause is an outside dependency, follow its runbook; if it is module code, hand off to the owner. 3. Confirm the expression returns empty after the fix.
**Escalate when:** not resolved within 30 min, or the cause is in module code → the C14 owner via the LIMS provider on-call.
**Close-out:** `ops-note.sh` line with alert name, tenant id (UUID only) if any, cause and action; incident record for any page longer than 30 min.

## SmartLlmEndpointNotAllowed
Severity: page   Owner: C14   Last tested: never (new in T-21)
**Means:** An LLM call to a non-allowlisted endpoint was refused.  **Impact:** the Smart report module's users or the on-call see degraded behaviour until fixed.
**Check first:** Prometheus query `increase(lims_smartreport_llm_endpoint_refused_total[5m]) > 0` (expect: empty when healthy); Grafana D15-smartreport panel for the metric.
**Fix:** 1. Read the module's error logs in VictoriaLogs around the alert start (no PHI is logged). 2. If the cause is an outside dependency, follow its runbook; if it is module code, hand off to the owner. 3. Confirm the expression returns empty after the fix.
**Escalate when:** not resolved within 30 min, or the cause is in module code → the C14 owner via the LIMS provider on-call.
**Close-out:** `ops-note.sh` line with alert name, tenant id (UUID only) if any, cause and action; incident record for any page longer than 30 min.

## SmartLlmFailing
Severity: warn   Owner: C14   Last tested: never (new in T-21)
**Means:** The smart report LLM circuit breaker is open.  **Impact:** the Smart report module's users or the on-call see degraded behaviour until fixed.
**Check first:** Prometheus query `max(lims_smartreport_llm_circuit_open) == 1` (expect: empty when healthy); Grafana D15-smartreport panel for the metric.
**Fix:** 1. Read the module's error logs in VictoriaLogs around the alert start (no PHI is logged). 2. If the cause is an outside dependency, follow its runbook; if it is module code, hand off to the owner. 3. Confirm the expression returns empty after the fix.
**Escalate when:** still firing after one working day → the C14 owner.
**Close-out:** `ops-note.sh` line with alert name, tenant id (UUID only) if any, cause and action; incident record for any page longer than 30 min.

## SmartConsumerLag
Severity: warn   Owner: C14   Last tested: never (new in T-21)
**Means:** More than 1000 smart report events queued for 10 min.  **Impact:** the Smart report module's users or the on-call see degraded behaviour until fixed.
**Check first:** Prometheus query `sum(lims_queue_depth{task=~"evt\\.smartreport\\..*"}) > 1000` (expect: empty when healthy); Grafana D15-smartreport panel for the metric.
**Fix:** 1. Read the module's error logs in VictoriaLogs around the alert start (no PHI is logged). 2. If the cause is an outside dependency, follow its runbook; if it is module code, hand off to the owner. 3. Confirm the expression returns empty after the fix.
**Escalate when:** still firing after one working day → the C14 owner.
**Close-out:** `ops-note.sh` line with alert name, tenant id (UUID only) if any, cause and action; incident record for any page longer than 30 min.
