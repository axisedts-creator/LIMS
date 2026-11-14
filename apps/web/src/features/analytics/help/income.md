# Income report

## Purpose
Shows sales per day, month, branch or centre, so you can see what the lab billed and what was credited back.

## Metrics
- **Invoiced (M10)**: net value of every invoice issued in the period, including invoices cancelled later and periodic credit bills.
- **Credit notes (M11)**: full and partial credit notes issued in the period. This value includes tax.
- **Net sales, "Income" (M12)**: invoiced minus credit notes. It can be negative on a day when credit notes exceed invoices.
- **Gross, Discount, VAT, Other tax, Exempt, Taxable (M13 to M18)**: the invoice side of the total. Credit-note tax is not split out.
- **Invoices issued and cancelled (M19, M20)**: counts.

Income = invoices issued (incl. VAT/other tax) minus credit notes. Cash collected is shown separately, because it is counted when money is received, not when the invoice is issued. See the Collections history for that.

The figures match the sales register and credit-note register for the same dates.

## Periods and business day
Group by Day, A.D. month, B.S. month, Branch or Centre. A business day runs 00:00–24:00 Nepal time (UTC+05:45). Periods show A.D. and B.S. dates side by side. The chart shows up to 31 groups.

## Freshness
"Updated {time}" shows the last calculation. "Data may be out of date" means changes are still being processed. Refresh from the dashboard.

## Centre scope
Only the centres you have access to are included. Invoices that belong to no centre are visible only to users with access to all centres.
