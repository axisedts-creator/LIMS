# Daily cash and cash shifts (screen `/billing/daily-cash`)

This page explains how to reconcile one business day's cash and close your own shift. It mirrors the in-app help for Daily cash.

## What the screen shows

- **Business date** – the day displayed. Pick another date to look back.
- **Collections** – one row per staff member and payment method: Entries, Reversals, Gross, Reversed, Net (NPR), with a Total row.
- **Shifts** – one row per shift: Staff, Opened, Closed (or Open), Expected cash, Counted cash, Variance.

## Closing your shift

1. Count the cash in your drawer.
2. In the My shift section, enter the counted amount and, if useful, a Note (up to 500 characters).
3. Choose Close shift (`Ctrl+Enter`).

The system compares your count with the expected cash and records the variance. If the variance is larger than the Cash variance alert set in `/billing/settings`, finance is alerted. A closed shift cannot be reopened or edited.

## Mistakes

Payments are never edited or deleted. A wrong payment is corrected by a reversal, which shows in the Reversals column and in `/billing/audit-trail`. The same rule applies to invoices: they cannot be edited or deleted; cancel with a reason and a credit note is issued (`/billing/invoices`).

## Export

People with the export permission can export the day's cash report from the screen. See the exports page for the file format.
