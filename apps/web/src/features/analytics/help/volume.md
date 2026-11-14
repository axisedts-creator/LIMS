# Volume report

## Purpose
Shows how many orders, patients and tests the lab handled, by day, month, branch or centre.

## Metrics
- **Orders registered (M01)**: every order that reached "registered", including those cancelled later. Pre-registered orders are not counted.
- **Cancelled (M02)**: orders registered in the period that are now cancelled. Past days change when an order is cancelled later.
- **Net orders (M03)**: registered minus cancelled.
- **Patient visits (M04)**: each patient is counted once per centre per day. Over a range or across centres, the same person can be counted more than once, so this is a count of patient-days, not distinct persons.
- **New patients (M05)**: patients whose first-ever order falls on that date.
- **Urgent, OPD, IPD (M06, M07)**: order counts by type.
- **Tests ordered (M08)**: active tests on non-cancelled orders.

## Periods and business day
Group by Day, A.D. month, B.S. month, Branch or Centre. A business day runs 00:00–24:00 Nepal time (UTC+05:45). Periods show A.D. and B.S.

## Freshness
"Updated {time}" shows the last calculation. "Data may be out of date" means recent changes are still being processed.

## Centre scope
You only see figures for centres you have access to. Users with access to all centres see every centre.
