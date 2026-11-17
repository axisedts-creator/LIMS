# Excel import/export and import detail (SCR-18, SCR-19)

Route: `/catalog/imports` and `/catalog/imports/{import_id}`. Permission: the permission of the import kind, for example `catalog.price_list.manage` for price lists and credit parties, `catalog.test.manage` for the catalog master, `catalog.referrer.manage` for doctors.

## Purpose
Load or update many items at once from Excel, and download current data.

## Import
Excel .xlsx only, up to 15 MB. Macro files (.xlsm) are not accepted.
Choose the kind: "Price list prices" (then choose the price list), "Catalog master (tests, analytes, ranges, panels, comment codes)", "Doctors" or "Credit parties". Use "Download blank template" or "Download current data".
Price import and export: Requires two-step verification.

## Commit
The commit dialog asks for Effective from and a change reason. Options: "Publish immediately" (price lists), "Replace open drafts" (open drafts of these items are discarded first), and a stale-base checkbox when the price list was changed after this file was exported. Price imports need a typed confirmation of the price list code. Catalog-master commits that publish analyte versions or ranges need `catalog.reference_range.publish`.

## History and exports
History lists every import with its status. Exports show Download when ready. If the file is not ready you see "Still preparing — try again shortly".
The import page refreshes every 2 seconds. After 15 minutes it shows "This is taking longer than expected. You can leave this page; the import continues."

## Import detail
Steps: Uploaded → Security scan → Validating → Ready to commit → Committing → Committed. Tiles show Rows, Added, Changed, Removed, Unchanged, Errors, Warnings. The issues table lists each problem, for example "Price has more than 2 decimal places." Use "Download annotated file" to get your file back with the issues marked.
