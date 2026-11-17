# Instrument exceptions — user manual

**Screen:** `/lab/ingest-exceptions`

This page is part of the lab user manual. The same steps appear in the in-app help (press F1 or the ? icon).

## Purpose

Resolve instrument results that could not be stored automatically.

## Steps

1. Open the list. Filter by reason, instrument or status.
2. Open an exception. Reasons include Unknown barcode, Code not mapped, Specimen rejected, Result approved, Result already verified, Not yet received, Test not ordered and Unit mismatch.
3. Assign: scan the barcode or search by registration number and pick the result row. To use a different analyte, tick "Apply to a different analyte".
4. Or press Re-apply after fixing the cause, or Discard with a reason (and comment up to 300 characters).

## Shortcuts

- Tab and Shift+Tab move between actions
- Enter opens the focused row

## Error messages

- "No open instrument exceptions." — nothing to resolve.
- "This result is approved. To use the new value, a pathologist must amend it." — use the amend action in the result grid.
- "You don't have access to this screen." — your role does not include this screen. There is no Retry button; ask your administrator.
- "Something went wrong" — "Please try again. If it keeps happening, give this reference to support: {request_id}". Press Retry; if it repeats, give the reference to support.
- "This item doesn't exist or isn't visible to you." — the link is wrong or the item belongs to another organisation. The message is the same in both cases.

## Tips

Keep the barcode scanner pointed at the label and wait for the confirmation before the next scan. All names in training material must be synthetic; never type real patient data into a practice system.
