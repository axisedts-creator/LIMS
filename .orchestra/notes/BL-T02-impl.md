# BL-T02 impl (writer) — 240/242 pass; 2 disputed (see BL-T02-dispute.md)
Files: billing/domain/{money/tax.ts, fiscalYear.ts, numberFormat.ts, invoice/cashSession/creditCharge/cbms/export.state.ts}. No cross-module import (02-CV: frontdesk numbering not reused).
[CONV] tax: VAT per line half-up via shared money.percentOf; other tax on taxable amount; bill discount = shared largest-remainder over (gross - line discount); taxable w/o rate -> catalog.tax_config_missing, other bad input -> common.validation_failed.
[CONV] splitCredit: net split exempt/taxable/vat/other by largest remainder; discount = line.discount * base / lineBase half-up; gross = base + discount.
[CONV] fiscalYearOf accepts only 'Z' UTC instants (offset-less would parse in server tz); bsdate errors rewrapped as LimsError (date_out_of_range kept).
[CONV] numberFormat: {seq:N} width capped at 20; tokens fy/fyl/prefix/branch only; seq >= 1.
Open: no eslint binary in services/api (lint not run); tsc --noEmit shows no billing errors.
