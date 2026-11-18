TESTS_WRONG — rs-c6.screens "worklist" snapshot and rs-c6.static "same form field names" pin pre-LD-353 ReportsWorklist.tsx markup that T0D-UILIST-1 replaced. Neither the T0D-PRINTCFG-1 brief nor the spec requires that markup for this task.
1. The brief gates are (inbox T0D-PRINTCFG-1-arbiter.md:20-21): the new print and stationery tests, the reporting and billing web suites, and an unchanged rs-c2. The files list (line 15) does not include ReportsWorklist.tsx.
2. Git: the last change to ReportsWorklist.tsx is 74ea3e301 [writer] T0D-UILIST-1 impl. No PRINTCFG commit touches it. rs-c6.baseline.json and rs-c6.screens.test.tsx.snap were last recorded before that (2e2dd94ab T0D-UNSLOP-1, 3252b31dc T0D-WEBFIX-1).
3. LD-353 (binding, inbox line 33) template 1 says "FilterBar in one row" and that the status filter goes into it. ReportsWorklist.tsx:98-137 does that: `lookup` is now a FilterBar field config `{ id: 'lookup' }` (line 137), not a literal `name="lookup"` the static extractor reads, and the status row now shows the "Ready to release" option (line 19). So the snapshot diff and the missing baseline name both come from UILIST-1 drift.
4. The PRINTCFG part of the static test is correct: rs-c6.static.test.ts:132/159 subtracts PRINTCFG.field_names before comparing, so the extra PRINTCFG names do not cause the failure.
5. This is the same drift ruled on earlier for the 3 c6-t31 cases (previous ruling, lines 1-4).
TEST CHANGE (lead/tester, recorded as T0D-UILIST-1 drift; not done by the PRINTCFG writer): re-record rs-c6.screens.test.tsx.snap "worklist" from current ReportsWorklist.tsx. Then either drop `lookup` from rs-c6.baseline.json field_names (around line 265) or teach the rs-c6.static extractor to read FilterBar `id:` fields. The second option is better because it keeps the PHI lookup field pinned.
CARRIED FORWARD: the c6-t31 change from the previous ruling still applies. Update c6-t31.screens.test.tsx §2.1 and the CriticalAlertsPanel error case to the LD-353 markup. Find the error by the ErrorState title "Critical alerts could not be loaded" plus its Retry button. Find the lookup by the FilterBar `lookup` field. Keep all behaviour assertions.
FOR T0D-PRINTCFG-1: pass when its own print and stationery tests, the rest of the reporting and billing suites, and rs-c2 are green. List these 2 rs-c6 cases and the 3 c6-t31 cases as pre-existing T0D-UILIST-1 drift in the task notes. Do not edit ReportsWorklist.tsx or CriticalAlertsPanel.tsx.

## LEAD ITEM LD-395 FOR THE TESTER (written by the lead, 2026-11-19 00:25 NPT; this is yours — the ruling above is correct but incomplete)

You already applied the field_names/extractor half of the ruling above correctly (confirmed in rs-c6.surface.ts). Two things in rs-c6.screens.test.tsx are still unaddressed — fix both, nothing else in this file or any other file:

1. In the `RS-C6 worklist` describe block's "axe clean; one primary at most; tabs and filters keep working markup" test, this line is now wrong because the Status filter is a `kind: 'select'` FilterBar field, not a tab bar (same LD-353 conversion already handled elsewhere in this app):
```
expect(screen.getAllByRole('tab').length).toBe(6);
```
Replace it with the SAME pattern already proven in `c6-t31.screens.test.tsx` (around lines 108-115) for this exact conversion — click the Status trigger, then read the option list:
```
await user().click(screen.getByRole('button', { name: /status/i }));
expect(screen.getAllByRole('option').length).toBe(6);
```
Use whichever `user()` helper this file already imports/uses elsewhere; if this specific test has none in scope, copy the same import c6-t31.screens.test.tsx uses for it. REPORT_TABS (apps/web/src/features/reporting/server/types.ts) still has exactly 6 entries, so "6" is still the right number — only the query method changes, matching the already-landed pattern, not a new one.

2. The re-recorded "worklist" snapshot (__snapshots__/rs-c6.screens.test.tsx.snap) is still stale: it does not contain a `button Ready to release` line that the live render now produces (the Status FilterBar's trigger button shows the currently-selected option's own label, "Ready to release", for this render's tab="ready_to_release" prop). After fix 1 above, re-run the worklist snapshot test with the normal update-snapshot step so it captures the current render fresh, including that button line. Do not hand-edit the .snap file; regenerate it from a passing render.

Do not touch any other test in this file, any other snapshot in this file, rs-c6.static.test.ts, rs-c6.surface.ts, rs-c6.baseline.json, or any source file — PRINTCFG-1 itself never touched this area and this is restyle-drift cleanup only.

WRITER and DEBUGGER: no code change. If a debugger round after this still fails on something inside rs-c6.screens.test.tsx or its snapshot, escalate to lead rather than re-disputing.

## LEAD ITEM LD-399 FOR THE TESTER (written by the lead, 2026-11-19 01:10 NPT)

LD-395 item 1 (tab assertion) landed (commit 8c0a95937). Item 2 (snapshot regen) has not, across two more debugger rounds — the snap file is still stale. Rather than ask you to regenerate it a third time, here is the exact, verified diff pulled directly from the latest verify log.

File: `apps/web/src/features/reporting/__tests__/__snapshots__/rs-c6.screens.test.tsx.snap`, the `RS-C6 key-screen outline snapshots (...) > worklist 1` export.

Current (stale):
```
"section Reports
h1 Reports
button Help
button Search
button Select an item
button Select an item
button Open calendar for From
button Open calendar for To
button Select an item
button Reset filters
input Select all rows
input Select R2611050001
a R2611050001
span Ready to release"
```

Insert exactly one line, `button Ready to release`, directly after `button Search` and before the first `button Select an item`. Correct (matches the live render exactly, confirmed against the verify log's Received diff):
```
"section Reports
h1 Reports
button Help
button Search
button Ready to release
button Select an item
button Select an item
button Open calendar for From
button Open calendar for To
button Select an item
button Reset filters
input Select all rows
input Select R2611050001
a R2611050001
span Ready to release"
```

Make this one-line insertion directly in the `.snap` file (it is a plain literal string, no serialization quirks at this point), or if you prefer, run your normal vitest update-snapshot step against this one test file and confirm the result matches the text above exactly. Either way, touch no other snapshot in this file and no other file.

WRITER and DEBUGGER: no code change. If this one line still is not on disk after this round, stop and escalate to the lead by name rather than a fourth round — something else is blocking the write, not the content.
