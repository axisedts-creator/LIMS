# Stock count

A stock count compares what is on the shelf with what the system believes. Screen: /inventory/counts.

## Blind count

The system quantity is hidden by default (blind count) so counters are not influenced. The switch "Show system quantity" needs the permission inventory.stock.adjust. Enter the Counted quantity per line; Enter saves and moves to the next uncounted line. A scan jumps to that item's first line; "Add line" adds an unknown item and lot pair.

## Review and post

"Review" shows the variance per line and totals. "Post count" needs inventory.stock.adjust and asks what to do with lines nobody counted:

- Leave uncounted lines unchanged (default).
- Treat uncounted lines as zero.

Posting writes count adjustments; the differences appear as wastage on the Wastage report, so leaks and unrecorded repeats become visible. If Settings has "Lock store during count" on, the store is locked while counting.

## Back-dated entries

A back-dated movement is allowed within the back-dating limit in Settings. If it falls before a posted count, the count is not re-opened, and the stock valuation of that past date changes. This is a deliberate decision, documented here.
