T0B-DBFIX-1 writer, round 4: PROCESS BLOCKER, unchanged since round 3. Not a test or spec dispute.
The ruling (item 4) still asks the writer to commit `.orchestra/notes/T0B-DBFIX-1-dbtests.patch` into tracked db/tests files. The writer role may not edit them (inbox line 1), and run.ps1 $TestExempt (line 61) still does not exempt them, so Enforce("writer") reverts them. The ruling (item 5) itself escalates this to the lead.
Re-checked at HEAD 5c172873: `node --test tests/db/T0B-DBFIX-1.fixtures.test.mjs` still fails on the unpatched db/tests files (for example T0B-02 test 57 pg_default_acl EXISTS), as it should.
LEAD ACTION NEEDED (writer cannot end this loop):
 (b) tester runs `git apply .orchestra/notes/T0B-DBFIX-1-dbtests.patch` unchanged and commits it, or
 (a) add the LD-230 files to $TestExempt in run.ps1 temporarily, then rerun the writer.
Then run `node --test tests/db/T0B-DBFIX-1.fixtures.test.mjs` and `gen-isolation-probes --check`. The lane cannot run SQL (no Docker).
