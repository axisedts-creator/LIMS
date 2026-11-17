# Collect & dispatch — user manual

**Screen:** `/lab/collect`

This page is part of the lab user manual. The same steps appear in the in-app help (press F1 or the ? icon).

## Purpose

Record that specimens were collected, and dispatch collected specimens to the lab. Two tabs: Collect and Dispatch.

## Steps

1. Collect tab: scan a barcode or type a registration number in "Scan barcode or enter registration number".
2. The specimens of that order with status ordered are listed. Tick the ones you collected and press "Collect selected".
3. Dispatch tab: scan each barcode. Every scan adds a row; the specimen must be collected.
4. Press "Dispatch {n} specimens". Use "Clear list" to start again. The list holds at most 200 rows.

## Shortcuts

- Enter — Collect selected
- Ctrl+Enter — Dispatch specimens

## Error messages

- "Scan a label to start." — nothing scanned yet.
- "Collected {n} specimens." — success.
- "Not ready to dispatch (status: {status})" — the row is not in status collected; remove it or collect it first.
- "You don't have access to this screen." — your role does not include this screen. There is no Retry button; ask your administrator.
- "Something went wrong" — "Please try again. If it keeps happening, give this reference to support: {request_id}". Press Retry; if it repeats, give the reference to support.
- "This item doesn't exist or isn't visible to you." — the link is wrong or the item belongs to another organisation. The message is the same in both cases.

## Tips

Keep the barcode scanner pointed at the label and wait for the confirmation before the next scan. All names in training material must be synthetic; never type real patient data into a practice system.
