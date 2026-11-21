# T0D-UISCAN-1 screens (LD-353 template 3 SCAN)
| Route | Tpl | Changed | Left, why |
|---|---|---|---|
| /lab/receive | 3 | Scan panel (input, result card, queue); session-log tabs became 4 status pills with counts in one FilterBar; Auto-accept switch moved to header slot; location select stands alone; queue header always shown + EmptyState "Scan a label to start"; denial keeps h1 | Scan handling, auto-accept, reject dialog unchanged |
| /lab/collect (Collect, Dispatch tabs) | 3 | Scan panel per tab; Collect list became a table (Barcode, Type, Tests) with checkbox; Dispatch table header always shown; last scan message is the result card; denial keeps h1 | Tabs and their counts unchanged |
| /anatomic/tracking | 3 | Scan panel; looked-up block or slide (or message) is the result card; basket DataTable is the queue | Sent out tab is a list (already DataTable); single lookup has no queue |
| /homecollection/handovers (drawer) | 3 | Pending handover: scan panel, result card (barcode: Received / not in this handover), tubes DataTable as queue; duplicate field error removed (card carries it) | Handled handover unchanged (no scan) |
| /inventory/counts/[count_id] | 3 | Scan panel with result card (item code and name only, blind count kept) and lines DataTable as queue | Viewer without manage: table only |
| /inventory/receipts (New receipt drawer), PO editor | 6 | Shared ScanBox wears the kit panel markup + result card (GRN only sets the card) | Line rows are an entry form |
Not touched: partners ManifestReceive (not in task list), micro worklist/scan dialog, anatomic molecular batch, inventory bench (other templates / tasks). No CSS added (kit.css ScanPanel rules from T0D-UIKIT-1 used).
