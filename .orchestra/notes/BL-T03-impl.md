# BL-T03 impl (writer)
Files: services/api/src/modules/billing/repository/{invoices,invoiceLines,creditNotes,counters,ledger,balances,overrides,cashSessions,creditAccounts,creditCharges,printLog,activity,cbms,exports,settings,creditNoteTasks}.repo.ts (unchanged since 39b236a; not reformatted per ruling)
Real logic: counters.bumpCounter (one bound `last_no = last_no + 1`, open counters only), invoices.getInvoice/markInvoicePrinted (+ P0001 immutable_row on billing.invoices -> 409 billing.invoice_immutable, other errors raw), ledger.insertLedgerEntry/listLedgerForInvoice (INSERT/SELECT only). Other 11 files: one tenant-scoped read each; writes land with their services (BL-T06+).
[CONV] repos take `Pick<Tx,'query'>`; bound `$n` SQL only; error remap lives in invoices.repo (only owned path).
Run (after ruling fix a36ec49): vitest billing/repository/__tests__ -> 42 pass, 20 skipped (live suite, no DB). tsc: 0 billing errors (2 pre-existing outside chunk: contracts/ports/IdentityPort.ts, packages/shared-ts bsdate).
Open: live immutability suite not run (needs LIMS_TEST_DATABASE_URL/LIMS_TEST_APP_DATABASE_URL); creditNotes/ledger P0001 remap not added (no write fns yet).
