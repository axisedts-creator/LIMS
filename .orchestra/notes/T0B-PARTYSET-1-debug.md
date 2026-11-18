# T0B-PARTYSET-1 debugger
- Cause: verify ran before any implementation. lane/C0-0I has no T0C-PARTYSET-1 contract (db421fa97 is in main, not in HEAD) and no partners/catalog/billing handler code, so 15 files fail with "no handler for ..." (e.g. revealPartyIdNumber). Not a code defect, not a test defect.
- Fix: none made. Merge main into lane/C0-0I (brings contract + migration 20261117220000), then the writer must implement the 13+5 handlers; only then re-run verify.
# round 2 (re-read verify log 15:35 + branch)
- Same cause. HEAD still lacks contract commit db421fa97 (only in main, lane/C0-0M); no handler for revealPartyIdNumber etc. in services/api/src outside __tests__.
- No code defect to fix, no test dispute. Needed: merge main into lane/C0-0I, writer implements the PARTYSET handlers, then re-run verify. No source edited.
# round 3 (verify log 15:45)
- Same cause. db421fa97 (T0C-PARTYSET-1 contract) is in main/lane/C0-0M/D/G but still not an ancestor of lane/C0-0I HEAD; no non-test source defines revealPartyIdNumber etc. Failures are "no handler for ..." and /undefined paths, not a code or test defect.
- No source edited. Needed: merge main into lane/C0-0I, writer implements PARTYSET handlers (remove ids from pendingOperations), then re-run verify.
# round 4 (verify log 20:10, boot test)
- Cause: no code defect. real-modules-boot.test.ts times out at its 60s limit (standalone rerun 20:14 also 60.9s; import of all modules is slow under host load, other lanes running). The retry error "module quality: index.ts exports no manifest" is a side effect of the timed-out first import (quality/index.ts does export manifest). The earlier full-run 25 failures are the stale-lane set: lane lacks LD-385 and TESTIMPORT ids (main is not in HEAD; 10 commits ahead).
- Fix: none in source; tests not touched. Needed: merge main into lane/C0-0I (task START), re-run verify on an idle host. Not a test dispute.
# round 5 (verify log 20:20 full run, 25 fail / 9 files)
- Cause: stale lane, no code defect. main has 0 matches of commission_bp in catalog.yaml and partyset/doctor.test.ts (LD-385, d3480c343); lane HEAD (29 commits behind main) still has the old contract+tests, so 7 doctor commission_bp tests fail; writer correctly omits the column (referrers.service.ts:23). Other fails = TESTIMPORT catalog-import ids pending in lane (testmgmt/boot.test.ts, import/*), not owned here.
- Fix: none in source, tests untouched. Needed: task START merge of main into lane/C0-0I (merger agent), then re-run verify on an idle host. Boot test alone passes 2/2 (20:41).
