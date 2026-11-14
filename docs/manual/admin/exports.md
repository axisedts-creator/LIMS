# Exports

## Purpose

Exports create a CSV file from the audit log, the access log or the sign-in events, for inspectors or your own review. Exports are limited and recorded, and every administrator of your lab is notified. Address: `/admin/exports`. Permission: `audit.log.export`.

## Fields

The **New export** dialog has:

- **Source**: Audit log, Access log or Sign-in events.
- **Date range**: at most 31 days.
- **Filters** of the chosen source.
- **Format**: CSV only.

Exports do not include changed values; open the audit entry to see them.

## Columns

Created, Requested by, Source, Range, Status, Rows, Expires, Downloads left, and a **Download** button shown to the requester only.

## Steps

### Create an export

1. Select **New export** (or press `n`).
2. Choose the source, date range and filters.
3. Read the warning, then select **Create export**.
4. When the status shows the file is ready, select **Download**. The file expires and can be downloaded only a limited number of times.

You need access to all centres to create an export. If you see "Exports need access to all centres", ask another administrator.
