# T0B-DBFIX-1 dispute (writer, round 2): PROCESS BLOCKER, not a test defect

The task's deliverables are tracked files under `db/tests/**`, but `.orchestra/run.ps1` `Enforce("writer")` (lines 158-177) reverts every writer edit to a tracked file that matches `$TestPat` (`(^|/)tests?/`), unless it is in `$TestExempt` (only `db/tests/isolation/` is). So `git checkout --` undoes the repairs of faults (1)-(6), (8), (9) as soon as this writer session ends. That is why round 1's fixes were missing at HEAD a5b461b0 (the ruling noticed this). Only the generator and the isolation probes survive.

The complete repair exists and the static test passes on it (45/45, `gen-isolation-probes --check` ok). It is saved as a patch so it is not lost:
- `.orchestra/notes/T0B-DBFIX-1-dbtests.patch` (`git diff -- db/tests ':(exclude)db/tests/isolation'`, 21 suites + run-suites.sh). Apply it with `git apply .orchestra/notes/T0B-DBFIX-1-dbtests.patch`.

Lead, pick one:
(a) Add the LD-230 file list (or `db/tests/run-suites.sh` plus the suites cited in LD-230) to `$TestExempt` for this task, then rerun the writer, or
(b) have the tester (who may edit `db/tests/**`) apply the patch as-is, and route the writer only to `db/tools/gen-isolation-probes.ts` (already fixed in this tree).
