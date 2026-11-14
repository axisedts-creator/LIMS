# Catalog & pricing runbook (`catalog`)

Owner C3. One section per alert in `monitoring/rules/imported/catalog.rules.yml` (anchors = lower-case alert names, 02-TRD s11.3; template 04-UI-UX s4.2).
Prometheus and Grafana are reached only through ops nginx on wg0. Dashboard: D15 Modules / Catalog & pricing.

## CatalogImportQuarantined
Severity: page   Owner: C3   Last tested: never (new in T-21)
**Means:** A catalog import file was quarantined (malware scan).  **Impact:** the Catalog & pricing module's users or the on-call see degraded behaviour until fixed.
**Check first:** Prometheus query `increase(lims_catalog_imports_total{outcome="quarantined"}[5m]) > 0` (expect: empty when healthy); Grafana D15-catalog panel for the metric.
**Fix:** 1. Read the module's error logs in VictoriaLogs around the alert start (no PHI is logged). 2. If the cause is an outside dependency, follow its runbook; if it is module code, hand off to the owner. 3. Confirm the expression returns empty after the fix.
**Escalate when:** not resolved within 30 min, or the cause is in module code → the C3 owner via the LIMS provider on-call.
**Close-out:** `ops-note.sh` line with alert name, tenant id (UUID only) if any, cause and action; incident record for any page longer than 30 min.

## CatalogNoPriceSpike
Severity: warn   Owner: C3   Last tested: never (new in T-21)
**Means:** More than 5 % of priceFor calls return no_price for 15 min.  **Impact:** the Catalog & pricing module's users or the on-call see degraded behaviour until fixed.
**Check first:** Prometheus query `sum(rate(lims_catalog_port_calls_total{method="priceFor",outcome="no_price"}[15m])) / sum(rate(lims_catalog_port_calls_total{method="priceFor"}[15m])) > 0.05` (expect: empty when healthy); Grafana D15-catalog panel for the metric.
**Fix:** 1. Read the module's error logs in VictoriaLogs around the alert start (no PHI is logged). 2. If the cause is an outside dependency, follow its runbook; if it is module code, hand off to the owner. 3. Confirm the expression returns empty after the fix.
**Escalate when:** still firing after one working day → the C3 owner.
**Close-out:** `ops-note.sh` line with alert name, tenant id (UUID only) if any, cause and action; incident record for any page longer than 30 min.

## CatalogNoRangeSpike
Severity: warn   Owner: C3   Last tested: never (new in T-21)
**Means:** More than 5 % of referenceRangeFor calls find no range for 15 min.  **Impact:** the Catalog & pricing module's users or the on-call see degraded behaviour until fixed.
**Check first:** Prometheus query `sum(rate(lims_catalog_port_calls_total{method="referenceRangeFor",outcome="no_reference_range"}[15m])) / sum(rate(lims_catalog_port_calls_total{method="referenceRangeFor"}[15m])) > 0.05` (expect: empty when healthy); Grafana D15-catalog panel for the metric.
**Fix:** 1. Read the module's error logs in VictoriaLogs around the alert start (no PHI is logged). 2. If the cause is an outside dependency, follow its runbook; if it is module code, hand off to the owner. 3. Confirm the expression returns empty after the fix.
**Escalate when:** still firing after one working day → the C3 owner.
**Close-out:** `ops-note.sh` line with alert name, tenant id (UUID only) if any, cause and action; incident record for any page longer than 30 min.

## CatalogPortLatency
Severity: warn   Owner: C3   Last tested: never (new in T-21)
**Means:** Catalog port p95 latency above 50 ms for 10 min.  **Impact:** the Catalog & pricing module's users or the on-call see degraded behaviour until fixed.
**Check first:** Prometheus query `histogram_quantile(0.95, sum by (le) (rate(lims_catalog_port_duration_seconds_bucket[5m]))) > 0.05` (expect: empty when healthy); Grafana D15-catalog panel for the metric.
**Fix:** 1. Read the module's error logs in VictoriaLogs around the alert start (no PHI is logged). 2. If the cause is an outside dependency, follow its runbook; if it is module code, hand off to the owner. 3. Confirm the expression returns empty after the fix.
**Escalate when:** still firing after one working day → the C3 owner.
**Close-out:** `ops-note.sh` line with alert name, tenant id (UUID only) if any, cause and action; incident record for any page longer than 30 min.

## CatalogImportStuck
Severity: warn   Owner: C3   Last tested: never (new in T-21)
**Means:** A catalog import task has been in flight for 15 min.  **Impact:** the Catalog & pricing module's users or the on-call see degraded behaviour until fixed.
**Check first:** Prometheus query `sum(lims_catalog_import_tasks_inflight) > 0` (expect: empty when healthy); Grafana D15-catalog panel for the metric.
**Fix:** 1. Read the module's error logs in VictoriaLogs around the alert start (no PHI is logged). 2. If the cause is an outside dependency, follow its runbook; if it is module code, hand off to the owner. 3. Confirm the expression returns empty after the fix.
**Escalate when:** still firing after one working day → the C3 owner.
**Close-out:** `ops-note.sh` line with alert name, tenant id (UUID only) if any, cause and action; incident record for any page longer than 30 min.

## CatalogContactReadsSpike
Severity: warn   Owner: C3   Last tested: never (new in T-21)
**Means:** Notification contact reads in the last hour above 10x the 7-day hourly median.  **Impact:** the Catalog & pricing module's users or the on-call see degraded behaviour until fixed.
**Check first:** Prometheus query `sum(increase(lims_catalog_contact_reads_total{purpose="notification"}[1h])) > 10 * quantile_over_time(0.5, sum(increase(lims_catalog_contact_reads_total{purpose="notification"}[1h]))[7d:1h])` (expect: empty when healthy); Grafana D15-catalog panel for the metric.
**Fix:** 1. Read the module's error logs in VictoriaLogs around the alert start (no PHI is logged). 2. If the cause is an outside dependency, follow its runbook; if it is module code, hand off to the owner. 3. Confirm the expression returns empty after the fix.
**Escalate when:** still firing after one working day → the C3 owner.
**Close-out:** `ops-note.sh` line with alert name, tenant id (UUID only) if any, cause and action; incident record for any page longer than 30 min.
