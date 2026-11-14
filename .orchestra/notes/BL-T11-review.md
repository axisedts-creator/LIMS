APPROVE

Re-review of 58531f19..70bcaaac (after review fixes b6eb050e, 70bcaaac).

1. Fixed: invented credit-order refusal removed from refund.service.ts. New tests 8b (credit, refundable > 0, so 750.00 is pending and 750.01 gets 409) and 8c (credit, refundable <= 0, so 409 `billing.ledger_reversal_invalid` and nothing stored) cover it.
2. Fixed: `.orchestra/cr/BL-T11.md` filed in template form. It covers the gateway-method marker and C15-live detection for B10 `common.feature_disabled`, the B36 'refunded' rule without `refund_ledger_entry_id`, and the B36 list default status. Non-blocking. Nothing invented.

Checks run: BL-T11 suite (6 files), 134/134 pass. tsc reports 0 errors in BL-T11 files. Existing TS2835 errors in contracts/ports/* are outside this chunk and not from this task.

Notes (non-blocking, carried over):
- The renames of C6-T20/T0D-09 to *.resolved-* in eea6d890 are still present. The lead should confirm they made them.
- Not verified: real SQL, RLS and the guard trigger (fakes only). Idempotency and the 40P01 retry rely on the core pipeline.
