# T0B-TESTFIX-2 impl (writer, pass after arbiter ruling 2026-11-18) - DONE_WHEN (4) MET
Files changed by writer: none (stale fixes, advisory lock, settings restores incl. uploads.live afterAll(resetSettings) are tester commits 072b7f47a + 7aea1ae36; REGAPI-2 handlers closed the 65-failure gap).
Whole frontdesk suite, tests/frontdesk/T0B-REGAPI-1.pg.sh on throwaway PG17 (logs .orchestra/notes/tmp/writer-green1..6.log):
  run1 1677/1677 pass; run2 1677/1677 pass; run3 2 failed (unit/boot.test.ts:100 + :115 "Test timed out in 60000ms", bootstrap under host load, run 272s vs ~185-210s; no settings/stale failure);
  run4 1677/1677 pass (208.6s); run5 1677/1677 pass (209.3s); run6 1677/1677 pass (207.1s) => three consecutive green runs (4,5,6).
[CONV] Timeouts not raised, no retries, no test edited/skipped/loosened; settings flake failures (referrer_required, discount_approval_required, version_conflict, min chars, sms) = 0 in all 6 runs.
Open: boot.test.ts real-bootstrap tests can still exceed 60s when other lanes load the host (seen once in 6, also obs. earlier); not a product defect, no CR. Watch it; a fix would be a tester call (shared bootstrap per describe), not a timeout bump.
T0B-REGAPI-1 and T0B-REGAPI-2 can now be re-verified on the whole frontdesk suite.
