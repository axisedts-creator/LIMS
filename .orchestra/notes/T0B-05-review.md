CHANGES

Re-review of `git diff 86d611d..HEAD` after the review-fix commits b6e4c18 (tester) and 658eef8 (writer).

Checks run on HEAD:
- `node --test tests/db/*.mjs` = 209/209 pass (round-1 item 2 is fixed).
- `bash db/tests/run-suites.sh db/tests/core/T0B-05_platform.test.sql db/tests/core/T0B-05_queue.test.sql` on supabase/postgres:17.6.1.136: the platform file runs to completion with 0 `not ok`, sections 10-14 included (round-1 item 1 is fixed). The queue file fails at `not ok 1` (`schema "graphile_worker" does not exist`), then `ERROR: relation "graphile_worker.jobs" does not exist` at line 46.
- T0B-05_queue.test.sql has the same 22 assertions as the old section 9. No assertion was weakened or dropped.

Round-1 items 1 and 2 are resolved. Item 3 is still open:

1. db/tests/core/T0B-05_queue.test.sql:9-46 — done_when "enqueue tenant-mismatch" and queue_depth (schema tests 22/23, AC-0D-5.14/5.15) still fail in the repo harness. The fix is filed as the blocking CR `.orchestra/cr/T0B-05.md`: add `graphile-worker@0.18.0` as a dev dependency (owned by C0-0A) and add the SP-2 step-(b) install to `db/tests/run-suites.sh` between `20261105001100_*` and `20261105001200_*`. Exact fix: once the CR is accepted and the dependency lands, add that runner step to `db/tests/run-suites.sh`. This repo owns that file. Then re-run the command above until the queue file shows 0 `not ok`, and record the real output in `.orchestra/notes/T0B-05-tests.md`. T0B-05 stays CHANGES until that run is green.

Note (not blocking, carried over): after the CR lands, remove the `check_function_bodies = off` fallback in 20261105001200_app__create_queue_wrapper.sql:10-15, as CR item 3 says.
