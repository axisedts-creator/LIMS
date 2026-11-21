IMPLEMENTATION_WRONG — the rule 2 test is right; take option B (legacy baseline entries), not option A.
Reasons:
1. Brief done_when (6) (.orchestra/inbox/T0D-UIGUARD-2-arbiter.md:19): "the other six rules of the guard are unchanged and green" — the rule 2 assertion (uiguard1.guard.test.ts:51-56) must stay as is and pass; the test is not wrong.
2. TicketInbox.tsx:109 hand builds a filter row (`<div role="search" className="lims-filter-bar">`), a real rule 2 breach (guard.test.ts:3, rule (2)).
3. Option A is out of scope: brief files (arbiter.md:14-18) are core/__tests__ + notes only; TicketInbox.tsx is a partners screen that LD-439 (a) (arbiter.md:39) assigns to open task T0D-UIGUARD-1-PARTNERS; brief arbiter.md:19 "If a not done T0D task lists a file as its own, leave that file alone and list it in the notes".
4. The registry is in scope ("extend the uiguard1 ... exceptions", arbiter.md:15) and the LD-434 method is the sanctioned path (uiguard1.exceptions.ts:7-11; REAL regex guard.test.ts:70).
What the implementation must do:
- In apps/web/src/core/__tests__/uiguard1.exceptions.ts add two rule 2 entries via the existing LD-434 helper (exceptions.ts:11), feature PARTNERS, for '/partners/tickets' and '/partners/tickets/[ticket_id]', files features/partners/components/TicketInbox.tsx. Reason must read 'legacy baseline LD-434, fix in T0D-UIGUARD-1-PARTNERS: ...'.
- Add the two matching lines to notes/T0D-UIGUARD-1-exceptions.md (noting the breach came from T0D-MSGDESK-1 after UIGUARD-1), and do not touch TicketInbox.tsx.
- The stale check (guard.test.ts:75-78) then fails on them, which forces their removal, once T0D-UIGUARD-1-PARTNERS swaps in kit FilterBar; LD-439 (b) bars any PARTNERS legacy entry surviving that task.
