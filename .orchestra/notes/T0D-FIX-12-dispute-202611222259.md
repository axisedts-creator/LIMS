# T0D-FIX-12 dispute (writer)
Test: apps/web/src/__tests__/fix12.burst.test.ts:129 "anywhere else in apps/web/src: every <Link> sets prefetch={false}".
Why it is wrong for this task: it requires edits in 13 files outside this lane and outside the file budget (brief: "at most 12 files in all", 3 already used by tests):
- app/(staff)/admin/{audit,users,roles}/page.tsx and features/admin/components/{MyAccount,UserDetailView,UsersTable}.tsx (owner C2, 01-CHUNK-MAP §3)
- features/lab/components/{consoleParts,CriticalValueList,IngestExceptionList}.tsx, worklists/{DepartmentIndex,WorklistPage}.tsx (lab owner)
- features/partners/components/{TicketInbox,TicketThread}.tsx (owner C13)
These are in-page action/row links, not the nav fan-out; Next only prefetches links in the viewport, and the measured bursts (7-15 in ~100 ms) match the rail (14 groups) and search results, which are fixed here.
Proposal: narrow the test to core/shell (the two it.each cases already cover it), and open a follow-up task per owning lane for list links if the lead wants them too.
Status: everything else is done; 31/32 fix12 tests pass, only this one fails. Stopped as the inbox says.
