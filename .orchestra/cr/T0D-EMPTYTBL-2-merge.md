Title: CR-C0-EMPTYTBL-2-merge: duplicate T0D-TESTMGMT-1 implementation on lane C0-0D dropped in favour of main's
From chunk: C0 (merger, task T0D-EMPTYTBL-2, lane C0-0D)            To owner: C0 lead
Type: code
Blocking? no

Problem (what you cannot do today, with the user story / acceptance criterion it serves):
T0D-TESTMGMT-1 (LD-318) was implemented twice: once on lane C0-0D (commits c2bd7cafc, acfd24c9a, a916325ae, 0b432cf38 — tests revised per ruling, impl NOT yet redone, not reviewed) and once on main (cc435db31..6268045e9 — impl after ruling, debugger round, two reviewer passes). The two are incompatible designs of the same screens (different component split, server helpers, test files), so merging main into the lane conflicted in 15 files.

Resolution applied (merge rule 4: keep main's version):
- All TESTMGMT-1 paths take main's content: catalog pages (tests list, test detail, panel detail), TestForm, ParameterForm, RangeManager, PanelDetail, catalog.css, master-ui, create/update Analyte/Test servers, listTests, rs-c3.baseline.json, testmgmt1 tests/setup/vitest config, and the four T0D-TESTMGMT-1 notes (impl/ruling/tests/verify.cmd).
- Lane-only files removed (would be orphaned / fail against main's components): __tests__/testmgmt1.{kit.tsx,parameter.test.tsx,ranges.test.tsx,server.test.ts,testform.test.tsx}; components/{PanelPicker,TestDetails,TestLists,tm-ui}.tsx; server/{createTestCategory,listTestCategories,setTestTatTargets,updateTestCategory}.server.ts, server/testmgmtActions.ts.
- Kept lane note .orchestra/notes/T0D-TESTMGMT-1-dispute-202611171910.md (history only).

Lane intent lost (recoverable from commit 0b432cf38):
- Lane's separate server helpers for test categories (create/list/update) and TAT targets (setTestTatTargets) — main covers categories in server/testMgmt.server.ts; check main covers TAT target save.
- Lane arbiter ruling a916325ae (TESTS_WRONG, two harness defects) and its revised tests apply only to the lane's suite; not ported.

Proposed change (exact): none required unless the lead finds a lane behaviour (e.g. TAT target editing) missing from main's TESTMGMT-1; then raise a follow-up task.
