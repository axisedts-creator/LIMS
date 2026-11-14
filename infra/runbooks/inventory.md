# Inventory runbook (`inventory`)

Owner C12. One section per alert in `monitoring/rules/imported/inventory.rules.yml` (anchors = lower-case alert names, 02-TRD s11.3; template 04-UI-UX s4.2).
Prometheus and Grafana are reached only through ops nginx on wg0. Dashboard: D15 Modules / Inventory.

## InventoryConsumerFailing
Severity: page   Owner: C12   Last tested: never (new in T-21)
**Means:** An inventory event consumer has been failing for 15 min.  **Impact:** the Inventory module's users or the on-call see degraded behaviour until fixed.
**Check first:** Prometheus query `sum by (event_type) (increase(lims_inventory_consumer_failures_total[15m])) > 0` (expect: empty when healthy); Grafana D15-inventory panel for the metric.
**Fix:** 1. Read the module's error logs in VictoriaLogs around the alert start (no PHI is logged). 2. If the cause is an outside dependency, follow its runbook; if it is module code, hand off to the owner. 3. Confirm the expression returns empty after the fix.
**Escalate when:** not resolved within 30 min, or the cause is in module code → the C12 owner via the LIMS provider on-call.
**Close-out:** `ops-note.sh` line with alert name, tenant id (UUID only) if any, cause and action; incident record for any page longer than 30 min.

## InventoryConsumptionLagHigh
Severity: warn   Owner: C12   Last tested: never (new in T-21)
**Means:** Inventory consumption lag p95 above 5 min for 15 min.  **Impact:** the Inventory module's users or the on-call see degraded behaviour until fixed.
**Check first:** Prometheus query `histogram_quantile(0.95, sum by (le, event_type) (rate(lims_inventory_consumption_lag_seconds_bucket[5m]))) > 300` (expect: empty when healthy); Grafana D15-inventory panel for the metric.
**Fix:** 1. Check the job's last runs in VictoriaLogs (module logs, last 2 h). 2. If the worker is down or the queue is stuck, follow `runtime.md#workerdown` / `runtime.md#queuebacklog`. 3. Re-run the job once the cause is fixed; confirm the gauge falls.
**Escalate when:** still firing after one working day → the C12 owner.
**Close-out:** `ops-note.sh` line with alert name, tenant id (UUID only) if any, cause and action; incident record for any page longer than 30 min.

## InventoryBalanceDrift
Severity: page   Owner: C12   Last tested: never (new in T-21)
**Means:** Inventory balances drift from the movement ledger.  **Impact:** the Inventory module's users or the on-call see degraded behaviour until fixed.
**Check first:** Prometheus query `max by (tenant_id) (lims_inventory_balance_drift_rows) > 0` (expect: empty when healthy); Grafana D15-inventory panel for the metric.
**Fix:** 1. Read the module's error logs in VictoriaLogs around the alert start (no PHI is logged). 2. If the cause is an outside dependency, follow its runbook; if it is module code, hand off to the owner. 3. Confirm the expression returns empty after the fix.
**Escalate when:** not resolved within 30 min, or the cause is in module code → the C12 owner via the LIMS provider on-call.
**Close-out:** `ops-note.sh` line with alert name, tenant id (UUID only) if any, cause and action; incident record for any page longer than 30 min.

## InventoryUnresolvedBacklog
Severity: warn   Owner: C12   Last tested: never (new in T-21)
**Means:** An unresolved inventory consumption is older than 24 h.  **Impact:** the Inventory module's users or the on-call see degraded behaviour until fixed.
**Check first:** Prometheus query `max by (tenant_id) (lims_inventory_unresolved_oldest_age_seconds) > 86400` (expect: empty when healthy); Grafana D15-inventory panel for the metric.
**Fix:** 1. Check the job's last runs in VictoriaLogs (module logs, last 2 h). 2. If the worker is down or the queue is stuck, follow `runtime.md#workerdown` / `runtime.md#queuebacklog`. 3. Re-run the job once the cause is fixed; confirm the gauge falls.
**Escalate when:** still firing after one working day → the C12 owner.
**Close-out:** `ops-note.sh` line with alert name, tenant id (UUID only) if any, cause and action; incident record for any page longer than 30 min.
