# T0D-UIGUARD-1-QUALITY tests (tester)
- Only test change: apps/web/src/core/__tests__/uiguard1.exceptions.ts. Deleted all QUALITY legacy blocks (rule 2 x6 routes, rule 6 x1 route of LD-434; rule 7 x12 routes of LD-436). 25 lines out, nothing added.
- Guard uiguard1.guard.test.ts now red on the real violations: rule 2 (LjView, DecisionsView hand built filter row), rule 6 (ReportView chart without ChartCard), rule 7 (LjView, RunDetailView, ReportView, RuleDrawer, DecisionsView, SettingsView, MaterialsView, TargetsView raw h3/h2/ul). 3 red, 33 green. No new test file needed.
- Writer: fix screens until green, then delete the QUALITY lines from notes/T0D-UIGUARD-1-exceptions.md (writer-owned). Nobody re-adds entries (LD-439). rs-cN snapshots: writer re-records (LD-440).
- Run: .orchestra/notes/T0D-UIGUARD-1-QUALITY-verify.cmd (build:nav, then the uiguard1 vitest config, from apps/web).
- Not run by me: the quality feature tests (quality-t21/t22/t24, uidash1/uilist1/uiset1, av-t23); the writer updates only those that pinned old markup.
