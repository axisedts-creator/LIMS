# T0D-UIREPORT-2 dispute (debugger)

Only red in verify: `rs-c8.static.test.ts` "same bytes as before" (log line 173). `report-page.tsx` and `report-views.ts` hashes differ from `rs-c8.baseline.json` (:13, :16).

Cause: tester re-pinned these hashes in 7fbac2be7 (per `T0D-UIREPORT-2-ruling.md` item 2, "tester re-pins to the writer's final bytes"). The writer then changed both files in 81e0c69fb (+9/-1 and +8/-4 lines; the second collections read required by ruling item 1). The pins are stale by one commit. The implementation bytes are the correct, required ones, so there is no implementation fix.

Needed (tester, tester-owned file, not a debugger edit): re-pin `src/features/analytics/server/report-page.tsx` and `src/features/analytics/server/report-views.ts` in `rs-c8.baseline.json` to the bytes at HEAD 81e0c69fb or later (sha256 of the CRLF-stripped content, as `rs-c8.static.test.ts:19,47` computes). Re-pin last, after the writer is done. `report-types.ts` already matches.
