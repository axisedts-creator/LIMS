# Label page — user manual

**Screen:** `/lab/orders/{order_id}/labels`

This page is part of the lab user manual. The same steps appear in the in-app help (press F1 or the ? icon).

## Purpose

Print specimen labels for one order. The page waits until the order is ready, then prints once without a click. Use it again to reprint.

## Steps

1. Open the page from the order. "Preparing labels…" shows while the order becomes ready.
2. The print dialog opens by itself. All active specimens are ticked.
3. To reprint, tick the specimens you need, choose Copies (1 to 5) and press "Print labels".
4. After collection, press "Mark selected collected" (only shown if you may collect specimens).

## Shortcuts

- Ctrl+P — print labels
- Space — tick or untick the focused specimen
- Alt+C — mark selected collected

## Error messages

- "Labels are not ready yet. Try again in a moment." — press Retry.
- "Not printable (order cancelled)" — the specimen is inactive; no label is printed.
- "Label too small for this barcode — increase label size in Lab settings."
- Success: "Sent {n} labels to the printer dialog."
- "You don't have access to this screen." — your role does not include this screen. There is no Retry button; ask your administrator.
- "Something went wrong" — "Please try again. If it keeps happening, give this reference to support: {request_id}". Press Retry; if it repeats, give the reference to support.
- "This item doesn't exist or isn't visible to you." — the link is wrong or the item belongs to another organisation. The message is the same in both cases.

## Tips

Keep the barcode scanner pointed at the label and wait for the confirmation before the next scan. All names in training material must be synthetic; never type real patient data into a practice system.
