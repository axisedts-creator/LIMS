# Identity & admin runbook (`identity`)

Owner C2. One section per alert in `monitoring/rules/identity.rules.yml` (anchors = lower-case alert names, 02-TRD s11.3; template 04-UI-UX s4.2).
Prometheus and Grafana are reached only through ops nginx on wg0. Dashboard: D15 Modules / Identity & admin.

## IdentityLoginFailureSpike
Severity: warn   Owner: C2   Last tested: never (new in T-21)
**Means:** Login failures above the platform or per-tenant 5-min limit.  **Impact:** the Identity & admin module's users or the on-call see degraded behaviour until fixed.
**Check first:** Prometheus query `sum(increase(lims_identity_logins_total{outcome="failed"}[5m])) > 50 or max by (tenant_id) (lims_identity_login_failures_by_tenant_5m) > 20` (expect: empty when healthy); Grafana D15-identity panel for the metric.
**Fix:** 1. Read the module's error logs in VictoriaLogs around the alert start (no PHI is logged). 2. If the cause is an outside dependency, follow its runbook; if it is module code, hand off to the owner. 3. Confirm the expression returns empty after the fix.
**Escalate when:** still firing after one working day → the C2 owner.
**Close-out:** `ops-note.sh` line with alert name, tenant id (UUID only) if any, cause and action; incident record for any page longer than 30 min.

## IdentityCredentialStuffing
Severity: page   Owner: C2   Last tested: never (new in T-21)
**Means:** Credential-stuffing pattern: 30+ accounts from 10+ IPs in 15 min.  **Impact:** the Identity & admin module's users or the on-call see degraded behaviour until fixed.
**Check first:** Prometheus query `lims_identity_stuffing_distinct_accounts_15m >= 30 and lims_identity_stuffing_distinct_ips_15m >= 10` (expect: empty when healthy); Grafana D15-identity panel for the metric.
**Fix:** 1. Read the module's error logs in VictoriaLogs around the alert start (no PHI is logged). 2. If the cause is an outside dependency, follow its runbook; if it is module code, hand off to the owner. 3. Confirm the expression returns empty after the fix.
**Escalate when:** not resolved within 30 min, or the cause is in module code → the C2 owner via the LIMS provider on-call.
**Close-out:** `ops-note.sh` line with alert name, tenant id (UUID only) if any, cause and action; incident record for any page longer than 30 min.

## IdentityLoginIpThrottleEngaged
Severity: page   Owner: C2   Last tested: never (new in T-21)
**Means:** The per-IP login failure throttle is engaged.  **Impact:** the Identity & admin module's users or the on-call see degraded behaviour until fixed.
**Check first:** Prometheus query `increase(lims_identity_logins_total{outcome="ip_throttled"}[5m]) > 0 or lims_identity_login_ip_throttles_active > 0` (expect: empty when healthy); Grafana D15-identity panel for the metric.
**Fix:** 1. Read the module's error logs in VictoriaLogs around the alert start (no PHI is logged). 2. If the cause is an outside dependency, follow its runbook; if it is module code, hand off to the owner. 3. Confirm the expression returns empty after the fix.
**Escalate when:** not resolved within 30 min, or the cause is in module code → the C2 owner via the LIMS provider on-call.
**Close-out:** `ops-note.sh` line with alert name, tenant id (UUID only) if any, cause and action; incident record for any page longer than 30 min.

## IdentityPlatformIpDenied
Severity: page   Owner: C2   Last tested: never (new in T-21)
**Means:** A platform login came from a denied IP.  **Impact:** the Identity & admin module's users or the on-call see degraded behaviour until fixed.
**Check first:** Prometheus query `increase(lims_identity_logins_total{outcome="ip_denied"}[5m]) > 0` (expect: empty when healthy); Grafana D15-identity panel for the metric.
**Fix:** 1. Read the module's error logs in VictoriaLogs around the alert start (no PHI is logged). 2. If the cause is an outside dependency, follow its runbook; if it is module code, hand off to the owner. 3. Confirm the expression returns empty after the fix.
**Escalate when:** not resolved within 30 min, or the cause is in module code → the C2 owner via the LIMS provider on-call.
**Close-out:** `ops-note.sh` line with alert name, tenant id (UUID only) if any, cause and action; incident record for any page longer than 30 min.

## IdentitySupportSessionOpened
Severity: info   Owner: C2   Last tested: never (new in T-21)
**Means:** A support session was opened.  **Impact:** the Identity & admin module's users or the on-call see degraded behaviour until fixed.
**Check first:** Prometheus query `increase(lims_identity_support_sessions_opened_total[5m]) > 0` (expect: empty when healthy); Grafana D15-identity panel for the metric.
**Fix:** 1. Read the module's error logs in VictoriaLogs around the alert start (no PHI is logged). 2. If the cause is an outside dependency, follow its runbook; if it is module code, hand off to the owner. 3. Confirm the expression returns empty after the fix.
**Escalate when:** still firing after one working day → the C2 owner.
**Close-out:** `ops-note.sh` line with alert name, tenant id (UUID only) if any, cause and action; incident record for any page longer than 30 min.

