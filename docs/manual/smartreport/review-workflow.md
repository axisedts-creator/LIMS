# Review workflow

## 1. Queue

Open `/smartreport/summaries`. By default the queue shows summaries awaiting review, oldest first. Filter by status, centre, built date or critical results. You only see centres you are allowed to see. J and K move between rows, Enter opens one.

If the page says Smart report is switched off, the feature is off for the lab.

## 2. Review

A summary opens at `/smartreport/summaries/{summary_id}`. Read "What the patient will see" on the left and compare with "Results used" on the right. The history at the bottom shows earlier actions.

## 3. Decide

| Action | Shortcut | Use when |
|---|---|---|
| Approve | Ctrl+Enter | every sentence is right for this patient |
| Approve & next | Ctrl+Shift+Enter | same, then open the next one |
| Reject | Ctrl+Shift+R | something is wrong; pick a reason |
| Rebuild with active library | menu | a newer approved library exists |

Reject needs a written reason when the reason is "other". After Approve, the PDF report includes the summary the next time it is generated; use Regenerate on the report screen to add it now.

## When results change

If a result is amended, the old summary becomes Superseded at once and a new one is built. The queue shows the new one. Superseded, approved and rejected summaries are read-only.

Responsibilities are described in [approval responsibilities](approval-responsibilities.md).
