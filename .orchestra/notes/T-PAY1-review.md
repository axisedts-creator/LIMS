APPROVE

Reviewed `922cae23..HEAD` (T-PAY1) against 02-TRD §4.7 / §5 E41-E42 / §6.2 / §8.1-8.2, 05-SCHEMA payment_requests, 03-APP-FLOW §5.3 + §10.1 A15, 01-PRD US-EN-10.1-10.6, 07-SECURITY REQ-SEC-046/059, contracts/openapi/engagement.yaml (createPaymentRequest/getPaymentRequest).
- Names verbatim: routes, operationIds, `engagement.payment.create`, task ids, job keys `pay:`/`payref:`, cron `*/10` per_tenant, constraint/index names, failure texts.
- Tenant isolation: every statement filtered by tenant_id + account_id; foreign/unknown id -> same 404 (P-L1); worker tasks ignore a foreign-tenant payload. RLS/DDL not in this diff (schema owned elsewhere); real-Postgres RLS untested (noted by writer).
- Permission check before any query; Idempotency-Key required enforced by core (idempotency.ts); rate tier/errors match openapi x-error-codes; body with any key but `gateway` -> validation_failed (amount rejected, US-EN-10.6).
- Only system actor calls PaymentProviderPort (08 R8); Paid only on `settled` -> `completed`; action_json scrubbed on leaving ready; eSewa fields not stored; no action URL / port error text in logs.
- App: outcome query never read; https-only open, once; LD-140 lims_ui + tokens only; LimsSecureScreen.
- Ran: API payment.handlers 29/29, worker payment.tasks 30/30, flutter test/features/payments 51/51 - all pass.
- Non-blocking (out of T-PAY1 ownership): `/payments/:id/done` route + A11 "Pay" entry; metric `lims_engagement_payment_requests_total` not emitted.
