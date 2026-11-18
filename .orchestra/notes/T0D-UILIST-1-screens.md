# T0D-UILIST-1 screens (template 1 LIST unless noted)
| Route | Changed | Left / why |
|---|---|---|
| /lab/worksheets, /lab/worklists (+ department) | PageHeader, DataTable with header + EmptyState (departments listed) | — |
| /lab/qc | title = menu name, dev sentence removed, Add QC result in header | — |
| /lab/pending, /lab/critical-values, /lab/ingest-exceptions, status board | PageHeader, table header kept when empty | verification/approval queues: T0D-VERLEVEL-1 |
| /micro/instrument-records | one FilterBar (status, instrument, Received from/to) | — |
| /micro/worklist | ErrorState / NotAvailable inside the page | — |
| /micro/breakpoint-sets | title Breakpoint sets | detail screens not touched |
| /micro/settings | organism / Gram columns no-wrap | other tabs not touched |
| /reporting | one FilterBar, slim critical-alerts ErrorState with Retry, empty + checkbox column merged | — |
| /reporting/outsourced | one FilterBar | settings forms: T0D-PRINTCFG-1 |
| /anatomic, /anatomic/batches | landing loadOr ErrorState; batches one FilterBar, New batch once | case page error.tsx kept (ruling 3) |
| /smartreport summaries, library | ErrorState / NotAvailable in page | — |
| /instruments/agents, /instruments/instruments, /instruments/settings | ErrorState in page; instruments list = table with header (was cards); settings titled | messages log: T0D-UILIST-2 scope (LD-360) |
| /quality runs, observations | pendingOr NotAvailable, Needs action inside FilterBar | — |
