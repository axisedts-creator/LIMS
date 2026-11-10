# Owner dashboard

## Purpose
One page that shows how the lab is doing for the chosen period (default: Today). Each tile links to the report behind it.

## Metrics
- **Patient visits (M04)**: each patient is counted once per centre per day. Over several days the same person can be counted more than once, so this is a count of patient-days, not distinct persons. Sub-value: new patients (M05).
- **Income, net sales (M12)**: invoices issued (M10) minus credit notes (M11). Cash collected is shown separately.
- **Results approved (M42)**: analyte results approved in the period. Sub-value: tests ordered (M08).
- **Reports pending (M52)**: orders registered, not cancelled, with no report released yet. Sub-value: ready, not released (M54).
- **Pending tests (M50)**: tests still in progress right now. Sub-value: overdue (M51), those older than their turnaround target. Pending figures are a live snapshot and have no change arrow.
- **Cash collected, net (M27)**: payments minus reversals and refunds on a cash basis. Shown only if you may see collections.
- Cards below list the top referrers (orders and patient visits only, no money) and the top centres.

## Periods and business day
A business day runs 00:00–24:00 Nepal time (UTC+05:45). The header shows the period in both A.D. and B.S. The change arrow compares with yesterday or with the previous days of equal length.

## Freshness
"Updated {time} (Nepal time)" tells you when the figures were last calculated. "Data may be out of date" means recent changes are still being processed or the last update failed. Use Refresh (Alt+R); it is available again after 5 minutes.

## Centre scope
You only see figures for the centres you have access to. Users with access to all centres see all centres, and the centre filter is hidden if you have just one.
