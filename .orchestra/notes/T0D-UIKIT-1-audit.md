# T0D-UIKIT-1 audit (writer): existing kit parts vs LD-353
- FilterBar { filters, value, onChange, onReset, data-testid }: wrapped rows (flex-wrap wrap), no min-width 0, label 13px, text search full width, no Search button. Fixed: nowrap + wrap under 64rem, min-width 0, label 12px above, `.lims-filter-search` <= 24rem, optional `onSearch`.
- DataTable { columns, rows, getRowId, isLoading, error, emptyState, page, sort, selection, density, stickyHeader, rowStatus, bulk*, onRowAction, rowActions*, caption, virtualize }: error replaced the whole grid (no header row); scroll box only when virtual; no sticky column, column chooser, numeric or cellTitle. Fixed: header row in every state, `.lims-table-scroll` always, `stickyFirstColumn`, `columnChooser`, ColumnDef `numeric`, `cellTitle`, min-width 0.
- EmptyState { title, body, action, icon }: matches rule 6; unchanged.
- ErrorState { title, body, requestId, onRetry }: no page title. Added optional `pageTitle` (h1 above the state).
- NotAvailable (web core/shell): moved to the kit (+ optional `body`); web file re-exports it, keeps isPending / pendingOr.
- StatTile { label, value, delta, href }: no freshness and no row layout. Added `isStale` / `refreshedAt` / `staleReason` (badge only when isStale) and `StatTileRow` (equal grid, `lead`).
- PageHeader / PageShell: match the LD-344 / LD-352 shell values; unchanged (no gap against LD-353 found in the kit part).
- New: ChartCard, SplitConsole, ScanPanel, SettingsForm (templates 5, 2, 3, 4).
