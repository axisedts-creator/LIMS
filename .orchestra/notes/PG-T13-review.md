APPROVE
- Scope: diff 25f9c998..HEAD = PG-T13 tests (LD-122 recreation) + additive helper edits (merchantDb, portHarness, worker reconcileHarness) + notes. Owned payments test paths only; no impl/spec touched.
- Re-ran `.orchestra/notes/PG-T13-verify.cmd` commands: api 55/55, worker 48/48.
- Coverage vs done_when/AC-PG-08.1–08.9: every TRD §6.7 kind incl. ledger_entry_missing repair refused on billing.payment_exceeds_due (auto none, no retry, P-44 marker rolled back), refund_unconfirmed at count 2, gateway_unreachable at 3 transients; batches <=50 own jobs/keys; cron/manual business_date (Kathmandu); stalled rule (strict >2 h, error_code stalled); one-running (reconciliation_runs__tenant_id_running__p_uq -> payments.reconciliation_in_progress); 26 h metric lims_payments_reconciliation_last_success_timestamp_seconds; findings_total{kind,severity}; P16 access log payment_intent.resolve (code only, no note).
- Names checked verbatim vs 05-SCHEMA §6 / TRD §6.7, §11. Tenant isolation exercised (fake RLS). Synthetic data, no secrets.
- Not verified (accepted, noted by tester): real PG/graphile races, route permission/aal, stalled gauge (PG-T20).