## IdentityAuditExportsHigh
Severity: warn   Owner: C2   Last tested: never (new in T-21)
**Means:** A tenant created more than 3 audit exports today.  **Impact:** the Identity & admin module's users or the on-call see degraded behaviour until fixed.
**Check first:** Prometheus query `max by (tenant_id) (lims_identity_audit_exports_tenant_day) > 3` (expect: empty when healthy); Grafana D15-identity panel for the metric.
**Fix:** 1. Read the module's error logs in VictoriaLogs around the alert start (no PHI is logged). 2. If the cause is an outside dependency, follow its runbook; if it is module code, hand off to the owner. 3. Confirm the expression returns empty after the fix.
**Escalate when:** still firing after one working day → the C2 owner.
**Close-out:** `ops-note.sh` line with alert name, tenant id (UUID only) if any, cause and action; incident record for any page longer than 30 min.

## IdentityGoTrueUnavailable
Severity: page   Owner: C2   Last tested: never (new in T-21)
**Means:** More than 20 % of GoTrue requests failing for 5 min.  **Impact:** the Identity & admin module's users or the on-call see degraded behaviour until fixed.
**Check first:** Prometheus query `sum(rate(lims_identity_gotrue_requests_total{outcome="error"}[5m])) / sum(rate(lims_identity_gotrue_requests_total[5m])) > 0.2` (expect: empty when healthy); Grafana D15-identity panel for the metric.
**Fix:** 1. Read the module's error logs in VictoriaLogs around the alert start (no PHI is logged). 2. If the cause is an outside dependency, follow its runbook; if it is module code, hand off to the owner. 3. Confirm the expression returns empty after the fix.
**Escalate when:** not resolved within 30 min, or the cause is in module code → the C2 owner via the LIMS provider on-call.
**Close-out:** `ops-note.sh` line with alert name, tenant id (UUID only) if any, cause and action; incident record for any page longer than 30 min.

## IdentityRefreshFailures
Severity: warn   Owner: C2   Last tested: never (new in T-21)
**Means:** More than 10 session refresh failures in 10 min.  **Impact:** the Identity & admin module's users or the on-call see degraded behaviour until fixed.
**Check first:** Prometheus query `increase(lims_identity_session_resolves_total{outcome="refresh_failed"}[10m]) > 10` (expect: empty when healthy); Grafana D15-identity panel for the metric.
**Fix:** 1. Read the module's error logs in VictoriaLogs around the alert start (no PHI is logged). 2. If the cause is an outside dependency, follow its runbook; if it is module code, hand off to the owner. 3. Confirm the expression returns empty after the fix.
**Escalate when:** still firing after one working day → the C2 owner.
**Close-out:** `ops-note.sh` line with alert name, tenant id (UUID only) if any, cause and action; incident record for any page longer than 30 min.

## IdentityBreachedListMissing
Severity: page   Owner: C2   Last tested: never (new in T-21)
**Means:** The breached-password list is not loaded in production.  **Impact:** the Identity & admin module's users or the on-call see degraded behaviour until fixed.
**Check first:** Prometheus query `lims_identity_breached_list_loaded{env="production"} == 0` (expect: empty when healthy); Grafana D15-identity panel for the metric.
**Fix:** 1. Read the module's error logs in VictoriaLogs around the alert start (no PHI is logged). 2. If the cause is an outside dependency, follow its runbook; if it is module code, hand off to the owner. 3. Confirm the expression returns empty after the fix.
**Escalate when:** not resolved within 30 min, or the cause is in module code → the C2 owner via the LIMS provider on-call.
**Close-out:** `ops-note.sh` line with alert name, tenant id (UUID only) if any, cause and action; incident record for any page longer than 30 min.

## IdentityDeadLetter
Severity: page   Owner: C2   Last tested: never (new in T-21)
**Means:** An identity job dead-lettered.  **Impact:** the Identity & admin module's users or the on-call see degraded behaviour until fixed.
**Check first:** Prometheus query `increase(lims_core_dead_letters_total{task=~"identity\\..*"}[5m]) > 0` (expect: empty when healthy); Grafana D15-identity panel for the metric.
**Fix:** 1. Find the dead letter in the C2 platform console (dead letters, filter by task). 2. Read the error in VictoriaLogs (`dead_letter_created`, same task, last 30 min). 3. Fix the cause, then replay from the console; never edit rows by hand (see `runtime.md`).
**Escalate when:** not resolved within 30 min, or the cause is in module code → the C2 owner via the LIMS provider on-call.
**Close-out:** `ops-note.sh` line with alert name, tenant id (UUID only) if any, cause and action; incident record for any page longer than 30 min.
