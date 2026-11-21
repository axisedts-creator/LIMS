APPROVE
Range ceabe14b6..HEAD (82c84efff, c54fee2b5): test-only change in apps/web/src/features/catalog/__tests__/testfix1.pages.test.tsx plus notes; no implementation, route, migration, permission or API change, so RLS/idempotency/rate tier/error codes are not in scope of this diff.
- Follows the ruling: /catalog/tests (4 views) and /catalog/comment-codes 500/network now assert PageError (title, "This page could not be loaded.", Retry, no LEAK); matches app/(staff)/catalog/tests/page.tsx:46-54 and comment-codes/page.tsx:17-22. Other four routes keep the throw (grep: only those two pages import PageError), per ruling (b).
- 403 forbidden, inline warning, leak and never-TypeError checks unchanged; header comment updated per ruling (c). LD-353 rule 6 cited in comments.
- Owned paths only (catalog feature tests, orchestra notes). No PHI, no secrets.
- Ran: testfix1 122/122, testimport1 70/70, rs-c2 74/74 (rs-c2 baseline unchanged). Not rerun: web-t35, testmgmt1 (untouched by this diff).
