LEAD ITEM, LD-425 (2026-11-19):

Cause: identical mechanism to VERIFY-GREEN-6 and VERIFY-GREEN-7 (LD-423, LD-424). The writer own
roughly 190 test-file edits were not in the tree (the commit held only the impl note; 178 files
still used the old msw call; 287 tsc errors under apps/web/src). The debugger redid the
identical fix and reports it green (tsc under apps/web down from 296 to 9, the remaining 9 all
in apps/portal and already covered by VERIFY-GREEN-5, not this task; gate vitest.vg8 8 of 8; the
lab, instruments and catalog suites named in the debug note green), but the edits are again
uncommitted, for the same Enforce reason as LD-423 and LD-424: an existing test file can only be
kept by the tester.

RULING: route through the tester, same as LD-423 and LD-424. The fix is already fully specified
in the debug note and already proven to pass; no further debug rounds are needed on this
specific fix.

For the tester: apply exactly the fix in VERIFY-GREEN-8-debug.md: the msw rename across the 178
named test files, the lab non-null marks, and the roughly 30 type-only casts and markers in the
other 25 named test files. Test files only, no product file, no assertion loosened, no
escape-hatch cast, matching the debug note exactly. Confirm tsc under apps/web goes from 296 to
9 (the remaining 9 are apps/portal, VERIFY-GREEN-5 own scope, not this task), gate vitest.vg8 is
8 of 8, and the lab, instruments and catalog suites named in the debug note stay green, then
commit. Writer and debugger may not make this edit stick; only a tester commit will survive the
next pass.

Reset: C1 VERIFY-GREEN-8 to changes.
