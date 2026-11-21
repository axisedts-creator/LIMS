LEAD ITEM, LD-424 (2026-11-19):

Cause: identical mechanism to VERIFY-GREEN-6 (LD-423). Three earlier attempts, a writer commit
and two debugger rounds, each held only the note, not the 42 test-file edits; round 3
(2026-11-16 17:33 NPT) found the tree still unedited with the same 78 errors and the old msw
call still present, then reports the fix green once actually applied and verified in the tree
(tsc 78 down to 0, vg7 7 of 7, all 18 feature configs green). Same Enforce ownership rule as
LD-423: these are existing test files and helpers, so only the tester can keep the edit.

RULING: route through the tester, same as LD-423. The fix is already fully specified in the
debug note and already proven to pass; no further debug rounds are needed on this specific fix.

For the tester: apply exactly the fix in VERIFY-GREEN-7-debug.md, round 3 (the fullest, most
recently verified statement of it): the msw rename across the named test files, and the named
type-only casts and argument fixes in rs-c7, web-t03, web-t04, web-t06, quality-t22, t23 and
t24. Test files and helpers only, nothing in product code. Confirm in-scope tsc errors go to 0,
vg7 is 7 of 7, and all 18 feature configs stay green, then commit. Writer and debugger may not
make this edit stick; only a tester commit will survive the next pass.

Reset: C1 VERIFY-GREEN-7 to changes.
