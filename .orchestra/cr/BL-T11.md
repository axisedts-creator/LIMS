Title: CR-C4-BL11: B10 gateway-method marker, B36 'refunded' rule, B36 list default status
From chunk: C4            To owner: C0-0B (schema) + C0-0C (api)
Type: schema | api
Blocking? no (BL-T11 ships without B10 `common.feature_disabled`; B36 accepts 'refunded' without `refund_ledger_entry_id`; B36 list has no default status filter)
Problem (what you cannot do today, with the user story / acceptance criterion it serves):
1. US-BL-06.2 / TRD §5 B10 + §6.5: "gateway methods while C15 is live -> `common.feature_disabled`". `billing.g_cs_payment_methods` / `billing.cs_payment_methods` (05-SCHEMA) have only `code, display, is_cash, requires_reference, sort_order, is_active`. No column identifies a gateway method, and no spec item says how "C15 is live" is detected (env flag? port probe?). Writer may not invent a heuristic (e.g. code IN esewa|khalti|fonepay, or !is_cash).
2. US-BL-09.2 / TRD §5 B36: `resolution_code = refunded` with `refund_ledger_entry_id?` optional. Undefined: must `refunded` require `refund_ledger_entry_id`? Must that entry be `entry_kind = refund` on the same order as the item?
3. TRD §5 B36 GET `/v1/billing/finance-review-items?status=open…`: default when `status` is absent is not stated (open only, or all).
Proposed change (exact):
1. Either add `is_gateway boolean NOT NULL DEFAULT false` to both payment-method tables (seed true for esewa/khalti/fonepay) plus a named flag for "C15 live" (e.g. env `LIMS_PAYMENTS_GATEWAY_ENABLED`), or rule that B10 drops the `common.feature_disabled` case for Phase 1.
2. Rule: `refunded` requires `refund_ledger_entry_id` of a `refund` entry on the item's order, else `common.validation_failed` /refund_ledger_entry_id. (Or: optional, unchecked.)
3. Rule: absent `status` = `open`.
Backward compatible? yes — additive column / clarifications.
Tenant/security impact: none; no RLS change, no PHI, no new surface.
IRD/regulatory impact (billing changes only): none.
Alternatives considered: hard-coding gateway codes (rejected: invented name); `!is_cash` (rejected: cheque/bank transfer are non-cash manual methods).
Tests that will prove it: refund.service.test.ts — gateway method while live -> 403/409 `common.feature_disabled`; financeReview.service.test.ts — 'refunded' without/with foreign entry id per ruling; list with no status returns per ruling.
