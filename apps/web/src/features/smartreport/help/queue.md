# Smart summaries (review queue)

## Purpose

This list shows the smart summaries built from approved results. Each one is waiting for a named pathologist to read it before the patient can see it. Nothing reaches a patient until it is approved.

## Filters

- **Status**: Awaiting review (default), Approved, Rejected, Superseded.
- **Centre**: limit the list to one centre. You only see centres you are allowed to see.
- **Built**: date range, at most 31 days.
- **Critical only**: show only summaries that contain a critical result.

## Columns

Built, Registration no., Patient, Centre, Findings (number outside range, with a Critical badge when there is one), Score band (Good, Fair, Needs attention or a dash) and Status. The oldest summary comes first so nothing waits forever.

## Keyboard

J and K move the row focus down and up. Enter opens the focused summary. `/` jumps to the first filter. `?` lists all shortcuts.

## Good to know

- An empty list says "No summaries waiting for review." That is normal when everything is done.
- If the page says "Smart report is switched off for this lab", the feature is turned off. Only users who manage lab settings see an Open settings link.
- A summary becomes Superseded when its results change. It is replaced by a new one that appears in this queue.
