# Price-list version editor (SCR-14)

Route: `/catalog/price-lists/{price_list_id}/versions/{version_id}`. Permission to view: `catalog.price_list.read`; editing needs `catalog.price_list.manage`.

## Purpose
Edit the prices of one draft version, then publish it.

## Toolbar
Search (code or name), "Add orderable", "Remove selected", "Save" and "Publish…". Save (`Ctrl+S`) sends changes in batches of 200 rows; each row shows saved or its error text.

## Grid
Columns: Code · Name · Kind · Department · Price (NPR) · Current published price · Change (± %) · Row status. A warning badge appears when the change is above 50 %. Prices are entered in NPR with up to 2 decimals and shown like NPR 1,234.50. No negative prices.
If you leave with unsaved changes the page asks you to confirm.

## Published versions
Published versions open read-only. Use "Create new version" to start a new draft from them.

## Publishing
Publish asks for Effective from and a change reason. It Requires two-step verification (lock icon).

## Keyboard
Arrow keys move between cells; `Enter` edits or commits a cell; `Tab` goes to the next cell; `Delete` marks a selected row for removal; `Ctrl+S` saves; `?` shows the shortcut list.
