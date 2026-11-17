# Smart Report: user manual

This manual explains the Smart Report screens for pathologists, lab managers and front-line reviewers. Every screen also has a short help panel with the same rules. All examples use synthetic data, never real patients.

## Pages

| Page | What it covers |
|---|---|
| [Overview](overview.md) | What patients see and why nothing is free-generated |
| [Library authoring](library-authoring.md) | Writing, checking and submitting a library version |
| [Approval responsibilities](approval-responsibilities.md) | The named pathologist's duties (B14) |
| [Health score](health-score.md) | The published formula hs-1 |
| [Review workflow](review-workflow.md) | From the queue to approve, reject or rebuild |
| [LLM layer](llm-layer.md) | The optional Phase 3 rephrasing layer |

## Screens

| Screen | Route |
|---|---|
| Review queue | `/smartreport/summaries` |
| Summary review | `/smartreport/summaries/{summary_id}` |
| Library versions | `/smartreport/library` |
| Library editor | `/smartreport/library/{library_version_id}` |
| Library review | `/smartreport/library/{library_version_id}/review` |
| Wording terms | `/smartreport/wording` |
