# BL-T09 impl (writer)
Files: service/invoice.service.ts (print, printCreditNote), service/invoiceRead.service.ts (export totalsOf/lineOf), repository/printLog.repo.ts (insertPrintLog), repository/creditNotes.repo.ts (markCreditNotePrinted, listCreditNoteLines), repository/index.ts (+8 seams), handlers/invoice.handlers.ts + index.ts (printInvoice/printCreditNote replace 503 stubs).
Number = `UPDATE … print_count = print_count + 1, version = version + 1 (review fix, 03-APP-FLOW §2.10) … RETURNING` under the row lock; is_copy = print_no > 1 whatever reason_code (A6). All in ctx.tx; port reads (settings, branding images) happen before the lock; row re-read after it.
[CONV] credit_note_lines has no line_no: listCreditNoteLines joins invoice_lines for it (ORDER BY line_no). cancelled_banner = "CANCELLED" (spec fixes only the word). No balance row -> payment_block 0/0.
[CONV] Branding image read failure aborts the print (rolled back, error propagates): spec silent. Missing IdentityPort.assertRole/readBrandingAsset or ctx.audit.access -> common.internal, nothing written.
[CONV] Invoice line `credited` is queried (sumCreditedByLine) only when credited_total_paisa > 0.
Ran: 5 BL-T09 files 72 pass / 4 skipped (live, needs LIMS_TEST_DATABASE_URL); billing suite 816 pass / 49 skipped (after review fix); no tsc errors in touched files (repo-wide tsc has pre-existing errors in contracts/ + packages/).
Open: live SQL (UPDATE/INSERT/credit-note-lines JOIN) and RLS unrun; no linter script in services/api.
