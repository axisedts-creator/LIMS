APPROVE

Scope: `git diff f1fb9b2e..HEAD` (C6-T24). Checked against 02-TRD §6.1 CriticalAlert (l.552), §6.2 R18 (l.576), §7.2 step 5 (l.723-726), §8.2 consumer row (l.794); 01-PRD AC-14.1-14.3; arbiter ruling C6-T24-ruling.md; contracts/openapi/reporting.yaml listCriticalAlerts.

- Names verbatim: `lab.critical_value.detected.v1`, `critical_value_alert`, `reporting.critical_value_alert`, params `lab_name`/`lab_phone`/`ref`, key `<critical_event_id>:<recipient_kind>:<recipient_id>`, `listCriticalAlerts`, `reporting.report.read`, `common.invalid_cursor`, `deliveries__tenant_id_purpose_created_at__idx`. lab_name/lab_phone source = `branding.displayName` / `branding.phones[0]` per ruling.
- Tenant isolation: every statement has `tenant_id = $1`; `ANY($2::uuid[])`; centre scope via deliveries RLS (per TRD); event tenant mismatch throws (`tenantFor`). No new tables/migrations.
- No value/analyte/patient name/destination selected or returned by R18; consumer copies none into rows/logs/jobs (tests probe with sentinels).
- Idempotency: per-recipient key; redelivery and added-recipient cases tested. Failing dependency propagates (retry), no partial rows.
- Rate tier `general`, `x-idempotency: none` from contract; handler adds no deviation.
- Tests run by reviewer: api critical-alerts.handlers.test.ts 32/32 pass; worker critical_value.consumer.test.ts 26/26 pass.

Non-blocking notes (no change required for T24):
1. TRD l.726 "staff: the membership must be active (`ctx.core.membership`)" is not checked (writer flagged it open). Worker JobContext exposes no membership facility today; only `staff_assignments.is_active` is honoured. Carry as open point / CR if the worker needs it.
2. R18 `alerted_at` = earliest delivery inside the `since` window; a group whose first row is older than `since` (recipient added on a later redelivery) shows a later alerted_at and partial recipients. Edge case of [CONV] in-memory grouping.
3. Real PG FORCE-RLS centre scoping and EXPLAIN on the index not exercised (fake DB only) — covered by the T33-style review-fix pass (o).
