# B2B partner portal runbook (`partners`)

Owner C13. One section per alert in `monitoring/rules/partners.rules.yml` (anchors = lower-case alert names, 02-TRD s11.3; template 04-UI-UX s4.2).
Prometheus and Grafana are reached only through ops nginx on wg0. Dashboard: D15 Modules / B2B partner portal.

## PartnersConversionFailures
Severity: warn   Owner: C13   Last tested: never (new in T-21)
**Means:** More than 5 manifest line conversions failed (infra) in 15 min.  **Impact:** the B2B partner portal module's users or the on-call see degraded behaviour until fixed.
**Check first:** Prometheus query `sum(increase(lims_partners_line_conversions_total{outcome="failed_infra"}[15m])) > 5` (expect: empty when healthy); Grafana D15-partners panel for the metric.
**Fix:** 1. Read the module's error logs in VictoriaLogs around the alert start (no PHI is logged). 2. If the cause is an outside dependency, follow its runbook; if it is module code, hand off to the owner. 3. Confirm the expression returns empty after the fix.
**Escalate when:** still firing after one working day → the C13 owner.
**Close-out:** `ops-note.sh` line with alert name, tenant id (UUID only) if any, cause and action; incident record for any page longer than 30 min.

## PartnersConsumerMismatch
Severity: page   Owner: C13   Last tested: never (new in T-21)
**Means:** A partner event consumer saw a mismatch (possible wrong partner attribution).  **Impact:** the B2B partner portal module's users or the on-call see degraded behaviour until fixed.
**Check first:** Prometheus query `sum(increase(lims_partners_events_consumed_total{outcome="mismatch"}[15m])) > 0` (expect: empty when healthy); Grafana D15-partners panel for the metric.
**Fix:** 1. Read the module's error logs in VictoriaLogs around the alert start (no PHI is logged). 2. If the cause is an outside dependency, follow its runbook; if it is module code, hand off to the owner. 3. Confirm the expression returns empty after the fix.
**Escalate when:** not resolved within 30 min, or the cause is in module code → the C13 owner via the LIMS provider on-call.
**Close-out:** `ops-note.sh` line with alert name, tenant id (UUID only) if any, cause and action; incident record for any page longer than 30 min.

## PartnersDownloadDeniedSpike
Severity: warn   Owner: C13   Last tested: never (new in T-21)
**Means:** More than 20 partner report downloads denied in 10 min (id guessing).  **Impact:** the B2B partner portal module's users or the on-call see degraded behaviour until fixed.
**Check first:** Prometheus query `sum(increase(lims_partners_report_downloads_total{outcome="denied"}[10m])) > 20` (expect: empty when healthy); Grafana D15-partners panel for the metric.
**Fix:** 1. Read the module's error logs in VictoriaLogs around the alert start (no PHI is logged). 2. If the cause is an outside dependency, follow its runbook; if it is module code, hand off to the owner. 3. Confirm the expression returns empty after the fix.
**Escalate when:** still firing after one working day → the C13 owner.
**Close-out:** `ops-note.sh` line with alert name, tenant id (UUID only) if any, cause and action; incident record for any page longer than 30 min.

## PartnersStatementsProjectionStale
Severity: warn   Owner: C13   Last tested: never (new in T-21)
**Means:** Partner statements projection lag above 3 h.  **Impact:** the B2B partner portal module's users or the on-call see degraded behaviour until fixed.
**Check first:** Prometheus query `max(lims_partners_projection_lag_seconds{projection="statements"}) > 10800` (expect: empty when healthy); Grafana D15-partners panel for the metric.
**Fix:** 1. Check the job's last runs in VictoriaLogs (module logs, last 2 h). 2. If the worker is down or the queue is stuck, follow `runtime.md#workerdown` / `runtime.md#queuebacklog`. 3. Re-run the job once the cause is fixed; confirm the gauge falls.
**Escalate when:** still firing after one working day → the C13 owner.
**Close-out:** `ops-note.sh` line with alert name, tenant id (UUID only) if any, cause and action; incident record for any page longer than 30 min.

## PartnersPriceListProjectionStale
Severity: warn   Owner: C13   Last tested: never (new in T-21)
**Means:** Partner price list projection lag above 26 h.  **Impact:** the B2B partner portal module's users or the on-call see degraded behaviour until fixed.
**Check first:** Prometheus query `max(lims_partners_projection_lag_seconds{projection="price_list"}) > 93600` (expect: empty when healthy); Grafana D15-partners panel for the metric.
**Fix:** 1. Check the job's last runs in VictoriaLogs (module logs, last 2 h). 2. If the worker is down or the queue is stuck, follow `runtime.md#workerdown` / `runtime.md#queuebacklog`. 3. Re-run the job once the cause is fixed; confirm the gauge falls.
**Escalate when:** still firing after one working day → the C13 owner.
**Close-out:** `ops-note.sh` line with alert name, tenant id (UUID only) if any, cause and action; incident record for any page longer than 30 min.

## PartnersDeadLetter
Severity: warn   Owner: C13   Last tested: never (new in T-21)
**Means:** A partners job or event consumer dead-lettered.  **Impact:** the B2B partner portal module's users or the on-call see degraded behaviour until fixed.
**Check first:** Prometheus query `increase(lims_core_dead_letters_total{task=~"partners.*|evt.partners.*"}[5m]) > 0` (expect: empty when healthy); Grafana D15-partners panel for the metric.
**Fix:** 1. Find the dead letter in the C2 platform console (dead letters, filter by task). 2. Read the error in VictoriaLogs (`dead_letter_created`, same task, last 30 min). 3. Fix the cause, then replay from the console; never edit rows by hand (see `runtime.md`).
**Escalate when:** still firing after one working day → the C13 owner.
**Close-out:** `ops-note.sh` line with alert name, tenant id (UUID only) if any, cause and action; incident record for any page longer than 30 min.
