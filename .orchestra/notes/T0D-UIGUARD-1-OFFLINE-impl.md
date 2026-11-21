# T0D-UIGUARD-1-OFFLINE impl (writer)
Files: core/offline/ui/OfflinePanel.tsx (kit PageHeader with Sync now in actions, helpKey offline.panel; Pending/Needs attention/Conflicts/PIN as kit Card title rows in a Stack; NotAvailable without snapshot; resolve side titles role=heading level 3), core/offline/ui/OfflineShell.tsx (Modal title role=heading level 2), notes/T0D-UIGUARD-1-exceptions.md (both OFFLINE sections deleted). Registry not touched.
[CONV] tables stay hand drawn lims-table + lims-table-compact (kit classes): rows open an inline detail row the kit DataTable has no slot for; tables named by aria-label = card title.
[CONV] own Modal kept, not kit Dialog: kit Dialog lacks alertdialog role and a non-dismissable PIN prompt, both pinned by offline2. Heading via role=heading (precedent: billing InvoiceDocument, reporting PrintStationery).
Checks: verify.cmd green (uiguard1 36/36, uiguard1-offline 11/11); offline1 82, offline2 140, offline3 88, offline4 58 all pass; tsc no offline errors. No eslint binary in apps/web.
rs-cN snapshots: none cover /offline, nothing re-recorded. No old-markup test needed changing.
Open: pixel match to the Worklist mock not checked in a browser.
