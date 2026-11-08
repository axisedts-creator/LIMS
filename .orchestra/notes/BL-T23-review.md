CHANGES

Re-review after 92be2a04. All 7 earlier fixes applied correctly (audit_trail, cbms, credit_parties, dues, invoices, registers, worklist). bl-t23 vitest 25/25 passes (re-run by reviewer). Remaining Ctrl+Enter lines checked against code: invoice.md (InvoiceDetailView.tsx:190,225), daily_cash.md + cash-shift.md (DailyCashView.tsx:111), settings.md (BillingSettingsForm.tsx:65), worklist.md (FinanceWorklist.tsx:124,153) are all real. Scope, IRD neutrality, no PHI/secrets: still OK.

One invented shortcut is left (missed in the first pass):

1. apps/web/src/features/billing/help/credit_party.md:21 – delete the line "`Ctrl+Enter` – save a form on the Terms tab." CreditPartyDetail.tsx:2 says the Terms tab is a read view; it has no form and no Ctrl+Enter button (no `shortcut=` in that file). For the same reason, on line 7 change "Changes to the terms are recorded in the audit trail." so it does not suggest the terms can be edited here, for example: "Changes to the terms, made elsewhere, are recorded in the audit trail." Or drop the sentence.
(If a later task adds terms editing, the line can come back in that task.)
