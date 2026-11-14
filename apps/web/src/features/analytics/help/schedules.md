# Scheduled reports

## Purpose
Sends a link to chosen reports to chosen staff on a regular schedule, so owners get the figures without opening the system.

## Fields
- **Name**: up to 80 characters. It cannot contain email addresses, phone numbers or web addresses.
- **Reports**: 1 to 10 reports you can access. Default: Dashboard and Income.
- **Frequency**: Daily, Weekly, Monthly (A.D.) or Monthly (B.S.). Weekly also needs a weekday.
- **Send time**: Nepal time (UTC+05:45), in steps of 15 minutes. Default 07:00.
- **Period**: Previous day, Previous 7 days, A.D. month to date, Previous A.D. month, B.S. month to date, Previous B.S. month or Fiscal year to date. Periods follow the Nepal-time business day.
- **Centres**: All centres (only if you have all) or a selection within your own access.
- **Recipients**: 1 to 20 staff. Names only are shown.

Recipients get an email with a link only. They must sign in to see the figures, and their own access limits apply. A recipient who cannot see a report will see it left out.

The run log shows the last 20 runs: slot time, period, sent, skipped and omitted reports. Deactivate stops sending ("Stop sending this report?").

## Freshness
The link opens the report with figures as of now for the period. They are not a copy of the email's time, so they may be updated since. If the page says "Data may be out of date", changes are still being processed.
