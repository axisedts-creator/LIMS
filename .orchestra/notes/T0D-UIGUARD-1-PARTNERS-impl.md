# T0D-UIGUARD-1-PARTNERS impl (writer)
Files: partners/components ManifestInbox, PenaltyEvents, TicketInbox (hand `role=search .lims-filter-bar` div -> kit `<FilterBar>`, same controls as children; ManifestInbox reset via `onReset`), SalesRepresentatives (APG tree ul/li -> div role=tree/group/treeitem, roles+keys unchanged), TicketThread (raw h2+ol -> kit `Card title` + `role=list` timeline items); core/shell/shell.css +1 token-only rule `.lims-tree-group` (team indent); notes/T0D-UIGUARD-1-exceptions.md both PARTNERS sections deleted (20 entries). Registry untouched (LD-441).
[CONV] PartysetCommon already on FilterBar (BILLING lane): no change. No kit prop added: FilterBar children/onReset (LD-441) cover all three rows.
[CONV] Native date inputs kept as FilterBar children (no picker library, original design); display only, no route/permission/contract/API change.
Owners: T0B-SALES-1, T0B-PARTYSET-1, T0B-MSGDESK-1 reviews APPROVE (done), so their files were editable.
Checks: build:nav ok; uiguard1 36/36; uiguard1-partners 25/25; t16 120, partyset1 165, sales1 102, msgdesk1 134, uilist3 20, uiset1 5; shell uikit2 59, m2 324, m4 330, r04 76 all green. tsc: no errors in touched files.
rs-cN snapshots: none cover partners screens, nothing to re-record (LD-440).
Open: no browser pixel check against the Worklist mock; eslint not installed in apps/web.
