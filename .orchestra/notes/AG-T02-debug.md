# AG-T02 debug
- Cause: `docs/manual/instruments/spikes.md` does not exist; all 14 tests fail ENOENT. Not a code defect. Doc needs measured S1/S2/S3 results from Win10/11/Server 2016 VMs.
- No fix applied: no run evidence in repo; writing verdicts/DECISION lines = fabricated evidence (see AG-T02-ruling.md:8). Tests are correct vs spec (06-PLAN:26), so no dispute.
- Blocked on human: run S1-S3 on 3 VMs, give PASS/FAIL/PARTIAL + one-line evidence per OS per spike. Then fill doc + 3 DECISION: lines (account / DPAPI scope / control path).
- Downstream AG-T04, AG-T15 stay blocked.

## Round 2
- Cause unchanged: `docs/manual/instruments/spikes.md` still absent (ENOENT, all tests). No VM run results in repo.
- No fix applied: only fix is measured S1/S2/S3 data from Win10/11/Server 2016 + 3 DECISION: lines; cannot be derived from code. Tests not touched, no dispute (tests match 06-PLAN:26).
- Needs human: run spikes, supply PASS/FAIL/PARTIAL + one-line evidence per OS per spike.

## Round 3
- Cause unchanged: `docs/manual/instruments/spikes.md` absent, all tests ENOENT. Still no VM run evidence in repo.
- No fix applied: fabricating S1/S2/S3 verdicts or DECISION: lines is not a code fix. Tests untouched, no dispute (match 06-PLAN:26).
- Needs human with Win10/11/Server 2016 VMs.
