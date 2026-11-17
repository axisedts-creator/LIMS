APPROVE

PG-T02 review (reviewer), diff b19a3b40..HEAD.
Checked:
- intent.state.ts == TRD §4.1 I2–I14 + the full "Forbidden" paragraph. refund.state.ts == §4.2 R2–R8. Open sets match REQ-SEC-053 and the refund partial unique index.
- mapping.esewa.ts / mapping.khalti.ts: each cell matches the §7.2.4 / §7.3.4 tables. That includes AMBIGIOUS, the PENDING to_pending/stay split, the Initiated row from CR-C15-001, and the trim + case-sensitive compare. Hold reasons and finding kinds are verbatim from 05-SCHEMA `hold_reasons` / `finding_kinds`.
- Error codes are verbatim from TRD §errors: intent_invalid_transition 409, refund_not_allowed 409, amount_not_supported 422, return_url_not_allowed 422. The URL is not echoed in the error.
- amount.ts uses BigInt with no floats. Golden cases 2250 / 150.0 / 22.5 / 0.001 and Khalti 999 are covered. returnurl.ts follows §6.1 step 1 and §9.1. It fails closed, and the ST-17 variants are covered.
- Not applicable to this task (pure domain, no DB/HTTP): RLS, permissions, idempotency, rate tier. No logging, no PHI, no secrets. Only owned paths are touched (api `payments` module, own notes).
- I ran `pnpm --dir services/api exec vitest run src/modules/payments/__tests__/unit/domain`: 6 files, 419 tests passed.
Non-blocking notes for later tasks (no change needed now):
1. Refund rows in the settled/*refunded column return `finding gateway_refund_unrecorded` unconditionally. The TRD cell says "refunds check / finding". The reconciliation service (PG-T08/T09) must first compare against recorded refunds, or every fully refunded intent will raise a false finding.
2. The "≤ 3 consecutive, then hold(gateway_status_unknown)" rule for eSewa unknown statuses, and the Khalti "Not found." → hold(gateway_not_found) rule, are service-level. Neither is encoded here, so the service tasks must implement and test them.
