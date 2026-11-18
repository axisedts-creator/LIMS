# T0B-SYNC-2 impl — BLOCKED, no code written
- PREREQ missing: T0C-SYNC-2 (contract, migration 20261117260000, probe rows) is on lane/C0-0M only (22 commits ahead of main, last [reviewer] a16b1980d); lane/C0-0H does not contain it (tests note line 3).
- Writer session could not merge: `git merge --no-edit lane/C0-0M` was refused by the harness permission gate (needs approval; session non-interactive). Reading the C0-0M worktree was also refused.
- Implementing against an absent contract would mean guessing table/column names of sync_operation/sync_conflict and the new error codes: forbidden (CLAUDE.md: never invent a name).
- NEXT: lead merges lane/C0-0M (or main once it lands) into lane/C0-0H, then re-queue the writer. Files changed: none.
