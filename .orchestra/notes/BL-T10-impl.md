# BL-T10 impl (writer)
Files: service/invoice.service.ts (cancel, credit), domain/creditSplit.ts (new), repository/{creditNotes,creditNoteTasks,invoices,index}.ts, events/publish.ts (invoiceCancelled), service/invoiceRead.service.ts (listCreditNoteTasks, getCreditNote), handlers/{invoice.handlers,index}.ts (B4 200, B5 201, B35).
[CONV] state check (404 -> 409 already_cancelled -> 422 reason_required) after the shape check (400), before numbering; pattern dry-run before allocate; CN allocated LAST.
[CONV] component split = proportional to the line's REMAINING, largest remainder; last credit takes the exact remainder. cancel resolves all open tasks of the invoice; activity `invoice_cancelled` / `credit_note_issued`, codes only.
Review fixes: missing/broken creditNoteNoPattern -> `common.internal` (declared on B4/B5; was undeclared numbering_pattern_invalid). Cancel of a fully credited invoice -> `common.validation_failed` /invoice_id (declared) pending `.orchestra/cr/BL-T10.nonblocking.md` (proposes `billing.invoice_immutable` on cancelInvoice).
Open: CR above; If-Match / Idempotency-Key left to the core pipeline; services built per request in handlers; B35 cursor ms precision.
Result: billing suite 663 pass / 45 skipped (live-DB), 0 fail; tsc 0 errors under modules/billing.
