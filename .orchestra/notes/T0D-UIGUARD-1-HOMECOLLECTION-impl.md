# T0D-UIGUARD-1-HOMECOLLECTION impl (writer)
Files: apps/web/src/features/homecollection/components/DispatchBoard.tsx; notes/T0D-UIGUARD-1-exceptions.md (HOMECOLLECTION section deleted, nothing added).
- Rule 2: filter row is kit `<FilterBar onReset>`; Date, Centre, Status, Kind, Needs attention as children (LD-441 children prop, no new kit prop). Reset keeps date+centre. Refresh stays in PageHeader.
- Rule 5: no routes draws a "Routes" Card with a DataTable (header kept, empty text "No routes for this date."); Flags early-return rewritten as a ternary (guard earlyReturn hit).
- [CONV] empty routes table uses ROUTE_HEAD = RouteCard columns minus Actions (no rows, so no buttons).
- Rule 7: no raw h1-h4/ul/ol in the area. No rs-cN snapshot covers homecollection, none re-recorded. Display only: no route/permission/API change.
- Checks: uiguard1 config 36/36; uiguard1-homecollection 10/10; hc-t19 96/96; hc-t20 148/148; hc-t30 23/23; tsc clean for homecollection.
- OPEN: hc-t18.source.test.ts 2 red on tests/e2e/HC-T30.nightly.spec.ts (@playwright/test import, "Bearer" text) — tester file from f40e545d6, not touched here; tester/debugger to fix. eslint not runnable in apps/web (command not found).
