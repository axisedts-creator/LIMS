# Verification

## Purpose

Verify resulted tests one by one or in bulk. Approval is a separate screen.

## Steps

1. Open the queue. Filter by department, priority or "flagged only".
2. Select rows with Space; extend the selection with Shift+Down.
3. Press "Verify {n}". A summary dialog lists "{ok} done, {failed} not done" with a reason for each failure.
4. Open a row to see its results in the result grid when you need to check values first.

## Shortcuts

- Space — select a row
- Shift+Down — extend selection downwards
- Enter — open the order

## Error messages

- "Nothing waiting for verification." — the queue is empty.
- Flags column text "Age unknown — reference range and critical check not applied" — the range and critical check were skipped because the age is missing.
- "This item was changed by someone else. Reload to see the latest." — press Reload, then redo your change.
- "You don't have access to this screen." — your role does not include this screen. There is no Retry button; ask your administrator.
- "Something went wrong" — "Please try again. If it keeps happening, give this reference to support: {request_id}". Press Retry; if it repeats, give the reference to support.
- "This item doesn't exist or isn't visible to you." — the link is wrong or the item belongs to another organisation. The message is the same in both cases.
