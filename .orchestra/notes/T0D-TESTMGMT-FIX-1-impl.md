# T0D-TESTMGMT-FIX-1 impl (writer)
- Root cause: `listAllTests` read `r.page.next_cursor`; an empty list answer without `page` (or `page:null`) threw TypeError → error boundary. Fix `r.page?.next_cursor` in server/listTests.server.ts (+ type `page?: … | null`); rs-c3.baseline.json hash for that file updated (tester-authorised).
- app/(staff)/catalog/tests/page.tsx: list view (departments, specimen types, categories) and categories view (departments) use `soft()`: failure → empty list + one `role="note"` "X could not be loaded" (no code/status). Main list keeps orForbidden (403 page / ApiError throw).
- app/(staff)/catalog/comment-codes/page.tsx: departments optional, same note.
- components/TestsList.tsx: empty row adds `Import from Excel` button → /catalog/imports, disabled for read-only. [CONV] same Button+router.push as CatalogHome.
- Checks: testfix1 122/122, testmgmt1 141/141, cattests1 40/40, catunits1 20/20, emptytbl2 48/48; tsc clean on changed files.
- Open: rs-c3 still fails 3 checks from earlier tasks' drift (actions.ts, specs.ts, listValueSets, testMgmt* imports) — not this task; its baseline needs a refresh owner. Staging not re-verified.
