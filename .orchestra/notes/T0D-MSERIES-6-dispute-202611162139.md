# T0D-MSERIES-6 dispute (writer, 2026-11-16 21:40 NPT)
Re-ran tests on HEAD 83d249582: packages/ui 52 passed / 1 skipped; apps/web m6 config 411/413.
The 2 reds are still rs-c2.static.test.ts ("data, action ... untouched", "same route files") against the stale rs-c2.baseline.json.
The arbiter already ruled TESTS_WRONG (T0D-MSERIES-6-ruling.md items 1-4): the tester has to re-record the baseline with RS_C2_RECORD=1 and commit it. That step has not been applied yet; no baseline commit after ec073f164.
The baseline is a test artifact, so the writer may not touch it. The implementation stands per ruling item 6. Nothing for the writer to change.
Needed: tester applies ruling item 4, then re-run T0D-MSERIES-6-verify.cmd.
