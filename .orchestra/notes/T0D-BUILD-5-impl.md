# T0D-BUILD-5 impl (writer)
- Files: features/quality/server/tat-badge.ts (failure logged), core/shell/AppShell.tsx + Rail.tsx (counts number|string, blank = none), app/(staff)/layout.tsx (one badge call, counts['quality.tat_alerts']), app/(staff)/quality/_lib/nav-badge.ts (new re-export), features/quality/components/Shared.tsx (ChartTable), StatusBoardView.tsx, RunsView.tsx, tat/TatView.tsx, app/(staff)/quality/autoverify/page.tsx + _components/OverviewView.tsx; notes/T0D-BUILD-5-left.md. 11 source files.
- [CONV] layout imports the badge via app/(staff)/quality/_lib/nav-badge.ts: r04 guard forbids feature imports in core/shell and the layout files.
- [CONV] chart cards: kit BarChart (hidden raw table, not owned) replaced by kit DataTable (ChartTable); QC status chart moved below the rows table so it stays the first grid (as RunsView).
- [CONV] TAT: no total in listTatAlerts -> tiles 'at least N' + card note when next page; names from existing filter options, IdText fallback.
- [CONV] autoverify: 404 -> EmptyState 'No auto-verification rules yet.' (New version kept for manage); any other failure -> core LoadError (ErrorState + Reference + Retry), page title kept.
- Review fixes: TatView `more = next || sp.cursor` (a later page is a lower bound too, note text updated); T0D-ELABMENU-3-table.md reverted to 2109ee577.
- Open: inactive departments are not in the options (fall back to id). Line-ending-only diffs on T0D-NAV-COMPLETE-1-admin-hidden.md and rs-c8 snapshot come from test runs, not this task: do not commit them.
