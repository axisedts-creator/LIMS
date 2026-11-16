# T0D-MSERIES-6 dispute (writer, round 3, 2026-11-16)
Re-ran on HEAD afe5172e3: packages/ui 52 passed / 1 skipped; apps/web m6 config 411/413.
Same 2 reds: rs-c2.static.test.ts ("data, action ... untouched", "same route files") vs stale rs-c2.baseline.json.
`git log -- apps/web/src/features/admin/__tests__/rs-c2.baseline.json` still ends at ec073f164; ruling item 4 (tester re-record with RS_C2_RECORD=1) not applied.
Ruling item 8: writer has nothing to change. Baseline is a test artifact; writer may not edit it.
Needed: route to TESTER (not writer) to apply ruling item 4, then re-run T0D-MSERIES-6-verify.cmd. Re-routing to writer again will loop.
