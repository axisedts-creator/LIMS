# Instruments / bridge agents runbook (`instruments`)

Owner C7. One section per alert in `monitoring/rules/instruments.rules.yml` (anchors = lower-case alert names, 02-TRD s11.3; template 04-UI-UX s4.2).
Prometheus and Grafana are reached only through ops nginx on wg0. Dashboard: D12 Bridge agent fleet.

## BridgeAgentOffline
Severity: warn   Owner: C1   Last tested: never (new in T-21)
**Means:** Bridge agent {{ $labels.agent_id }} (tenant {{ $labels.tenant_id }}, centre {{ $labels.centre_id }}) offline for 15 min.  **Impact:** the Instruments / bridge agents module's users or the on-call see degraded behaviour until fixed.
**Check first:** Prometheus query `max by (tenant_id, centre_id, agent_id) (lims_instruments_agent_state{state="offline"}) == 1` (expect: empty when healthy); Grafana D12 panel for the metric.
**Fix:** 1. Read the module's error logs in VictoriaLogs around the alert start (no PHI is logged). 2. If the cause is an outside dependency, follow its runbook; if it is module code, hand off to the owner. 3. Confirm the expression returns empty after the fix.
**Escalate when:** still firing after one working day → the C1 owner.
**Close-out:** `ops-note.sh` line with alert name, tenant id (UUID only) if any, cause and action; incident record for any page longer than 30 min.

## BridgeAgentOfflineLong
Severity: page   Owner: C1   Last tested: never (new in T-21)
**Means:** Bridge agent {{ $labels.agent_id }} (tenant {{ $labels.tenant_id }}, centre {{ $labels.centre_id }}) offline for 60 min.  **Impact:** the Instruments / bridge agents module's users or the on-call see degraded behaviour until fixed.
**Check first:** Prometheus query `max by (tenant_id, centre_id, agent_id) (lims_instruments_agent_state{state="offline"}) == 1` (expect: empty when healthy); Grafana D12 panel for the metric.
**Fix:** 1. Read the module's error logs in VictoriaLogs around the alert start (no PHI is logged). 2. If the cause is an outside dependency, follow its runbook; if it is module code, hand off to the owner. 3. Confirm the expression returns empty after the fix.
**Escalate when:** not resolved within 30 min, or the cause is in module code → the C1 owner via the LIMS provider on-call.
**Close-out:** `ops-note.sh` line with alert name, tenant id (UUID only) if any, cause and action; incident record for any page longer than 30 min.

## BridgeAgentBacklog
Severity: warn   Owner: C1   Last tested: never (new in T-21)
**Means:** Bridge agent {{ $labels.agent_id }} (tenant {{ $labels.tenant_id }}) has a backlog for 30 min.  **Impact:** the Instruments / bridge agents module's users or the on-call see degraded behaviour until fixed.
**Check first:** Prometheus query `max by (tenant_id, centre_id, agent_id) (lims_instruments_agent_state{state="backlog"}) == 1` (expect: empty when healthy); Grafana D12 panel for the metric.
**Fix:** 1. Read the module's error logs in VictoriaLogs around the alert start (no PHI is logged). 2. If the cause is an outside dependency, follow its runbook; if it is module code, hand off to the owner. 3. Confirm the expression returns empty after the fix.
**Escalate when:** still firing after one working day → the C1 owner.
**Close-out:** `ops-note.sh` line with alert name, tenant id (UUID only) if any, cause and action; incident record for any page longer than 30 min.

## BridgeAgentDegraded
Severity: warn   Owner: C1   Last tested: never (new in T-21)
**Means:** Bridge agent {{ $labels.agent_id }} (tenant {{ $labels.tenant_id }}) degraded for 30 min.  **Impact:** the Instruments / bridge agents module's users or the on-call see degraded behaviour until fixed.
**Check first:** Prometheus query `max by (tenant_id, centre_id, agent_id) (lims_instruments_agent_state{state="degraded"}) == 1` (expect: empty when healthy); Grafana D12 panel for the metric.
**Fix:** 1. Read the module's error logs in VictoriaLogs around the alert start (no PHI is logged). 2. If the cause is an outside dependency, follow its runbook; if it is module code, hand off to the owner. 3. Confirm the expression returns empty after the fix.
**Escalate when:** still firing after one working day → the C1 owner.
**Close-out:** `ops-note.sh` line with alert name, tenant id (UUID only) if any, cause and action; incident record for any page longer than 30 min.

