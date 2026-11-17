```
Title: CR-C0-0D-ELABMENU-3: Raise the T0D-ELABMENU-3 file cap from 30 to 55, or split the task, so every sidebar page heading can match its ElabAssist menu label
From chunk: C0-0D            To owner: C0-0D (lead)
Type: ui-kit
Blocking? yes (T0D-ELABMENU-3 in C0-foundation-contracts 06-IMPLEMENTATION-PLAN is blocked)
Problem (what you cannot do today, with the user story / acceptance criterion it serves):
  LD-340 plus the founder's 2026-11-17 20:37 NPT instruction "keep it aligned with ElabAssist". Brief done_when (2) requires every page reached
  from the sidebar to use the menu label as its heading. done_when (7) requires a nav-manifest walk test for this. The tests
  (apps/web/src/core/nav/__tests__/elabmenu3.walk.test.ts, apps/web/src/features/catalog/__tests__/elabmenu3.screens.test.tsx)
  fail on 123 cases across 61 source files. Those headings are hard-coded literals
  (e.g. features/catalog/components/DepartmentsList.tsx:35 `title="Departments"`), so each screen file needs its own edit.
  After the pinned admin/platform pages are listed in the notes (done_when 6), about 50 files plus messages.ts remain. The brief caps the task at 30 files.
Proposed change (exact):
  Option A (recommended): change the T0D-ELABMENU-3 brief `files` cap from "at most 30 files in all" to "at most 55 files in all".
    The exclusions stay as they are: none under features/admin, features/platform, app/(auth), app/(platform).
  Option B: split the task.
    T0D-ELABMENU-3 covers catalog, billing and lab, plus the render walk test scoped to those nav groups (about 28 files).
    New T0D-ELABMENU-4 covers micro, reporting, smartreport, analytics, quality, inventory, engagement, homecollection, frontdesk, partners and the app/(staff)/admin pages.
    The walk test scope is removed when ELABMENU-4 closes.
Backward compatible? yes. Headings and empty-state text only; no route, permission, contract or API change (done_when 8); no message key renamed or removed.
Tenant/security impact: none. No RLS change, no PHI field, no new public surface.
IRD/regulatory impact (billing changes only): none (display text only).
Alternatives considered: changing only messages.ts values (does not work, because the headings are literals);
  scoping the walk test down in this task without a lead ruling (rejected, because it weakens the test that done_when 7 requires).
Tests that will prove it: elabmenu3.walk.test.ts, elabmenu3.screens.test.tsx, elabmenu3.table.test.ts, the T0D-ELABMENU-1 shell tests and the
  touched feature web suites all green, and the rs-c2 baseline unchanged.
```
