LEAD ITEM, LD-423 (2026-11-19):

Cause, confirmed directly by the lead, not just the debug note: all 3 debugger rounds describe
the identical fix (an msw rename and a handful of type-only casts, in 19 existing test files
across catalog, frontdesk and billing) and report it green before committing (tsc 0 errors in
those three feature folders, vg6 7 of 7). Each round also finds the fix gone on the next check:
round 2 found only the round 1 note committed, not the edits; round 3 found git status clean and
the same 65 tsc errors again. This is not the debugger doing the wrong thing. Read directly in
run.ps1 line 161 (Enforce): a debugger, or a writer, may only keep a change to an existing file
matched by the test file pattern when that file is brand new; an edit to an EXISTING test file
is reverted before the commit runs, every time, whatever the fix. Only the tester role may keep
a change to an existing test file. This is the same ownership rule already used for the rs-c6
baseline pins (LD-405, LD-413, LD-419) and the authz-classification snapshot (LD-420, LD-422);
it is just hitting ordinary test files here instead of a baseline or a generated snapshot. Not a
VERIFY-GREEN-6 implementation defect; no product code is at issue.

RULING: route the already-proven fix through the tester, since debugger and writer cannot make
it stick on these files no matter how many times they retry. No further debug rounds are needed
on this specific fix; if tsc is still not 0 under features/catalog, features/frontdesk and
features/billing after the tester commits, that is new information and belongs in a dispute,
not a repeat of this round.

For the tester: apply exactly the fix set out in VERIFY-GREEN-6-debug.md, round 3 (the fullest
statement of it): the msw rename and the type-only casts in the 19 named test files across
catalog, frontdesk and billing. Test files and the test helper only, nothing in product code.
Confirm tsc gives 0 errors under features/catalog, features/frontdesk and features/billing, and
that vg6, t32 and t35 are green, then commit. Writer and debugger may not make this edit stick;
only a tester commit will survive the next pass.

Reset: C1 VERIFY-GREEN-6 to changes.
