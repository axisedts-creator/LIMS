APPROVE

Reviewed git diff 5f3f265d6..HEAD (8 files, only owned paths: DispatchBoard.tsx, homecollection tests/config, notes mirror, registry by tester per LD-441).
- done_when 1 (rule 2): DispatchBoard renders kit `<FilterBar onReset>` with children (LD-441 children prop already in kit, no new kit prop). Reset URL identical to old hand built row (keeps date + centre). Refresh stays in PageHeader.
- done_when 2 (rule 5): empty routes draws Card "Routes" + DataTable with ROUTE_HEAD header and the same empty text; Unassigned grid keeps header.
- done_when 3: both HOMECOLLECTION legacy entries removed from uiguard1.exceptions.ts (tester) and the mirror notes section (writer); nothing added.
- done_when 4: no raw h1-h4/ul/ol in features/homecollection (grep); no rule 7 entry for the area.
- Display only: no route, permission, contract, operation or API change; no PHI in logs, no secrets, nothing invented.
Checks run by reviewer: uiguard1 guard 36/36; uiguard1-homecollection 10/10; hc-t18 133/135; uilist3 homecollection 24/24; uiset1 homecollection 4/4; uiscan1 handover 4/4.
Non-blocking, pre-existing: hc-t18.source.test.ts 2 red on tests/e2e/HC-T30.nightly.spec.ts (commit f40e545d6, ancestor of base, not in this diff) — tester/debugger follow-up, not a defect of this task.
Not verified: pixel match to the worklist mock (no browser).
