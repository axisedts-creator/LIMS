# Department income report

## Purpose
Splits net sales by lab department, so you can see which departments earn what.

## Metrics
- **Department net sales (M21)**: billed lines minus credit lines for the department, by the date each line or credit note was issued.
- **Billed lines (M22)**: number of billed lines. Credit lines count 0.
- **Share**: the department's part of the total net sales shown.
- **Multiple departments**: invoice lines for packages that span departments are shown on this row.

Department totals should equal Income (M12) for the same period. If they do not, a warning banner appears, "Department totals do not match income for this period. The team has been alerted." The figures are never hidden.

## Periods and business day
Group by Department, Department × A.D. month, or Department × B.S. month. Business days are counted in Nepal time (UTC+05:45). Periods show both A.D. and B.S. dates.

## Freshness
"Updated {time} (Nepal time)" shows the last calculation. If it says "Data may be out of date", recent changes are still being processed.

## Centre scope
You only see centres you have access to. Rows without a centre are shown only to users with access to all centres.
