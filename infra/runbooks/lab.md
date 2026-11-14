# Lab workflow runbook (`lab`)

Owner C5. One section per alert in `monitoring/rules/imported/lab.rules.yml` (anchors = lower-case alert names, 02-TRD s11.3; template 04-UI-UX s4.2).
Prometheus and Grafana are reached only through ops nginx on wg0. Dashboard: D15 Modules / Lab workflow.

## LabCriticalValueUnnotified
Severity: page   Owner: C5   Last tested: never (new in T-21)
**Means:** A critical value has been unnotified for more than 30 min.  **Impact:** the Lab workflow module's users or the on-call see degraded behaviour until fixed.
**Check first:** Prometheus query `max by (tenant_id) (lims_lab_critical_unnotified_oldest_age_seconds) > 1800` (expect: empty when healthy); Grafana D15-lab panel for the metric.
**Fix:** 1. Check the job's last runs in VictoriaLogs (module logs, last 2 h). 2. If the worker is down or the queue is stuck, follow `runtime.md#workerdown` / `runtime.md#queuebacklog`. 3. Re-run the job once the cause is fixed; confirm the gauge falls.
**Escalate when:** not resolved within 30 min, or the cause is in module code → the C5 owner via the LIMS provider on-call.
**Close-out:** `ops-note.sh` line with alert name, tenant id (UUID only) if any, cause and action; incident record for any page longer than 30 min.

## LabIngestExceptionStale
Severity: warn   Owner: C5   Last tested: never (new in T-21)
**Means:** An instrument ingest exception has been open for over 24 h.  **Impact:** the Lab workflow module's users or the on-call see degraded behaviour until fixed.
**Check first:** Prometheus query `max by (tenant_id, reason) (lims_lab_ingest_exception_oldest_open_age_seconds) > 86400` (expect: empty when healthy); Grafana D15-lab panel for the metric.
**Fix:** 1. Check the job's last runs in VictoriaLogs (module logs, last 2 h). 2. If the worker is down or the queue is stuck, follow `runtime.md#workerdown` / `runtime.md#queuebacklog`. 3. Re-run the job once the cause is fixed; confirm the gauge falls.
**Escalate when:** still firing after one working day → the C5 owner.
**Close-out:** `ops-note.sh` line with alert name, tenant id (UUID only) if any, cause and action; incident record for any page longer than 30 min.

## LabConsumerDeadLetter
Severity: page   Owner: C5   Last tested: never (new in T-21)
**Means:** A lab job or event consumer dead-lettered.  **Impact:** the Lab workflow module's users or the on-call see degraded behaviour until fixed.
**Check first:** Prometheus query `increase(lims_core_dead_letters_total{task=~"(evt\\.)?lab\\..*"}[5m]) > 0` (expect: empty when healthy); Grafana D15-lab panel for the metric.
**Fix:** 1. Find the dead letter in the C2 platform console (dead letters, filter by task). 2. Read the error in VictoriaLogs (`dead_letter_created`, same task, last 30 min). 3. Fix the cause, then replay from the console; never edit rows by hand (see `runtime.md`).
**Escalate when:** not resolved within 30 min, or the cause is in module code → the C5 owner via the LIMS provider on-call.
**Close-out:** `ops-note.sh` line with alert name, tenant id (UUID only) if any, cause and action; incident record for any page longer than 30 min.

## LabHostQuerySlow
Severity: warn   Owner: C5   Last tested: never (new in T-21)
**Means:** Instrument host query p95 above 300 ms for 15 min.  **Impact:** the Lab workflow module's users or the on-call see degraded behaviour until fixed.
**Check first:** Prometheus query `histogram_quantile(0.95, sum by (le) (rate(lims_lab_host_query_duration_seconds_bucket[5m]))) > 0.3` (expect: empty when healthy); Grafana D15-lab panel for the metric.
**Fix:** 1. Read the module's error logs in VictoriaLogs around the alert start (no PHI is logged). 2. If the cause is an outside dependency, follow its runbook; if it is module code, hand off to the owner. 3. Confirm the expression returns empty after the fix.
**Escalate when:** still firing after one working day → the C5 owner.
**Close-out:** `ops-note.sh` line with alert name, tenant id (UUID only) if any, cause and action; incident record for any page longer than 30 min.

## LabBarcodeAllocationFailure
Severity: page   Owner: C5   Last tested: never (new in T-21)
**Means:** Barcode allocation failed in the last 5 min.  **Impact:** the Lab workflow module's users or the on-call see degraded behaviour until fixed.
**Check first:** Prometheus query `increase(lims_lab_barcode_alloc_failures_total[5m]) > 0` (expect: empty when healthy); Grafana D15-lab panel for the metric.
**Fix:** 1. Read the module's error logs in VictoriaLogs around the alert start (no PHI is logged). 2. If the cause is an outside dependency, follow its runbook; if it is module code, hand off to the owner. 3. Confirm the expression returns empty after the fix.
**Escalate when:** not resolved within 30 min, or the cause is in module code → the C5 owner via the LIMS provider on-call.
**Close-out:** `ops-note.sh` line with alert name, tenant id (UUID only) if any, cause and action; incident record for any page longer than 30 min.
