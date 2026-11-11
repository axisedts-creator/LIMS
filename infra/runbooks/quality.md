# Quality engine runbook (`quality`)

Owner C9. One section per alert in `monitoring/rules/imported/quality.rules.yml` (anchors = lower-case alert names, 02-TRD s11.3; template 04-UI-UX s4.2).
Prometheus and Grafana are reached only through ops nginx on wg0. Dashboard: D15 Modules / Quality engine.

## QualityRejectedRunWithoutAction
Severity: warn   Owner: C9   Last tested: never (new in T-21)
**Means:** A rejected QC run has had no corrective action for over 4 h.  **Impact:** the Quality engine module's users or the on-call see degraded behaviour until fixed.
**Check first:** Prometheus query `max by (tenant_id) (lims_quality_qc_rejected_without_action_oldest_age_seconds) > 14400` (expect: empty when healthy); Grafana D15-quality panel for the metric.
**Fix:** 1. Check the job's last runs in VictoriaLogs (module logs, last 2 h). 2. If the worker is down or the queue is stuck, follow `runtime.md#workerdown` / `runtime.md#queuebacklog`. 3. Re-run the job once the cause is fixed; confirm the gauge falls.
**Escalate when:** still firing after one working day → the C9 owner.
**Close-out:** `ops-note.sh` line with alert name, tenant id (UUID only) if any, cause and action; incident record for any page longer than 30 min.

## QualityConsumerDeadLetter
Severity: page   Owner: C9   Last tested: never (new in T-21)
**Means:** A quality job or event consumer dead-lettered.  **Impact:** the Quality engine module's users or the on-call see degraded behaviour until fixed.
**Check first:** Prometheus query `increase(lims_core_dead_letters_total{task=~"(evt\\.)?quality\\..*"}[5m]) > 0` (expect: empty when healthy); Grafana D15-quality panel for the metric.
**Fix:** 1. Find the dead letter in the C2 platform console (dead letters, filter by task). 2. Read the error in VictoriaLogs (`dead_letter_created`, same task, last 30 min). 3. Fix the cause, then replay from the console; never edit rows by hand (see `runtime.md`).
**Escalate when:** not resolved within 30 min, or the cause is in module code → the C9 owner via the LIMS provider on-call.
**Close-out:** `ops-note.sh` line with alert name, tenant id (UUID only) if any, cause and action; incident record for any page longer than 30 min.

## QualityQcSyncStalled
Severity: page   Owner: C9   Last tested: never (new in T-21)
**Means:** QC sync has not succeeded for a tenant for over 5 min.  **Impact:** the Quality engine module's users or the on-call see degraded behaviour until fixed.
**Check first:** Prometheus query `time() - max by (tenant_id) (lims_quality_qc_sync_last_success_timestamp_seconds) > 300` (expect: empty when healthy); Grafana D15-quality panel for the metric.
**Fix:** 1. Check the job's last runs in VictoriaLogs (module logs, last 2 h). 2. If the worker is down or the queue is stuck, follow `runtime.md#workerdown` / `runtime.md#queuebacklog`. 3. Re-run the job once the cause is fixed; confirm the gauge falls.
**Escalate when:** not resolved within 30 min, or the cause is in module code → the C9 owner via the LIMS provider on-call.
**Close-out:** `ops-note.sh` line with alert name, tenant id (UUID only) if any, cause and action; incident record for any page longer than 30 min.

## QualityQcImportError
Severity: warn   Owner: C9   Last tested: never (new in T-21)
**Means:** A QC observation failed to import in the last 15 min.  **Impact:** the Quality engine module's users or the on-call see degraded behaviour until fixed.
**Check first:** Prometheus query `increase(lims_quality_qc_observations_total{status="import_error"}[15m]) > 0` (expect: empty when healthy); Grafana D15-quality panel for the metric.
**Fix:** 1. Read the module's error logs in VictoriaLogs around the alert start (no PHI is logged). 2. If the cause is an outside dependency, follow its runbook; if it is module code, hand off to the owner. 3. Confirm the expression returns empty after the fix.
**Escalate when:** still firing after one working day → the C9 owner.
**Close-out:** `ops-note.sh` line with alert name, tenant id (UUID only) if any, cause and action; incident record for any page longer than 30 min.

## QualityPortSlow
Severity: warn   Owner: C9   Last tested: never (new in T-21)
**Means:** Quality port p95 latency above 10 ms for 15 min.  **Impact:** the Quality engine module's users or the on-call see degraded behaviour until fixed.
**Check first:** Prometheus query `histogram_quantile(0.95, sum by (le, method) (rate(lims_quality_port_duration_seconds_bucket[5m]))) > 0.01` (expect: empty when healthy); Grafana D15-quality panel for the metric.
**Fix:** 1. Read the module's error logs in VictoriaLogs around the alert start (no PHI is logged). 2. If the cause is an outside dependency, follow its runbook; if it is module code, hand off to the owner. 3. Confirm the expression returns empty after the fix.
**Escalate when:** still firing after one working day → the C9 owner.
**Close-out:** `ops-note.sh` line with alert name, tenant id (UUID only) if any, cause and action; incident record for any page longer than 30 min.

## QualityTatSweepSlow
Severity: warn   Owner: C9   Last tested: never (new in T-21)
**Means:** TAT sweep p95 above 10 s for 15 min.  **Impact:** the Quality engine module's users or the on-call see degraded behaviour until fixed.
**Check first:** Prometheus query `histogram_quantile(0.95, sum by (le) (rate(lims_quality_tat_sweep_duration_seconds_bucket[5m]))) > 10` (expect: empty when healthy); Grafana D15-quality panel for the metric.
**Fix:** 1. Read the module's error logs in VictoriaLogs around the alert start (no PHI is logged). 2. If the cause is an outside dependency, follow its runbook; if it is module code, hand off to the owner. 3. Confirm the expression returns empty after the fix.
**Escalate when:** still firing after one working day → the C9 owner.
**Close-out:** `ops-note.sh` line with alert name, tenant id (UUID only) if any, cause and action; incident record for any page longer than 30 min.

## QualityAutoverifyAllowWithReasons
Severity: page   Owner: C9   Last tested: never (new in T-21)
**Means:** Autoverification allowed a result while a blocking reason was present.  **Impact:** the Quality engine module's users or the on-call see degraded behaviour until fixed.
**Check first:** Prometheus query `increase(lims_quality_autoverify_decisions_total{decision="allow", reason!="none"}[5m]) > 0` (expect: empty when healthy); Grafana D15-quality panel for the metric.
**Fix:** 1. Read the module's error logs in VictoriaLogs around the alert start (no PHI is logged). 2. If the cause is an outside dependency, follow its runbook; if it is module code, hand off to the owner. 3. Confirm the expression returns empty after the fix.
**Escalate when:** not resolved within 30 min, or the cause is in module code → the C9 owner via the LIMS provider on-call.
**Close-out:** `ops-note.sh` line with alert name, tenant id (UUID only) if any, cause and action; incident record for any page longer than 30 min.
