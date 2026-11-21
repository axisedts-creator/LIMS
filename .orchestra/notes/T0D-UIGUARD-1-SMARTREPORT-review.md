APPROVE

Reviewed `git diff 9058e59d0..HEAD` (writer ea838a4b1) against the task brief, LD-436 rules 5/6/7, LD-438..LD-441.

Checks run by reviewer (lane tree, HEAD):
- build:nav + vitest uiguard1 config: 36/36 passed (stale-entry test green; no SMARTREPORT entry left in uiguard1.exceptions.ts or notes/T0D-UIGUARD-1-exceptions.md).
- sr-t19 66/66, sr-t20 102/102, sr-t21 97/97 passed.
- sr-t18 57/58: "Error: a failing API makes the page reject" fails. Not caused by this diff: the summaries queue route (app/(staff)/smartreport/summaries/page.tsx -> server/summaries-page) and SummaryQueue are not touched; the diff only changes CheckTab, GroupsTab, PreviewDialog, ReviewPanel, SummaryReview, TextsTab, WordingTerms, common.tsx and the mirror notes. Route to debugger as pre-existing (could not check out the parent commit to prove it: worktree creation was blocked).

Findings:
- done_when 1 (rule 5): WordingTerms, CheckTab (after a run), GroupsTab MappingTab now always draw the DataTable with emptyState. OK.
- done_when 2 (rule 6): every TimeSeriesChart in SummaryReview is wrapped in ChartCard. OK.
- done_when 3/4 + LD-439 b: SMARTREPORT lines (rule 5, 6, 7) removed from the mirror notes; registry edited only by tester (LD-441). No raw h1-h4/ul/ol left in routed smartreport files; only LlmPanel.tsx keeps a `<ul>` and it is imported by no route (guard green).
- Display only: no route, permission, server action, API, token, kit or registry change. No tests edited by writer. No PHI, no secrets. Only owned paths.
- Not defects (noted): ChartCard title and TimeSeriesChart figcaption show the same title (same pattern as billing); nested Health score Card inside the "What the patient will see" Card.
