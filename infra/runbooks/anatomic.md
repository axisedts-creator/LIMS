# Anatomic pathology runbook (`anatomic`)

Owner C11. One section per alert in `monitoring/rules/anatomic.rules.yml` (anchors = lower-case alert names, 02-TRD s11.3; template 04-UI-UX s4.2).
Prometheus and Grafana are reached only through ops nginx on wg0. Dashboard: D15 Modules / Anatomic pathology.

## AnatomicConsumerDeadLetter
Severity: warn   Owner: C11   Last tested: never (new in T-21)
**Means:** An anatomic pathology event consumer dead-lettered.  **Impact:** the Anatomic pathology module's users or the on-call see degraded behaviour until fixed.
**Check first:** Prometheus query `increase(lims_core_dead_letters_total{task=~"evt.anatomic.*"}[5m]) > 0` (expect: empty when healthy); Grafana D15-anatomic panel for the metric.
**Fix:** 1. Find the dead letter in the C2 platform console (dead letters, filter by task). 2. Read the error in VictoriaLogs (`dead_letter_created`, same task, last 30 min). 3. Fix the cause, then replay from the console; never edit rows by hand (see `runtime.md`).
**Escalate when:** still firing after one working day → the C11 owner.
**Close-out:** `ops-note.sh` line with alert name, tenant id (UUID only) if any, cause and action; incident record for any page longer than 30 min.

## AnatomicImageQuarantined
Severity: warn   Owner: C11   Last tested: never (new in T-21)
**Means:** More than 5 images quarantined for one tenant in 1 h (security).  **Impact:** the Anatomic pathology module's users or the on-call see degraded behaviour until fixed.
**Check first:** Prometheus query `sum by (tenant_id) (increase(lims_anatomic_image_processing_total{outcome="quarantined"}[1h])) > 5` (expect: empty when healthy); Grafana D15-anatomic panel for the metric.
**Fix:** 1. Read the module's error logs in VictoriaLogs around the alert start (no PHI is logged). 2. If the cause is an outside dependency, follow its runbook; if it is module code, hand off to the owner. 3. Confirm the expression returns empty after the fix.
**Escalate when:** still firing after one working day → the C11 owner.
**Close-out:** `ops-note.sh` line with alert name, tenant id (UUID only) if any, cause and action; incident record for any page longer than 30 min.

## AnatomicSubmitFailures
Severity: warn   Owner: C11   Last tested: never (new in T-21)
**Means:** Anatomic pathology submit failures above 0.1/min for 10 min.  **Impact:** the Anatomic pathology module's users or the on-call see degraded behaviour until fixed.
**Check first:** Prometheus query `sum(rate(lims_anatomic_submit_failures_total[5m])) * 60 > 0.1` (expect: empty when healthy); Grafana D15-anatomic panel for the metric.
**Fix:** 1. Read the module's error logs in VictoriaLogs around the alert start (no PHI is logged). 2. If the cause is an outside dependency, follow its runbook; if it is module code, hand off to the owner. 3. Confirm the expression returns empty after the fix.
**Escalate when:** still firing after one working day → the C11 owner.
**Close-out:** `ops-note.sh` line with alert name, tenant id (UUID only) if any, cause and action; incident record for any page longer than 30 min.

## AnatomicLookupNotFoundSpike
Severity: warn   Owner: C11   Last tested: never (new in T-21)
**Means:** Case/block/slide lookups not found above 50/min (possible enumeration).  **Impact:** the Anatomic pathology module's users or the on-call see degraded behaviour until fixed.
**Check first:** Prometheus query `sum(rate(lims_anatomic_lookup_total{result="not_found"}[5m])) * 60 > 50` (expect: empty when healthy); Grafana D15-anatomic panel for the metric.
**Fix:** 1. Read the module's error logs in VictoriaLogs around the alert start (no PHI is logged). 2. If the cause is an outside dependency, follow its runbook; if it is module code, hand off to the owner. 3. Confirm the expression returns empty after the fix.
**Escalate when:** still firing after one working day → the C11 owner.
**Close-out:** `ops-note.sh` line with alert name, tenant id (UUID only) if any, cause and action; incident record for any page longer than 30 min.
