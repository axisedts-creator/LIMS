# Result entry grid — user manual

**Screen:** `/lab/orders/{order_id}/results`

This page is part of the lab user manual. The same steps appear in the in-app help (press F1 or the ? icon).

## Purpose

Enter, save, verify, approve, return and amend results for one order. It also holds the history drawer and the trend dialog for the focused analyte.

## Steps

1. Type values in the Value column. Calculated analytes are read-only and show the result, "Waiting for: {codes}" or "Not calculated: {reason}".
2. Type a colon and a short code (for example :NORM) then Space or Tab to expand a comment. Ctrl+Space opens the code picker. An unknown code shows "Unknown code {code}".
3. Save with Ctrl+S. Ctrl+Enter saves, then verifies the rows of the focused test. If rows carry flags, tick every review box in the verify prompt first.
4. Press F2 to open the history drawer: the last 5 approved results of this patient. Press F3 for the trend dialog; use "Show as table" for the table version. Points in a different unit are listed under "Not plotted (different unit)".
5. Approve (Alt+A), Return (Alt+R, reason required) or Amend (Alt+M, new value and reason required). If multi-factor approval is needed you are asked to confirm first.

## Shortcuts

- Enter or Down — next editable row
- Shift+Enter or Up — previous row
- Tab and Shift+Tab — next and previous cell
- Ctrl+S — save all edited rows
- Ctrl+Enter — save, then verify focused test
- F2 — history panel
- F3 — trend chart
- Ctrl+Space — short-code picker
- Alt+A — approve selected; Alt+R — return; Alt+M — amend
- Alt+N and Alt+P — next and previous order
- Esc — cancel cell edit
- ? — list of all shortcuts

## Error messages

- "Enter a number with up to {n} decimals."
- "Choose one of the listed values."
- "Text is limited to 2,000 characters."
- "Approved results can only be changed by amendment."
- "You have unsaved results. Leave without saving?" — shown when leaving with edits.
- "No previous results for this patient." — history is empty.
- "Not enough history to draw a trend (needs 2 results)."
- "Age unknown — reference range and critical check not applied" is shown in the Ref range column when the patient age is missing; add the date of birth.
- "You verified this result. Another pathologist must approve it."
- "Record the critical-value notification before approving." — follow the link to the critical event.
- "This creates version {n+1}. The released report will be superseded." — shown before you confirm an amendment.
- "This item was changed by someone else. Reload to see the latest." — press Reload, then redo your change.
- "You don't have access to this screen." — your role does not include this screen. There is no Retry button; ask your administrator.
- "Something went wrong" — "Please try again. If it keeps happening, give this reference to support: {request_id}". Press Retry; if it repeats, give the reference to support.
- "This item doesn't exist or isn't visible to you." — the link is wrong or the item belongs to another organisation. The message is the same in both cases.

## Tips

Keep the barcode scanner pointed at the label and wait for the confirmation before the next scan. All names in training material must be synthetic; never type real patient data into a practice system.
