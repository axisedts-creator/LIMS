# T0D-UIGUARD-1-MICRO tests (tester)
- Edited: apps/web/src/core/__tests__/uiguard1.exceptions.ts. Deleted the MICRO block (6 rule 7 legacy routes, LD-441). Nothing added. No new test file: uiguard1.guard.test.ts proves done_when 3, 4, 5.
- Area pages (6): /micro/worklist, /micro/instrument-records, /micro/settings, /micro/breakpoint-sets, /micro/breakpoint-sets/[breakpoint_set_id], /micro/cultures/[culture_id].
- Red now (rule 7 only; guard 35 pass, 1 fail): raw h1 in MicroForbidden.tsx (all 6 pages), raw h3 ReportDrawer.tsx, raw ol ReadsTab.tsx, raw h2/h3 DictionariesTab.tsx + MappingsTab.tsx, raw ul ChooseCultureDialog.tsx.
- Writer: rebuild screens, delete MICRO lines in notes/T0D-UIGUARD-1-exceptions.md. Never touch the registry. Old-markup pins in micro t19 to t24 may change only where they pinned old markup.
- Run: .orchestra/notes/T0D-UIGUARD-1-MICRO-verify.cmd (guard, then micro t19 to t24 and t26 configs; micro has no rs-cN snapshots).
