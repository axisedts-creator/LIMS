# T0D-UIGUARD-1-ANATOMIC tests (tester)
- Edited: apps/web/src/core/__tests__/uiguard1.exceptions.ts. Deleted the whole ANATOMIC legacy7 block (8 rule 7 routes, LD-441). Nothing added. The rule 3 label-sheet entry (print layout) is not legacy and stays.
- No new test file: the guard (uiguard1.guard.test.ts) is the proof for done_when 1-4. Rule 7 = no raw h1-h4/ul/ol.
- Red now, for the right reason: rule 7, 8 routes. Raw h1 in AnatomicForbidden.tsx and config-shared.tsx; raw h2/h3/ul/ol in CaseWorkspace, ImagesTab, BatchDetailScreen, AssaysTab, TemplateEditor, TemplatePreview, TrackingScreen, MovementDialog. 35 other guard tests pass.
- Writer: fix those files, delete the 8 ANATOMIC lines in notes/T0D-UIGUARD-1-exceptions.md (section at line 184); do not touch the registry.
- Snapshots rs-cN.* are writer/debugger-owned (LD-440): not touched by tester. Old markup pins in features/anatomic/__tests__ (t19-t23, uilist1, uiset1, uiscan1) change by the writer's call only if they pin old markup.
- Review round (item 1): t22.batches "empty", t22.molecular "empty", t23.config "empty" now expect the kit DataTable/grid: header row kept, one body row = `.lims-state` with the same title; the [New template] link and [Add row] checks stay. Added tester config features/anatomic/__tests__/vitest.anatomic.config.ts; verify.cmd now also runs those 3 files (all green, 172/172).
- Review item 2 (t19.nav chord 'g t' undefined) is NOT a test fix: pre-existing, nav.manifest owned by T0D-MSERIES-2; left red and out of verify.cmd. Writer lists it in impl note; debugger/lead own it. Items 3-4 are writer work.
- Run: .orchestra/notes/T0D-UIGUARD-1-ANATOMIC-verify.cmd
