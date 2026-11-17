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

---

Title: CR-C4-BL06-002: BillingCommandPort.issueOrderInvoice input lacks LD-25 `entry` and the `{branch}` numbering code
From chunk: C4            To owner: C0 (contracts/ports/BillingCommandPort.ts)
Type: api
Blocking? no for BL-T06 (invoice.service.ts `issue()` already accepts and validates both); yes for BL-T07, which implements the port from this C0 type and so cannot pass LD-25 back-entry or a branch-series code through to `issue()`.
Problem: LD-25 (2026-11-07, 08 A33-2 downtime mode, binding for FD-T06/FD-T13/BL-T06) says invoices are issued at back-entry time with the paper receipt number in `downtime_ref`, with `entry_mode` 'live' | 'downtime_backentry' and `occurred_at` (<= now, >= now - downtime_backentry_max_hours, default 72) / `downtime_ref` (<= 32 chars). `issueOrderInvoice` input has no field for this. Separately, a `{branch}` token in the invoice number pattern (numberFormat, series key per branch scope) needs a short branch code, and the port only carries `branchId`; BL-T06 used an interim input `branchCode` (not a spec name; validated against invoices__series__ck `^[A-Za-z0-9_-]{1,20}$`). Serves US-BL-01.1, US-BL-13.1, US-FD-03.1.
Proposed change (exact): `issueOrderInvoice` input += `entry?: { mode: 'live' | 'downtime_backentry'; occurredAt?: IsoUtc; downtimeRef?: string }` (LD-25 / 08 A33-2; absent = live). For the branch code, either (a) input += `branchCode?: string`, or (b) state that billing resolves `{branch}` from `branchId` (e.g. an IdentityPort/settings lookup returning the branch short code) and drop `branchCode` from the input. C0 picks; BL-T06 will follow the chosen name.
Backward compatible? yes (both optional; absent = today's behaviour).
Tenant/security impact: none new; `entry` values are validated server-side and only audited in activity_log (nothing back-dated reaches events or CBMS, per LD-25).
IRD/regulatory impact: tax treatment of hand-written downtime bills is UNVERIFIED per LD-25 (ask the accountant); no CBMS submission carries a back-dated date.
Alternatives considered: frontdesk passes a pre-formatted invoice number (wrong: breaks gapless allocation D-25); back-entry as a separate port method (duplicates the whole issue flow).
Tests that will prove it: BL-T07 port adapter test passing `entry` + branch code through to invoice.issue (invoice.downtime.test.ts limits already cover the service side).
