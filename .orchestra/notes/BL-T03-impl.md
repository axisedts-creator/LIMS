# BL-T03 impl (writer)
Files: services/api/src/modules/billing/repository/{invoices,invoiceLines,creditNotes,counters,ledger,balances,overrides,cashSessions,creditAccounts,creditCharges,printLog,activity,cbms,exports,settings,creditNoteTasks}.repo.ts
Real logic: counters.bumpCounter (one bound `last_no = last_no + 1`, open counters only), invoices.getInvoice/markInvoicePrinted (+ P0001 immutable_row on billing.invoices -> 409 billing.invoice_immutable, other errors raw), ledger.insertLedgerEntry/listLedgerForInvoice (INSERT/SELECT only). Other 11 files: one tenant-scoped read each; writes land with their services (BL-T06+).
[CONV] repos take `Pick<Tx,'query'>`; bound `$n` SQL only; error remap lives in invoices.repo (only owned path).
Run: vitest billing/repository/__tests__ -> 41 pass, 1 FAIL (static:78, test bug, see BL-T03-dispute.md), live suite skipped (no DB, not run).
Open: dispute above; creditNotes/ledger P0001 remap not added (no test requires it, no write fns yet).
