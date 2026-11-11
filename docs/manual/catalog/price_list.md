# Price list detail (SCR-13)

Route: `/catalog/price-lists/{price_list_id}`. Permission to view: `catalog.price_list.read`; editing needs `catalog.price_list.manage`.

## Purpose
One price list: its settings, who it is assigned to and its version history.

## Sections
- **Assignments**: add credit parties, doctors or centres (centres need `identity.centre.read`). Max 500.
- **General**: Code, Name (up to 120), Applies to and Falls through. Applies to is set on create only and cannot be changed later. Falls through help: "When an item is missing here, use the next price list (doctor → centre → default)".
- **Versions**: every version with status (Draft, Published, Scheduled, Superseded), effective dates, item count, source, change reason and publisher.

## Actions
- **Edit prices** opens the draft version, or creates one, in the price editor.
- **Export to Excel** prepares a file of the current prices; download it from Excel import/export when ready.
- **Import from Excel** uploads changed prices into a draft.
- **Compare versions** shows added, changed and removed prices between two versions.

Publishing, export and import of prices: Requires two-step verification.

---
In-app help shows the same page (help button in the page header). Back to the [catalog manual](README.md).