## BridgeAgentClockOffset
Severity: info   Owner: C1   Last tested: never (new in T-21)
**Means:** Bridge agent {{ $labels.agent_id }} clock offset above 120 s.  **Impact:** the Instruments / bridge agents module's users or the on-call see degraded behaviour until fixed.
**Check first:** Prometheus query `abs(max by (tenant_id, centre_id, agent_id) (lims_instruments_agent_clock_offset_seconds)) > 120` (expect: empty when healthy); Grafana D12 panel for the metric.
**Fix:** 1. Read the module's error logs in VictoriaLogs around the alert start (no PHI is logged). 2. If the cause is an outside dependency, follow its runbook; if it is module code, hand off to the owner. 3. Confirm the expression returns empty after the fix.
**Escalate when:** still firing after one working day → the C1 owner.
**Close-out:** `ops-note.sh` line with alert name, tenant id (UUID only) if any, cause and action; incident record for any page longer than 30 min.

## BridgeAgentMetricsAbsent
Severity: warn   Owner: C1   Last tested: never (new in T-21)
**Means:** No lims_instruments_agent_state series from worker-a/b for 10 min although c7_metrics_live is true.  **Impact:** the Instruments / bridge agents module's users or the on-call see degraded behaviour until fixed.
**Check first:** Prometheus query `absent(lims_instruments_agent_state)` (expect: empty when healthy); Grafana D12 panel for the metric.
**Fix:** 1. Read the module's error logs in VictoriaLogs around the alert start (no PHI is logged). 2. If the cause is an outside dependency, follow its runbook; if it is module code, hand off to the owner. 3. Confirm the expression returns empty after the fix.
**Escalate when:** still firing after one working day → the C1 owner.
**Close-out:** `ops-note.sh` line with alert name, tenant id (UUID only) if any, cause and action; incident record for any page longer than 30 min.

## InstrumentsAgentUpdateFailed
Severity: page   Owner: C7   Last tested: never (new in T-21)
**Means:** A bridge agent update failed in the last 15 min.  **Impact:** the Instruments / bridge agents module's users or the on-call see degraded behaviour until fixed.
**Check first:** Prometheus query `increase(lims_instruments_agent_update_failures_total[15m]) > 0` (expect: empty when healthy); Grafana D12 panel for the metric.
**Fix:** 1. Read the module's error logs in VictoriaLogs around the alert start (no PHI is logged). 2. If the cause is an outside dependency, follow its runbook; if it is module code, hand off to the owner. 3. Confirm the expression returns empty after the fix.
**Escalate when:** not resolved within 30 min, or the cause is in module code → the C7 owner via the LIMS provider on-call.
**Close-out:** `ops-note.sh` line with alert name, tenant id (UUID only) if any, cause and action; incident record for any page longer than 30 min.

## InstrumentsAgentConfigRejected
Severity: page   Owner: C7   Last tested: never (new in T-21)
**Means:** A bridge agent rejected a config in the last 15 min (possible tampering).  **Impact:** the Instruments / bridge agents module's users or the on-call see degraded behaviour until fixed.
**Check first:** Prometheus query `increase(lims_instruments_agent_config_rejections_total[15m]) > 0` (expect: empty when healthy); Grafana D12 panel for the metric.
**Fix:** 1. Read the module's error logs in VictoriaLogs around the alert start (no PHI is logged). 2. If the cause is an outside dependency, follow its runbook; if it is module code, hand off to the owner. 3. Confirm the expression returns empty after the fix.
**Escalate when:** not resolved within 30 min, or the cause is in module code → the C7 owner via the LIMS provider on-call.
**Close-out:** `ops-note.sh` line with alert name, tenant id (UUID only) if any, cause and action; incident record for any page longer than 30 min.

