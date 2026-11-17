# QC status board — user manual

**Screen:** `/quality`

This page is part of the quality user manual. The same steps appear in the in-app help (press F1 or the ? icon).

## Purpose

See at a glance which instrument and analyte pairs are in control, in warning, out of control, or have no QC data. The navigation badge shows how many pairs need action.

## Steps

1. Open QC status. Each row is one instrument and analyte pair.
2. Filter by instrument or by status, or tick Overdue only to see pairs whose QC is overdue.
3. Read the status chip: it shows a tone, an icon and a word, followed by the violated rule, for example "Out of control · 1-3s".
4. Press the number in Open failures to see the runs that need action.

## Shortcuts

- Tab and Shift+Tab move between filters and rows
- Enter opens the focused link

## Error messages

- "You don't have access to this screen." — your role does not include this screen. There is no Retry button; ask your administrator.
- "Something went wrong" — "Please try again. If it keeps happening, give this reference to support: {request_id}". Press Retry; if it repeats, give the reference to support.

## Tips

- "No QC data" means no run has been recorded for the pair yet, which is not the same as in control.
