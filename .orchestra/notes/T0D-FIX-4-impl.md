# T0D-FIX-4 impl (writer)
- page.tsx (catalog/tests): no Status filter = active only; `retired=1` adds retired; retiredCount = retired in the q/department/specimen-filtered catalog (whole list, not page). API call unchanged (is_active=all unless Status set).
- TestsList.tsx: kit Switch "Show retired" + "N retired" text (hidden when an explicit Status filter is set); testsHref keeps `retired`; Price uses billing/components/format formatNpr (NPR 1,800.00, lakh grouping) instead of catalog's ungrouped one.
- StatusBoard.tsx: From/To date = kit DatePicker (DD/MM/YYYY, calendar button); value stays YYYY-MM-DD so the 7-day rule and local-day ISO range are unchanged.
- [CONV] address param name `retired=1` (tester left it free); switch omitted when is_active is explicit (Status already decides).
- Ran: fix4 58/58, cattests1 40, testfix1 122, testmgmt1 141, uilist3 173, pricetools1 193, uix1 63, uix6 131, uix3 11, lab-t27 18, uidash1 95, sec-hyg1 29(+2 skip), unslop1 30; tsc clean on changed files.
- Open: emptytbl1 (3), emptytbl2 (2), elabmenu3 (14) fail on lab pending/worksheet, reporting SimpleTable, billing headings, lab/components/shared.tsx allow-list — not files of this task; not checked whether they fail on main. No web eslint binary in apps/web.
