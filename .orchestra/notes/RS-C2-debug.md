## Debugger round (2026-11-14 12:37)
Cause: verify runs with CI=true; `__snapshots__/rs-c2.screens.test.tsx.snap` was not in the tree, so the existence test and 5 snapshots failed (6 fails). No code defect.
Fix: recorded snapshots once with `-u rs-c2.screens` (as the test header says); no code or test edits. Re-run CI=true: 2 files, 75/75 pass.
Snapshot file left untracked in `__snapshots__/`; it must be committed.

## Debugger round 2 (2026-11-14 12:43)
Cause: round-1 snapshot file was untracked and got wiped before verify (dir empty, tree clean); CI=true then fails the existence test + 5 snapshots. No code defect.
Fix: re-recorded with `-u rs-c2.screens`; CI=true re-run: 2 files, 75/75 pass. No code or test edits. Snapshot dir is untracked again: COMMIT `__snapshots__/` or it will be wiped.

## Debugger round 3 (2026-11-14 12:47)
Cause: same as rounds 1-2; `__snapshots__/rs-c2.screens.test.tsx.snap` missing again at verify (not tracked, wiped), so CI=true fails existence test + 5 snapshots. No code defect.
Fix: re-recorded with `-u rs-c2.screens`; CI=true re-run: 2 files, 75/75 pass. No code or test edits.
Snapshot untracked again: it MUST be committed (host/lane cleanup keeps wiping it) or verify fails every round.

## Debugger round 4 (2026-11-14 13:50)
Cause: host, not code. Verify log and my own CI=true re-run both show static file 14/14 pass, then "Failed to start forks worker ... Timeout waiting for worker to respond" for rs-c2.screens.test.tsx (0 screen tests run). Tree clean; `__snapshots__/` is empty, so once workers start the snapshot must be recorded with `-u rs-c2.screens` (LD-170 lets the debugger keep it).
Fix: none. No code, test or vitest-config edits to work around the host. Re-run verify when the host has free RAM / fewer lanes.
