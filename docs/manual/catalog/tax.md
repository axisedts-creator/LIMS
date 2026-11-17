# Tax rules and tax types (SCR-17)

Route: `/catalog/tax`. Permission to view: `catalog.price_list.read`; editing needs `catalog.price_list.manage`.

## Purpose
Decide which tax applies to each test. Tax treatment of lab services is pending confirmation by your auditor. Configure what your auditor confirms.

## Rules tab
Prices cannot be quoted until a lab default tax rule exists. If no lab-default rule exists the page shows that message as an error banner; add the lab default rule first.
- **VAT treatment**: nothing is pre-selected; you must choose Exempt or Taxable yourself.
- **Other tax type**: only types that have a rate.
- **HS code**: 4–8 digits. Optional. Applicability to lab services is not confirmed.

Columns: Applies to (Lab default / Department / Orderable) · VAT (Exempt / Taxable 13 %) · Other tax · HS code · Effective from/to.

## Tax types tab
Columns: Code · Name · Rate · Effective from/to · Scope (System/Lab). Expand "Rate history" to see earlier versions. The VAT row is a system row, read-only, 13 %.
Lab type form: Code (`^[A-Z0-9_]{1,16}$`), Name (up to 60), Rate % (0–100, 2 decimals; empty means "Not configured — cannot be used in rules"), Effective from.
Changing the rate asks for Effective from and creates a new rate version; earlier rates stay unchanged.

---
In-app help shows the same page (help button in the page header). Back to the [catalog manual](README.md).
