# Delivery and releases

## Purpose
Shows whether reports and messages reach patients and doctors, and how many reports were released.

## Metrics
- **Deliveries by status (M80)**: queued, sent, delivered, read, failed and suppressed messages, by channel. Failure share is the failed part of each day's messages.
- **Reports released (M85)**: report versions released, with Final, Partial, Preliminary and Amended splits.
- **Amended releases (M86)** and **override releases (M87)**: releases that corrected an earlier report, and releases made by override.

Counted on the day each message was created; later status changes update that day. So a message sent on Monday and delivered on Tuesday is counted on Monday.

Group by Channel, Day, A.D. month or B.S. month.

## Periods and business day
A business day runs 00:00–24:00 Nepal time (UTC+05:45). The header shows A.D. and B.S. dates.

## Freshness
"Updated {time}" shows the last calculation. "Data may be out of date" means changes are still being processed, and past days can still change.

## Centre scope
You only see centres you have access to. Messages not linked to a report belong to no centre and are shown only to users with access to all centres.
