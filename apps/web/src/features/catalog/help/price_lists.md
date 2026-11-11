# Price lists (SCR-13)

Route: `/catalog/price-lists`. Permission to view: `catalog.price_list.read`; editing needs `catalog.price_list.manage`.

## Purpose
All price lists of the lab: the default list and lists for hospitals and companies, doctors and centres.

## How a price is found
Falls through: When an item is missing here, use the next price list (doctor → centre → default). Switch it off when the list must be complete on its own.

## List
Columns: Code · Name · Applies to (Default / Hospital-company / Doctor / Centre) · Assigned to (count) · Current version (number and effective from) · Scheduled · Draft · Status. Filter by Applies to and Status.

## Detail sections
- **General**: Code, Name (up to 120), Applies to (create only), Falls through.
- **Assignments**: the parties, doctors or centres that use this list; max 500. Adding centres needs `identity.centre.read`.
- **Versions**: Version · Status · Effective from · Effective to · Items · Source (Manual/Import) · Change reason · Published by.

## Actions
"Edit prices", "Export to Excel", "Import from Excel" and "Compare versions" (shows the difference between two versions). Publishing, exporting and importing prices are privileged: Requires two-step verification (lock icon).
