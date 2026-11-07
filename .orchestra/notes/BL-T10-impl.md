# BL-T10 impl (writer)
Files: service/invoice.service.ts (cancel, credit), domain/creditSplit.ts (new), repository/{creditNotes,creditNoteTasks,invoices,index}.ts, events/publish.ts (invoiceCancelled), service/invoiceRead.service.ts (listCreditNoteTasks, getCreditNote), handlers/{invoice.handlers,index}.ts (B4 200, B5 201, B35).
[CONV] state check (404 -> 409 already_cancelled -> 422 reason_required) comes after the shape check (400) and before numbering; pattern dry-run before allocate; CN allocated LAST.
[CONV] cancel with nothing left to credit -> `billing.invoice_immutable` (409); unique cancellation index violation -> `billing.invoice_already_cancelled`; open task not of this invoice / not open -> 400 `/resolves_task_ids/i`.
[CONV] component split = proportional to the line's REMAINING, largest remainder; last credit takes the exact remainder (no drift). cancel resolves all open tasks of the invoice; activity: `invoice_cancelled` (cancel) / `credit_note_issued` (partial), details carry codes only.
Open: If-Match / Idempotency-Key left to the core pipeline (not read here); services built per request in the handlers (no module wiring yet); B35 cursor ms precision (ponytail comment).
Result: 1 dispute (BL-T10-dispute.md); all other BL-T10 tests and the billing module suite pass; tsc shows no errors under modules/billing (pre-existing contracts/ import errors elsewhere).
