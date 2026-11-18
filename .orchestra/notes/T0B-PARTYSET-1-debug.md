# T0B-PARTYSET-1 debugger
- Cause: verify ran before any implementation. lane/C0-0I has no T0C-PARTYSET-1 contract (db421fa97 is in main, not in HEAD) and no partners/catalog/billing handler code, so 15 files fail with "no handler for ..." (e.g. revealPartyIdNumber). Not a code defect, not a test defect.
- Fix: none made. Merge main into lane/C0-0I (brings contract + migration 20261117220000), then the writer must implement the 13+5 handlers; only then re-run verify.
# round 2 (re-read verify log 15:35 + branch)
- Same cause. HEAD still lacks contract commit db421fa97 (only in main, lane/C0-0M); no handler for revealPartyIdNumber etc. in services/api/src outside __tests__.
- No code defect to fix, no test dispute. Needed: merge main into lane/C0-0I, writer implements the PARTYSET handlers, then re-run verify. No source edited.
# round 3 (verify log 15:45)
- Same cause. db421fa97 (T0C-PARTYSET-1 contract) is in main/lane/C0-0M/D/G but still not an ancestor of lane/C0-0I HEAD; no non-test source defines revealPartyIdNumber etc. Failures are "no handler for ..." and /undefined paths, not a code or test defect.
- No source edited. Needed: merge main into lane/C0-0I, writer implements PARTYSET handlers (remove ids from pendingOperations), then re-run verify.
