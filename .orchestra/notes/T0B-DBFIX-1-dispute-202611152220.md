T0B-DBFIX-1 writer, round 3: PROCESS BLOCKER, not a test or spec dispute.
The ruling (ruling.md item 5) says to commit `.orchestra/notes/T0B-DBFIX-1-dbtests.patch` (21 db/tests suites plus run-suites.sh). Those are tracked test-folder files. The writer role may not edit them (inbox line 1; run.ps1 Enforce("writer") reverts them).
The writer will not commit them itself to slip past Enforce: that would get around the role gate the harness sets on purpose. The ruling names the routes as the lead's choice.
LEAD ACTION NEEDED, pick one:
 (b) the tester applies the patch unchanged: `git apply .orchestra/notes/T0B-DBFIX-1-dbtests.patch`, then commits. No harness change needed.
 (a) or temporarily add the LD-230 file list to $TestExempt in run.ps1, then rerun the writer.
After it lands: `node --test tests/db/T0B-DBFIX-1.fixtures.test.mjs` and `gen-isolation-probes --check`. Writer-owned parts (the generator fix, CRs T0B-DBFIX-1.1-.5) are already committed. The lane cannot run SQL (no Docker).
