# BL-T05 impl (writer)
Files: service/quote.service.ts (new), service/settings.service.ts (new), handlers/settings.handlers.ts (new), handlers/index.ts (3 ops wired), repository/settings.repo.ts (+insertDefault, update, hasInvoiceInFiscalYear, listCodes).
Run: billing vitest 16 files pass / 413 tests (20 skipped, pre-existing); tsc --noEmit clean for modules/billing; eslint not installed in services/api (not run).
[CONV] quote: bill discounts sequential (percent applies to what earlier bill discounts left); line percent on the orderable row's remaining; duplicate lineRef / non-NPR / exempt-with-vatRateBp -> common.validation_failed; empty lines allowed (zero totals); echoes only PricedLineInput keys.
[CONV] settings: PUT accepts a partial body (absent key keeps column; `version` ignored); scope check runs when patch sets `branch` (pattern needs /\{branch(:\d+)?\}/ via IdentityPort numbering, missing port -> refused) and on any scope switch (invoice in current B.S. FY -> refused); field error code common.field_invalid.
[CONV] listBillingCodes: payment_methods reads billing.cs_payment_methods/g_cs_payment_methods, other sets billing.cs_reasons/g_cs_reasons; tenant row overrides global; inactive dropped.
Open: FY-switch check is read-then-update (no row lock vs concurrent invoice issue); no live-DB test of repo SQL or RLS.
