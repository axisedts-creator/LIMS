# BL-T06 impl (writer)
Files (billing/): events/publish.ts; service/{balance,invoice,invoiceRead}.service.ts; handlers/{invoice.handlers,index}.ts; domain/money/paisa.ts; repository/index.ts (seam) + added fns in {invoices,invoiceLines,balances,overrides,activity,cbms,printLog}.repo.ts. No test files touched.
[CONV] order_balances upsert is optimistic (applies only on version-1, else common.version_conflict); readOrderTotals derives billing_mode/centre_id from the stored row, invoice or credit charge (no frontdesk table read).
[CONV] LD-25 entry validated before the counter; max-hours key requested from IdentityPort only for back-entry; values audited in the activity row only (no invoices column, no CR needed); nothing back-dated reaches events/CBMS.
[CONV] seller_name = branding.legalName ?? displayName; CBMS required unless ird.cbmsRealtimeRequired === false; abbreviated kind only if enabled + no buyer PAN + net <= ird.abbreviatedInvoiceLimitPaisa (03-APP-FLOW).
[CONV] B7 credit_notes/ledger_entries/credit_charges/tasks/review_items/refund_requests are [] until their tasks write rows; printed_by/cancelled_by display = "Staff user".
Open: CR .orchestra/cr/BL-T06.nonblocking.md (ReleaseEligibilityDto.basis enum). Tests: billing 24 files/550 pass, 2 live-DB files skipped; tsc clean for my paths (18 pre-existing errors in contracts/ + shared-ts); eslint ignores services/api (not run).
Not verified: real DB/RLS, SQL text of the new repo fns (fakes only), 200-way concurrency.