## InstrumentsDeviceAuthFailureSpike
Severity: page   Owner: C7   Last tested: never (new in T-21)
**Means:** Device auth failures above 0.1/s for 5 min (security).  **Impact:** the Instruments / bridge agents module's users or the on-call see degraded behaviour until fixed.
**Check first:** Prometheus query `sum(rate(lims_instruments_device_auth_failures_total[5m])) > 0.1` (expect: empty when healthy); Grafana D12 panel for the metric.
**Fix:** 1. Read the module's error logs in VictoriaLogs around the alert start (no PHI is logged). 2. If the cause is an outside dependency, follow its runbook; if it is module code, hand off to the owner. 3. Confirm the expression returns empty after the fix.
**Escalate when:** not resolved within 30 min, or the cause is in module code → the C7 owner via the LIMS provider on-call.
**Close-out:** `ops-note.sh` line with alert name, tenant id (UUID only) if any, cause and action; incident record for any page longer than 30 min.

## InstrumentsQuarantineRate
Severity: warn   Owner: C7   Last tested: never (new in T-21)
**Means:** More than 5 % of ingested instrument messages quarantined.  **Impact:** the Instruments / bridge agents module's users or the on-call see degraded behaviour until fixed.
**Check first:** Prometheus query `sum(rate(lims_instruments_ingest_messages_total{outcome="quarantined"}[1h])) / sum(rate(lims_instruments_ingest_messages_total[1h])) > 0.05` (expect: empty when healthy); Grafana D12 panel for the metric.
**Fix:** 1. Read the module's error logs in VictoriaLogs around the alert start (no PHI is logged). 2. If the cause is an outside dependency, follow its runbook; if it is module code, hand off to the owner. 3. Confirm the expression returns empty after the fix.
**Escalate when:** still firing after one working day → the C7 owner.
**Close-out:** `ops-note.sh` line with alert name, tenant id (UUID only) if any, cause and action; incident record for any page longer than 30 min.

## InstrumentsAttachmentQuarantined
Severity: page   Owner: C7   Last tested: never (new in T-21)
**Means:** An instrument attachment was quarantined (security).  **Impact:** the Instruments / bridge agents module's users or the on-call see degraded behaviour until fixed.
**Check first:** Prometheus query `increase(lims_instruments_attachment_scans_total{outcome="quarantined"}[15m]) > 0` (expect: empty when healthy); Grafana D12 panel for the metric.
**Fix:** 1. Read the module's error logs in VictoriaLogs around the alert start (no PHI is logged). 2. If the cause is an outside dependency, follow its runbook; if it is module code, hand off to the owner. 3. Confirm the expression returns empty after the fix.
**Escalate when:** not resolved within 30 min, or the cause is in module code → the C7 owner via the LIMS provider on-call.
**Close-out:** `ops-note.sh` line with alert name, tenant id (UUID only) if any, cause and action; incident record for any page longer than 30 min.

## InstrumentsIngestSlow
Severity: warn   Owner: C7   Last tested: never (new in T-21)
**Means:** Instrument ingest batch p95 above 3 s for 15 min.  **Impact:** the Instruments / bridge agents module's users or the on-call see degraded behaviour until fixed.
**Check first:** Prometheus query `histogram_quantile(0.95, sum by (le) (rate(lims_instruments_ingest_batch_duration_seconds_bucket[15m]))) > 3` (expect: empty when healthy); Grafana D12 panel for the metric.
**Fix:** 1. Read the module's error logs in VictoriaLogs around the alert start (no PHI is logged). 2. If the cause is an outside dependency, follow its runbook; if it is module code, hand off to the owner. 3. Confirm the expression returns empty after the fix.
**Escalate when:** still firing after one working day → the C7 owner.
**Close-out:** `ops-note.sh` line with alert name, tenant id (UUID only) if any, cause and action; incident record for any page longer than 30 min.
