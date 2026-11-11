# Front desk runbook (`frontdesk`)

Owner C4. One section per alert in `monitoring/rules/imported/frontdesk.rules.yml` (anchors = lower-case alert names, 02-TRD s11.3; template 04-UI-UX s4.2).
Prometheus and Grafana are reached only through ops nginx on wg0. Dashboard: D15 Modules / Front desk.

## FrontdeskTrfQuarantineBurst
Severity: warn   Owner: C4   Last tested: never (new in T-21)
**Means:** More than 3 TRF scans quarantined in the last hour.  **Impact:** the Front desk module's users or the on-call see degraded behaviour until fixed.
**Check first:** Prometheus query `increase(lims_frontdesk_trf_scans_total{outcome="quarantined"}[1h]) > 3` (expect: empty when healthy); Grafana D15-frontdesk panel for the metric.
**Fix:** 1. Read the module's error logs in VictoriaLogs around the alert start (no PHI is logged). 2. If the cause is an outside dependency, follow its runbook; if it is module code, hand off to the owner. 3. Confirm the expression returns empty after the fix.
**Escalate when:** still firing after one working day → the C4 owner.
**Close-out:** `ops-note.sh` line with alert name, tenant id (UUID only) if any, cause and action; incident record for any page longer than 30 min.
