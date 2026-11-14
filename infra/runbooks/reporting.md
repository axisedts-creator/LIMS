# Reporting & delivery runbook (`reporting`)

Owner C6. One section per alert in `monitoring/rules/imported/reporting.rules.yml` (anchors = lower-case alert names, 02-TRD s11.3; template 04-UI-UX s4.2).
Prometheus and Grafana are reached only through ops nginx on wg0. Dashboard: D15 Modules / Reporting & delivery.

## ReportingRenderFailureRate
Severity: warn   Owner: C6   Last tested: never (new in T-21)
**Means:** More than 5 % of report renders failed over 15 min.  **Impact:** the Reporting & delivery module's users or the on-call see degraded behaviour until fixed.
**Check first:** Prometheus query `sum(increase(lims_reporting_render_failures_total[15m])) / clamp_min(sum(increase(lims_reporting_versions_total[15m])), 1) > 0.05` (expect: empty when healthy); Grafana D15-reporting panel for the metric.
**Fix:** 1. Read the module's error logs in VictoriaLogs around the alert start (no PHI is logged). 2. If the cause is an outside dependency, follow its runbook; if it is module code, hand off to the owner. 3. Confirm the expression returns empty after the fix.
**Escalate when:** still firing after one working day → the C6 owner.
**Close-out:** `ops-note.sh` line with alert name, tenant id (UUID only) if any, cause and action; incident record for any page longer than 30 min.

## ReportingDeliveryFailureRate
Severity: warn   Owner: C6   Last tested: never (new in T-21)
**Means:** More than 20 % of report deliveries failed on one channel over 1 h.  **Impact:** the Reporting & delivery module's users or the on-call see degraded behaviour until fixed.
**Check first:** Prometheus query `sum by (channel) (increase(lims_reporting_deliveries_total{status="failed"}[1h])) / clamp_min(sum by (channel) (increase(lims_reporting_deliveries_total[1h])), 1) > 0.2` (expect: empty when healthy); Grafana D15-reporting panel for the metric.
**Fix:** 1. Read the module's error logs in VictoriaLogs around the alert start (no PHI is logged). 2. If the cause is an outside dependency, follow its runbook; if it is module code, hand off to the owner. 3. Confirm the expression returns empty after the fix.
**Escalate when:** still firing after one working day → the C6 owner.
**Close-out:** `ops-note.sh` line with alert name, tenant id (UUID only) if any, cause and action; incident record for any page longer than 30 min.

## ReportingOtpVerifyBruteForce
Severity: warn   Owner: C6   Last tested: never (new in T-21)
**Means:** More than 50 OTP verify failures for one tenant in 1 h.  **Impact:** the Reporting & delivery module's users or the on-call see degraded behaviour until fixed.
**Check first:** Prometheus query `sum by (tenant_id) (increase(lims_reporting_otp_verify_failures_total[1h])) > 50` (expect: empty when healthy); Grafana D15-reporting panel for the metric.
**Fix:** 1. Read the module's error logs in VictoriaLogs around the alert start (no PHI is logged). 2. If the cause is an outside dependency, follow its runbook; if it is module code, hand off to the owner. 3. Confirm the expression returns empty after the fix.
**Escalate when:** still firing after one working day → the C6 owner.
**Close-out:** `ops-note.sh` line with alert name, tenant id (UUID only) if any, cause and action; incident record for any page longer than 30 min.

## ReportingQrEnumeration
Severity: warn   Owner: C6   Last tested: never (new in T-21)
**Means:** More than 500 QR verify lookups not found in 1 h (enumeration).  **Impact:** the Reporting & delivery module's users or the on-call see degraded behaviour until fixed.
**Check first:** Prometheus query `sum(increase(lims_reporting_qr_verify_total{outcome="not_found"}[1h])) > 500` (expect: empty when healthy); Grafana D15-reporting panel for the metric.
**Fix:** 1. Read the module's error logs in VictoriaLogs around the alert start (no PHI is logged). 2. If the cause is an outside dependency, follow its runbook; if it is module code, hand off to the owner. 3. Confirm the expression returns empty after the fix.
**Escalate when:** still firing after one working day → the C6 owner.
**Close-out:** `ops-note.sh` line with alert name, tenant id (UUID only) if any, cause and action; incident record for any page longer than 30 min.

## ReportingRendererBlockedRequest
Severity: page   Owner: C6   Last tested: never (new in T-21)
**Means:** The renderer blocked an outbound request (possible template injection).  **Impact:** the Reporting & delivery module's users or the on-call see degraded behaviour until fixed.
**Check first:** Prometheus query `increase(lims_renderer_blocked_requests_total[5m]) > 0` (expect: empty when healthy); Grafana D15-reporting panel for the metric.
**Fix:** 1. Read the module's error logs in VictoriaLogs around the alert start (no PHI is logged). 2. If the cause is an outside dependency, follow its runbook; if it is module code, hand off to the owner. 3. Confirm the expression returns empty after the fix.
**Escalate when:** not resolved within 30 min, or the cause is in module code → the C6 owner via the LIMS provider on-call.
**Close-out:** `ops-note.sh` line with alert name, tenant id (UUID only) if any, cause and action; incident record for any page longer than 30 min.

## ReportingSandboxRejectionSpike
Severity: warn   Owner: C6   Last tested: never (new in T-21)
**Means:** More than 20 PDF sandbox rejections in 1 h.  **Impact:** the Reporting & delivery module's users or the on-call see degraded behaviour until fixed.
**Check first:** Prometheus query `sum(increase(lims_reporting_sandbox_rejections_total[1h])) > 20` (expect: empty when healthy); Grafana D15-reporting panel for the metric.
**Fix:** 1. Read the module's error logs in VictoriaLogs around the alert start (no PHI is logged). 2. If the cause is an outside dependency, follow its runbook; if it is module code, hand off to the owner. 3. Confirm the expression returns empty after the fix.
**Escalate when:** still firing after one working day → the C6 owner.
**Close-out:** `ops-note.sh` line with alert name, tenant id (UUID only) if any, cause and action; incident record for any page longer than 30 min.

## ReportingRendererDown
Severity: page   Owner: C6   Last tested: never (new in T-21)
**Means:** Renderer or PDF sandbox container unhealthy for 2 min.  **Impact:** the Reporting & delivery module's users or the on-call see degraded behaviour until fixed.
**Check first:** Prometheus query `lims_ops_container_health{service=~"renderer|pdf-sandbox"} == 0` (expect: empty when healthy); Grafana D15-reporting panel for the metric.
**Fix:** 1. Read the module's error logs in VictoriaLogs around the alert start (no PHI is logged). 2. If the cause is an outside dependency, follow its runbook; if it is module code, hand off to the owner. 3. Confirm the expression returns empty after the fix.
**Escalate when:** not resolved within 30 min, or the cause is in module code → the C6 owner via the LIMS provider on-call.
**Close-out:** `ops-note.sh` line with alert name, tenant id (UUID only) if any, cause and action; incident record for any page longer than 30 min.
