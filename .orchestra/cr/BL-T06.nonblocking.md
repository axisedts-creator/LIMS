Title: CR-C4-BL06-001: ReleaseEligibilityDto.basis enum lacks due_outstanding / no_invoice (B7 not-eligible answers fail the response schema)
From chunk: C4            To owner: C0-0B (contracts/openapi/billing.yaml)
Type: api
Blocking? no (BL-T06 is implemented and tested; B7 returns the correct TRD §6.2 basis, but for an order with a balance due the stage-12 response check would reject it until this lands)
Problem: `ReleaseEligibilityDto.basis` (billing.yaml, maxLength 19) enumerates only paid_in_full, zero_balance, credit_party, override, policy_not_enforced. 02-TRD §6.2 rules 4 and 6 return `no_invoice` and `due_outstanding` (not eligible), and contracts/events/billing.balance.changed.v1 + 05-SCHEMA order_balances__basis__ck already list both. B7 `getOrderBilling.eligibility` (and B16/B17 later) cannot describe an unpaid order. Serves US-FD-03.1, US-BL-06.1.
Proposed change (exact): billing.yaml ReleaseEligibilityDto.basis enum += `due_outstanding`, `no_invoice` (maxLength 19 already fits both).
Backward compatible? yes (enum widened; consumers must treat unknown basis as not eligible).
Tenant/security impact: none (no new field, no PHI).
IRD/regulatory impact: none.
Alternatives considered: map not-eligible to a different basis (wrong: loses the reason); omit `basis` (it is required).
Tests that will prove it: C0 contract test of B7 with an invoice and no payment validates against the response schema.

Also noted for the owner of the next print/cancel task (no CR needed yet): `printed_by_display` (B37) and `cancelled_by_display` (B2) have no name source in C4 (print_log / invoices hold only user ids; IdentityPort has no id->name call for them). BL-T06 returns the fixed label "Staff user" ([CONV], invoiceRead.service.ts STAFF_DISPLAY). If real names are wanted, a port call (e.g. IdentityPort.getSignatories-like by user id) is a separate CR.
