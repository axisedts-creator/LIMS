# Monitoring-pipeline alerts (`ops`)

Owner C1. Alerts in `monitoring/rules/ops.rules.yml` (anchors = lower-case alert names, 02-TRD s11.3; template 04-UI-UX s4.2). `TargetDown` is in `host.md#targetdown`. Procedures for a dead monitoring stack are in `monitoring.md`.

## Watchdog
Severity: info   Owner: C1   Last tested: never
Always firing by design (`vector(1)`); informational heartbeat of alerting (04-UI-UX s4 SEV4; T-31 ruling), routed by its own dead-man rule, not by severity.
**Means:** the alerting pipeline works while the alert is received every 6 h. If the mail stops arriving, alerting is broken.  **Impact:** when it stops, other alerts may not reach anyone.
**Check first:** `amtool --alertmanager.url=http://127.0.0.1:9093 alert query alertname=Watchdog` on ops-1 (expect one active alert); the external heartbeat check at site B (LD-45).
**Fix:** 1. Alert absent in Alertmanager: `monitoring.md#prometheus-down`. 2. Alert present but mail missing: `monitoring.md#alertmanager-down` (relay and receiver). 3. Do not silence Watchdog.
**Escalate when:** no Watchdog for 12 h -> secondary on-call; treat as blind operations until fixed.
**Close-out:** ops log line with the gap window and cause.

## MetricCardinalityHigh
Severity: warn   Owner: C1   Last tested: never
**Means:** one metric has more than 5000 series for 10 min (usually an unbounded label such as a user id, URL or tenant-specific value).  **Impact:** Prometheus memory and disk grow; scrapes slow down.
**Check first:** the alert label `metric`; in Prometheus `count by (__name__)({__name__="<metric>"})`, then `topk(10, count by (<label>) (<metric>))` to find the exploding label.
**Fix:** 1. Hand the metric and label to the owner of the exporter or module; the fix is in their code (bound the label). 2. Short term, drop the label with a `metric_relabel_configs` rule in the monitoring role only if the owner agrees. 3. Do not raise the series limit to clear the alert. Never put a patient or tenant identifier into a label.
**Escalate when:** Prometheus memory is above 80 % of its limit -> secondary on-call.
**Close-out:** ops log line with metric, label and owner.
