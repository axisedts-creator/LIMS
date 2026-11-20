# T0D-UILIST-1 tests (tester)
Files (apps/web/src): __tests__/uilist1.helpers.tsx (shared asserts), __tests__/vitest.uilist1.config.ts (only these tests);
features/{lab,micro,anatomic,reporting,smartreport,instruments,quality}/__tests__/uilist1.<feature>.test.tsx. Each page: no rows + one row + 500/501 where named.
Pins: PageHeader title = menu label, one primary action once, ONE FilterBar, table header row when empty inside .lims-table-scroll, EmptyState in body, ErrorState/NotAvailable keep the h1 (no throw), micro settings cells no-wrap.
Run: .orchestra/notes/T0D-UILIST-1-verify.cmd (build:nav, the uilist1 config, then the web-style-3 config for the added CSS).
Now: 52 of 76 fail for the right reasons (old markup, pages throw on 500/501, 2x New batch/New agent, no FilterBar, no table when empty); 24 pass. Not covered: culture/breakpoint detail, settings other tabs, snapshots (writer regenerates rs-cN per LD-362).
