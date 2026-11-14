# Audit log

## Purpose

The audit log records every change made to records in your lab: who changed what, when, and from which centre. Use it to answer "who changed this?" questions and for inspections. Address: `/admin/audit`. Permission: `audit.log.read`.

## Filters

- **Date range** (required): default the last 24 hours, at most 31 days. A longer range shows "Choose 31 days or fewer".
- **Table**: the kind of record, for example front-desk orders.
- **Action**: Insert or Update.
- **User**: who made the change.
- **Centre**, **Record id**, **Request id**, **Support session**.

## Columns

Time, User, Action, Table, Record id (short form with a copy button), Centre, Changed fields (count, with the names in a tooltip), Support (badge when the change was made during LIMS provider support access).

## Steps

### Find who changed a record

1. Set the date range around the time of the change.
2. Choose the table and paste the record id.
3. Select a row (or press Enter) to open the [audit entry](audit-entry.md) with the before and after values.

### Export

Select **Export…** to create a CSV file of the current filters. This needs the `audit.log.export` permission. See [Exports](exports.md).

Times are shown in your lab's calendar; hover a time to see it in UTC.
