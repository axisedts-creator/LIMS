APPROVE

BL-T12 review (diff 7a96165b..HEAD).
- Tests: 5 files / 124 tests green (`.orchestra/notes/BL-T12-verify.cmd` set). IC §4.4 cases 1–10 + 08 cases 11–14 covered on the real impl; gateway rows inserted with collectedByMembershipId null (matches ledger_entries__collector__ck).
- Names verbatim: BillingPortV1 methods/inputs (03-IC §4.4), B14/B15 operationIds + routes (02-TRD §5), error codes billing.amount_mismatch / billing.payment_exceeds_due / billing.ledger_reversal_invalid / auth.forbidden, idempotency key `gw_refund:`+refundId, finance_review_items kind `gateway_payment_exceeds_due`, activity actions payment_recorded / refund_recorded / override_created (all in activity_log__action__ck), release_overrides columns match migration.
- Tenancy: tenant/actor from ctx only; every query filters tenant_id; release_overrides RLS ENABLE+FORCE with `::uuid[]` cast already in migration (no schema change here). Actor guard runs first (patient/portal -> auth.forbidden); B14 requires a user with membership.
- No PHI/secrets: free reason_text never written to activity details. Only C4-owned paths touched.
- Non-blocking (already tracked, outside lane): openapi ReleaseEligibilityDto.basis lacks due_outstanding/no_invoice (.orchestra/cr/BL-T06.nonblocking.md) — B15 response validation needs C0 fix. Real-DB behaviour (RLS, CHECKs, FILTER SQL) untested: fakes only.
