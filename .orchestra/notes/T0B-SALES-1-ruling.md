TESTS_WRONG — the mkInvoice fixture inserts values the billing schema forbids; fix the fixture only, assertions unchanged.
1. Fingerprint shape is sha256 hex: spec/chunks/C4-frontdesk-billing/02-TRD.md:245 ("fingerprint (64 hex ...)") and :417 ("sha256 hex"); enforced by db/migrations/20261105001700_billing__create_billing_schema.sql:115 invoices__fp__ck '^[0-9a-f]{64}$'. Fixture value 'synthetic' (services/api/src/modules/partners/__tests__/sales/helpers.ts:130) can never insert.
2. invoice_seq must be >= 1 (same migration :94 invoices__seq__ck); helpers.ts:127 Math.floor(Math.random()*2e9) can yield 0.
3. session_replication_role='replica' disables triggers only, not CHECK constraints, so the earlier replica fix (ruling 55c3ab50a) does not cover these.
4. Nothing in T0C-SALES-1 / T0B-SALES-1 brief requires the implementation to accept invalid invoices; the outstanding/last-bill-date assertions in assignments.test.ts stay as written.
CHANGE (test fixture helpers.ts mkInvoice only):
- quote_fingerprint: crypto.randomBytes(32).toString('hex') (or '0'.repeat(64)).
- invoice_seq: 1 + Math.floor(Math.random() * 2e9).
No assertion deleted, skipped or loosened. Implementation stays as is.
