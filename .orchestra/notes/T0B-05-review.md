CHANGES

Round 3 re-review of `git diff 86d611d..HEAD`. Since the last review (fa17d01), the only new commit is f230fb9, which adds one line to `.orchestra/notes/T0B-05-impl.md`. No code, migration or test changed.

Checks run on HEAD:
- `node --test tests/db/*.mjs` = 209/209 pass.
- `graphile-worker` appears in neither `package.json` nor `db/tests/run-suites.sh`, and `node_modules/graphile-worker` is absent. CR `.orchestra/cr/T0B-05.md` is still open (not resolved).

1. db/tests/core/T0B-05_queue.test.sql:9-46 — still open. done_when "enqueue tenant-mismatch" and queue_depth (schema tests 22/23, AC-0D-5.14/5.15) cannot pass in the repo harness while graphile_worker is missing. Exact fix: once CR T0B-05 is accepted and C0-0A has landed `graphile-worker@0.18.0`, add the SP-2 step-(b) install to `db/tests/run-suites.sh` between `20261105001100_*` and `20261105001200_*`. Then run `bash db/tests/run-suites.sh db/tests/core/T0B-05_platform.test.sql db/tests/core/T0B-05_queue.test.sql` until it shows 0 `not ok`, and record the real output in `.orchestra/notes/T0B-05-tests.md`. This is blocked on an outside dependency, not on the writer. Escalate the CR to the orchestrator; another fix round without it changes nothing.

Note (not blocking, carried over): after the CR lands, remove the `check_function_bodies = off` fallback in 20261105001200_app__create_queue_wrapper.sql:10-15, as CR item 3 says.
