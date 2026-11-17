Title: CR-C4-FD-T09-001: BillingCommandPort.issueOrderInvoice returns ids + totals only, but F13 `supplementary_invoice` is a full InvoiceDto
From chunk: C4 To owner: C4 billing (BillingCommandPort, 03-INTERFACE-CATALOG) / C4 contracts
Type: port
Blocking? no (FD-T09 composes the DTO in C4 and marks every composed value [CONV] in order.service.ts `supplementaryDto`)
Problem: `ChangeOrderItemsResult.supplementary_invoice` is `InvoiceDto` (required: invoice_seq, series, status, is_active, invoice_date_bs, seller, lines[] with line ids, credited_total, print_count, cbms_state, version). `IssuedInvoiceRef` = {invoiceId, invoiceNo, fiscalYearBs, issuedAt, totals}. C4 therefore generates InvoiceLine ids itself (they do not exist in billing), derives invoice_seq from the trailing number of invoice_no, hard-codes series 'INV' / status 'issued' / version 1, and takes the seller from TenantSettings.branding + ird.pan. The buyer PAN is unknown to F13 (not stored on orders), so it is omitted.
Proposed change (exact): extend `IssuedInvoiceRef` (or add `BillingCommandPort.getInvoice(ctx,{invoiceId}) -> InvoiceDto`-shaped data) with series, invoiceSeq, invoiceKind, status, invoiceDateBs, seller {name, pan?, address?}, cbmsState, version and lines[{id, lineNo, lineRef}]; F9 `invoice` would use the same data.
Backward compatible? yes (additive fields)
Tenant/security impact: none (same tenant data the invoice print already shows).
IRD/regulatory impact: invoice line ids shown to the client must be the real billing ids or later credit-note / print calls on them would 404.
Alternatives considered: keep composing in C4 (current, ids are not real); return the invoice id only and let the client GET the invoice (schema change).
Tests that will prove it: FD-T09 change.test.ts 'cash: a SUPPLEMENTARY invoice' (schema + line ids equal billing's).
