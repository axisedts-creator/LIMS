APPROVE
Reviewer T0B-SYNC-4 re-review, diff 2e605bf806af..7555fdf67 (delta since the CHANGES review 3011de596: 2093db214 tester, 7555fdf67 writer).

Earlier items:
1. FIXED. print.service.ts createBulkPrint asks offlineMarkers.isPending for each included version and writes issuedOffline. The bulk handler wires pendingMarkers the same way createReportPrint does. printOffline.test.ts covers pending, none, no seam, excluded version, no new body field, and the handler.
2. FIXED. adapters/offlineStores.live.test.ts runs the production syncAlerts/syncSignoffs/pendingMarkers stores and the 20261118100000 DDL as the app role under RLS: the alert, sign off and recall persist; cross tenant read/insert/update are refused; the state only moves forward (immutable_row); isPending goes true -> false.
3. RUN by the reviewer (2026-11-18 23:29, 23:38, 23:44 NPT): SYNC4_SUITE="src/core/sync src/modules/lab src/modules/reporting src/modules/billing src/__tests__/boot-smoke.test.ts src/core/pipeline/__tests__/authz-central-boot.test.ts" bash tests/core/T0B-SYNC-4.pg.sh, three times.
   Results: run1 27 failed / 6551 passed (10 files); run2 and run3 26 failed / 6552 passed (9 files). The same 26 every run; the 27th in run1 is a 60 s timeout in billing unit/boot.test.ts under load.
   None of the 26 comes from this task. The diff touches none of those files or the code they test:
   - billing repo.static (accounts.repo.ts `${` in SQL): ALSO FAILS AT BASE 2e605bf80 (checked in a throwaway worktree). Origin: T0B-FINCTRL-1 fe8803117.
   - lab handlers/critical.service (auth.forbidden where the test expects common.not_found 404, plus related list cases): the code was last changed by T0B-VERLEVEL-1 8af2b6f24, before the base. The SYNC-4 diff leaves lab/handlers and lab/service alone.
   - reporting printcfg/handlers.live previewPrintProfile: AuthError common.service_unavailable from app.enqueue_job `unknown_task_identifier` (the graphile task registry). The failure is in enqueue, not in the issued_offline INSERT, so it is not this task's edit to print.repo.ts.
   FOR THE LEAD (not a SYNC-4 defect): done_when (6) says "existing suites stay green", but they were already red at the base. Route the failures to their owners: FINCTRL-1 (accounts.repo interpolation), VERLEVEL-1/lab (404 masking), PRINTCFG-1/ASYNC (preview task identifier).
Task suite: writer reports T0B-SYNC-4.pg.sh 217/217 green three times (23:11, 23:13, 23:14 NPT); the reviewer's full runs include those files and none of them failed.
Also checked again: names verbatim, RLS ENABLE+FORCE and `::uuid[]`, no PHI in alerts or audit, no secrets, CR .orchestra/cr/T0B-SYNC-4.nonblocking.md for the paths outside "adapter files only".
