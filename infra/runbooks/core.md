# Core platform runbook (`core`)

Owner C0. One section per alert in `monitoring/rules/core.rules.yml` (anchors = lower-case alert names, 02-TRD s11.3; template 04-UI-UX s4.2).
Prometheus and Grafana are reached only through ops nginx on wg0. Dashboard: D15 Modules / Core platform.

## CoreDeadLetter
Severity: page   Owner: C0   Last tested: never (new in T-21)
**Means:** A job or event consumer dead-lettered (any task).  **Impact:** the Core platform module's users or the on-call see degraded behaviour until fixed.
**Check first:** Prometheus query `sum(increase(lims_core_dead_letters_total[5m])) > 0` (expect: empty when healthy); Grafana D15-core panel for the metric.
**Fix:** 1. Find the dead letter in the C2 platform console (dead letters, filter by task). 2. Read the error in VictoriaLogs (`dead_letter_created`, same task, last 30 min). 3. Fix the cause, then replay from the console; never edit rows by hand (see `runtime.md`).
**Escalate when:** not resolved within 30 min, or the cause is in module code → the C0 owner via the LIMS provider on-call.
**Close-out:** `ops-note.sh` line with alert name, tenant id (UUID only) if any, cause and action; incident record for any page longer than 30 min.

## CoreFakePortsActive
Severity: page   Owner: C0   Last tested: never (new in T-21)
**Means:** A fake port implementation is active in staging or prod.  **Impact:** the Core platform module's users or the on-call see degraded behaviour until fixed.
**Check first:** Prometheus query `max by (env) (lims_core_fake_ports_active{env=~"staging|prod"}) > 0` (expect: empty when healthy); Grafana D15-core panel for the metric.
**Fix:** 1. Read the module's error logs in VictoriaLogs around the alert start (no PHI is logged). 2. If the cause is an outside dependency, follow its runbook; if it is module code, hand off to the owner. 3. Confirm the expression returns empty after the fix.
**Escalate when:** not resolved within 30 min, or the cause is in module code → the C0 owner via the LIMS provider on-call.
**Close-out:** `ops-note.sh` line with alert name, tenant id (UUID only) if any, cause and action; incident record for any page longer than 30 min.

## CoreFanoutLagHigh
Severity: warn   Owner: C0   Last tested: never (new in T-21)
**Means:** Event fan-out lag p95 above 10 s for 5 min.  **Impact:** the Core platform module's users or the on-call see degraded behaviour until fixed.
**Check first:** Prometheus query `histogram_quantile(0.95, sum by (le) (rate(lims_core_event_fanout_lag_seconds_bucket[5m]))) > 10` (expect: empty when healthy); Grafana D15-core panel for the metric.
**Fix:** 1. Check the job's last runs in VictoriaLogs (module logs, last 2 h). 2. If the worker is down or the queue is stuck, follow `runtime.md#workerdown` / `runtime.md#queuebacklog`. 3. Re-run the job once the cause is fixed; confirm the gauge falls.
**Escalate when:** still firing after one working day → the C0 owner.
**Close-out:** `ops-note.sh` line with alert name, tenant id (UUID only) if any, cause and action; incident record for any page longer than 30 min.

## CoreRlsDeniedSpike
Severity: page   Owner: C0   Last tested: never (new in T-21)
**Means:** RLS denials above 5x the 7-day baseline for 10 min.  **Impact:** the Core platform module's users or the on-call see degraded behaviour until fixed.
**Check first:** Prometheus query `sum(rate(lims_rls_denied_total[5m])) > 5 * sum(rate(lims_rls_denied_total[7d]))` (expect: empty when healthy); Grafana D15-core panel for the metric.
**Fix:** 1. Read the module's error logs in VictoriaLogs around the alert start (no PHI is logged). 2. If the cause is an outside dependency, follow its runbook; if it is module code, hand off to the owner. 3. Confirm the expression returns empty after the fix.
**Escalate when:** not resolved within 30 min, or the cause is in module code → the C0 owner via the LIMS provider on-call.
**Close-out:** `ops-note.sh` line with alert name, tenant id (UUID only) if any, cause and action; incident record for any page longer than 30 min.

## CoreAuthAlgFailure
Severity: page   Owner: C0   Last tested: never (new in T-21)
**Means:** A token with a disallowed algorithm was presented.  **Impact:** the Core platform module's users or the on-call see degraded behaviour until fixed.
**Check first:** Prometheus query `increase(lims_core_auth_failures_total{reason="alg"}[5m]) > 0` (expect: empty when healthy); Grafana D15-core panel for the metric.
**Fix:** 1. Read the module's error logs in VictoriaLogs around the alert start (no PHI is logged). 2. If the cause is an outside dependency, follow its runbook; if it is module code, hand off to the owner. 3. Confirm the expression returns empty after the fix.
**Escalate when:** not resolved within 30 min, or the cause is in module code → the C0 owner via the LIMS provider on-call.
**Close-out:** `ops-note.sh` line with alert name, tenant id (UUID only) if any, cause and action; incident record for any page longer than 30 min.

## CoreAuthzNotAsserted
Severity: page   Owner: C0   Last tested: never (new in T-21)
**Means:** An operation returned without an authorization assertion.  **Impact:** the Core platform module's users or the on-call see degraded behaviour until fixed.
**Check first:** Prometheus query `increase(lims_core_authz_not_asserted_total[5m]) > 0` (expect: empty when healthy); Grafana D15-core panel for the metric.
**Fix:** 1. Read the module's error logs in VictoriaLogs around the alert start (no PHI is logged). 2. If the cause is an outside dependency, follow its runbook; if it is module code, hand off to the owner. 3. Confirm the expression returns empty after the fix.
**Escalate when:** not resolved within 30 min, or the cause is in module code → the C0 owner via the LIMS provider on-call.
**Close-out:** `ops-note.sh` line with alert name, tenant id (UUID only) if any, cause and action; incident record for any page longer than 30 min.

## CoreRetentionPurgeCapped
Severity: warn   Owner: C0   Last tested: never (new in T-21)
**Means:** Retention purge hit its cap three days in a row.  **Impact:** the Core platform module's users or the on-call see degraded behaviour until fixed.
**Check first:** Prometheus query `sum by (table) (increase(lims_core_retention_purge_capped_total[26h])) > 0` (expect: empty when healthy); Grafana D15-core panel for the metric.
**Fix:** 1. Read the module's error logs in VictoriaLogs around the alert start (no PHI is logged). 2. If the cause is an outside dependency, follow its runbook; if it is module code, hand off to the owner. 3. Confirm the expression returns empty after the fix.
**Escalate when:** still firing after one working day → the C0 owner.
**Close-out:** `ops-note.sh` line with alert name, tenant id (UUID only) if any, cause and action; incident record for any page longer than 30 min.
