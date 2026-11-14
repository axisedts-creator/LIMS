## Debugger round (2026-11-14 12:37)
Cause: verify runs with CI=true; `__snapshots__/rs-c2.screens.test.tsx.snap` was not in the tree, so the existence test and 5 snapshots failed (6 fails). No code defect.
Fix: recorded snapshots once with `-u rs-c2.screens` (as the test header says); no code or test edits. Re-run CI=true: 2 files, 75/75 pass.
Snapshot file left untracked in `__snapshots__/`; it must be committed.
