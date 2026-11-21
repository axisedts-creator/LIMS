# T0D-UIGUARD-2 dispute (writer)
Test: uiguard1.guard.test.ts > rule 2 "every page uses FilterBar (no hand built filter row)" fails for /partners/tickets and /partners/tickets/[ticket_id].
Cause: apps/web/src/features/partners/components/TicketInbox.tsx:109 `<div role="search" className="lims-filter-bar">` (T0D-MSGDESK-1, landed after UIGUARD-1). Red at HEAD before this task; not caused by rule 7.
The test is right; the fix is out of this task's files (core/__tests__ + notes) and TicketInbox is a partners screen owned by T0D-UIGUARD-1-PARTNERS. The tester notes say lead rules.
Options: (A) writer swaps the div for kit FilterBar in TicketInbox.tsx (display only, 1 file); (B) tester adds two rule 2 legacy entries (LD-434, fix in T0D-UIGUARD-1-PARTNERS) and writer adds matching note lines.
Writer suggests A (smallest, no new baseline). Everything else green: 35/36.
