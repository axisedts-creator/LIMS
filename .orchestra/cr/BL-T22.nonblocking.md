Title: CR-C4-BL-T22: Wire C4 alert rule files into C1 alerting (02-TRD §15, 08 A13 P-14)
From chunk: C4            To owner: C1
Type: port
Blocking? no (rule files are done; wiring is C1's)
Problem: TRD §15 requires 9 alert rules for C4. C4 owns the rule files; C1 owns the Prometheus/receiver wiring, so C1 must load them.
Proposed change (exact): load every rule file in `services/worker/src/jobs/billing/alerts/*.yaml` and `services/worker/src/jobs/frontdesk/alerts/*.yaml`; map `route` labels to receivers (on-call, security, finance, tenant-admin); run the two `db_rule_*`/`annotations.query` rules (SQL over `audit.access_log` / `billing.activity_log`) in C1's SQL-alert runner.
Rules:
| Alert | File | Severity | Route |
|---|---|---|---|
| BillingIntegrityViolation | billing/alerts/integrity.rules.yaml | page | on-call |
| BillingCounterBusy | billing/alerts/integrity.rules.yaml | warn | on-call |
| BillingNumberingPatternInvalid | billing/alerts/integrity.rules.yaml | warn | on-call + tenant-admin |
| BillingCbmsPendingOverOneHour | billing/alerts/cbms.rules.yaml | page | oncall-email |
| BillingCbmsTenAttemptsStillPending | billing/alerts/cbms.rules.yaml | warn | ops-digest-email |
| BillingExportsPerUser | billing/alerts/integrity.rules.yaml | warn | security |
| BillingRefundsPerTenant | billing/alerts/integrity.rules.yaml | warn | finance + security |
| FrontdeskTrfQuarantineBurst | frontdesk/alerts/frontdesk.rules.yaml | warn | on-call |
| FrontdeskPatientSearchVolumePerUser | frontdesk/alerts/frontdesk.rules.yaml | warn | security |
(paths under `services/worker/src/jobs/`)
Backward compatible? yes
Tenant/security impact: none on RLS; no PHI in labels (tenant_id only). REQ-SEC-045.
IRD/regulatory impact: none.
Alternatives considered: per-user metric labels (rejected, 02-CV §9.4 cardinality).
Tests that will prove it: `services/api/src/modules/billing/__tests__/probes/alerts.rules.test.ts`.
