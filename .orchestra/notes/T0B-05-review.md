APPROVE
Round 6 review of `git diff a4989ef..HEAD` (LD-31 changes: devDependency, lockfile, T0-03 row, fallback removed, run-suites.sh split, queue test cast).
- Prior item 1 fixed: db/tests/run-suites.sh:33-47 splits the D-201 window into (a) migrations < 20261105001200, (b) `graphile-worker --schema-only` as lims_migrator with role lims_queue (on failure: REVOKE CREATE on app and the database, then exit 1), and (c) 001200 onward. `set -euo pipefail` still stops on any MIG failure. The port is bound to 127.0.0.1 only, and passwords go in env vars, not argv.
- Prior item 2 fixed: impl note Round 5 matches what I reproduced.
- Reviewer re-ran on HEAD, 2026-11-07: `bash db/tests/run-suites.sh --no-seeds db/tests/core/T0B-05_platform.test.sql db/tests/core/T0B-05_queue.test.sql` printed "Schema updated", both files ran with 0 `not ok`, exit 0, elapsed 29s. `node --test tests/db/*.mjs` gave 224/224 pass. Tree clean after the run.
- node_modules/graphile-worker is 0.18.0. Fallback removed per LD-31 (CR item 3). Paths are owned. No secrets, no PHI.
Not blocking (outside T0B-05): a full run with seeds still fails at seed 010 RLS (T0B-09 ESCALATE). `--no-seeds` must stay local-only, and CI must not pass it.
