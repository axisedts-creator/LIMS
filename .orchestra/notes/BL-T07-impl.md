# BL-T07 impl (writer)
Files: ports/BillingCommandPort.impl.ts (new; createBillingCommandPort + lazy prod `billingCommandPort`), index.ts (manifest.ports.BillingCommandPort), repository/{creditAccounts,creditCharges,creditNoteTasks,invoiceLines}.repo.ts + repository/index.ts (9 seams the harness pins; listInvoicesByOrder already existed).
Result: contract dir 38/38 pass, billing module 743 pass, ownership lint 10/10, tsc clean for billing. Full services/api run: failures only in analytics/catalog/instruments/lab/reporting (boot timeouts under load, missing fixtures/imports), none in billing.
[CONV] exposure for credit limit = uninvoiced charges (gross-discount, pre-tax: charges hold no tax amounts) + unpaid periodic bills; limit check skipped when account has no limit.
[CONV] upsertCreditAccount is an unconditional ON CONFLICT DO UPDATE so it row-locks the account (serialises concurrent charge batches); `version` untouched.
[CONV] credit_note_tasks has no `required` column (contract text says required = true): row carries it, repo ignores it; `required` is the call result. Tasks need centre_id: from invoice / charge row.
Open: raiseCreditNoteRequirement is not idempotent (a retry adds duplicate open tasks); recordCreditCharges has no replay guard; real SQL/RLS/locking untested (no live DB here).
