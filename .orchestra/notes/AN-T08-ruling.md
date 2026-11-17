TESTS_WRONG — both tests use window [2026-10-30, D3), which contains seeded D0 (2026-11-04); the spec's half-open period includes D0, so the November expectations that omit it are wrong.
Reasons:
- spec/chunks/C8-analytics-mis/01-PRD.md:246 — periods are half-open `[business_date_from, business_date_to)`; 2026-10-30 <= 2026-11-04 < 2026-11-07, so D0 rows must be summed.
- spec/chunks/C8-analytics-mis/02-TRD.md:708 — period_rule `[from,to)` on local business dates; same conclusion.
- helpers.ts:77/91/101 seeds D0 income (taxable 111) and dept (H, 1 line, gross/net 111); TOTAL_ALL/ALL are documented as window [D1, D3) only (helpers.ts:80, income test :20, dept test :19), not the test's window.
Required test change (either option; keep all other assertions):
- Preferred: in both tests, drop D0 from the seed before the request (`db.income = db.income.filter(f => f.date !== D0)`; `db.dept = db.dept.filter(f => f.date !== D0)` — use the helpers' actual date field name), so the November bucket equals TOTAL_ALL / ALL and totals stay 4520+18080 / 15080+400.
- Or: add D0 to the expectations — income Nov row = TOTAL_ALL + D0 fact, totals.invoiced_paisa = 4520 + 18080 + D0 invoiced; dept Nov H = ALL[H] + {lines 1, gross 111, net 111}, totals.net_paisa = 15080 + 400 + 111.
Implementation is not at fault for these two tests.
