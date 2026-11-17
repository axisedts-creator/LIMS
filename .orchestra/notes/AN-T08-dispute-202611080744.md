# AN-T08 dispute (writer)
2 tests wrong, same cause: the ad_month windows start `2026-10-30`, so the seeded out-of-window row D0 (`2026-11-04`, taxable/gross 111, `seedStandard`) is legitimately inside the window and lands in the November bucket. Tests expect November = TOTAL_ALL / ALL (window [D1,D3)) and totals +4520 / +400 without the 111.
- `handlers/__tests__/income.handler.test.ts` "ad_month: one row per A.D. month…" — row[1] gives invoices_issued 7, gross 17111, invoiced 18191, net 15191 (= TOTAL_ALL + D0 row); also `totals.invoiced_paisa` would be 4520+18191.
- `handlers/__tests__/departmentIncome.handler.test.ts` "department_ad_month: …" — Nov H cell = ALL[H] + D0 line (lines 8, gross 14021, net 10021); totals.net 15191+400; R2 still true.
Implementation checked by hand against rollups semantics ([from,to) on business_date): output is correct. Fix options: start the window at `2026-11-05` minus nothing but use a seed without D0 (e.g. `db.income = db.income.filter(f => f.date !== D0)` in the test), or add the 111 to the expectations (invoiced 4520+18191; issued 7; H 8 lines / 14021 gross / 10021 net).
Stopped on these two; 524/526 pass.
