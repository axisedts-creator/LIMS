# T0D-UIX-2 tests (tester)
- `apps/web/src/features/catalog/__tests__/uix2.markup.test.ts` — source scan of non-test .tsx under features/catalog (comments stripped).
- `apps/web/src/features/catalog/__tests__/vitest.uix2.config.ts` — test-only config (node env, includes only uix2.*).
- Fails if any raw `<table`, `<dl` or `<button` remains; lists file (count) per tag. Also needs DataTable, DescriptionList, Button imported from `@lims/ui` somewhere in catalog.
- ALLOW (file -> tag -> reason) is empty: no exception needed (EditableGrid is kit code; no `<button>` for file input). Stale entries fail.
- Run: `.orchestra\notes\T0D-UIX-2-verify.cmd` (or `pnpm --dir apps/web exec vitest run -c src/features/catalog/__tests__/vitest.uix2.config.ts`).
- Not covered by test: floating label/value divs (AC 4) and the screens list (notes/T0D-UIX-2-screens.md) — not greppable; reviewer checks.

## Review round: tests that pinned the old raw-table markup (done_when 6)
The kit DataTable is a react-aria grid: role `grid` (not `table`), cells `gridcell`/`rowheader`, caption = aria-label, rows have no accessible name.
Updated selectors only (no test skipped or weakened): cattests1 (also :499 now asserts the grid's accessible name), catunits1, pricetools1.compare (grid name), testmgmt1.screens, testmgmt1.test-form, web-t31, web-t33, web-t34 (`rowOf` falls back to row text for DataTable rows), web-t35 (row lookup by text), web-t32 (`td` instead of role cell).
pricetools1.source now asserts `<DataTable`, `density="regular"`, `emptyState=`, no `<table`, no `density="compact"` — FAILS until the writer sets density regular (review item 2).
Run each: `pnpm --dir apps/web exec vitest run -c src/features/catalog/__tests__/vitest.<name>.config.ts`. Green after edits: cattests1 40, catunits1 20, testmgmt1 141, web-t31 125, web-t32 107, web-t34 116, web-t35 96.

## Still failing, for the WRITER (not test defects; tests left unchanged)
1. testfix1.pages (2 tests): "Import from Excel" moved out of the empty row, and the read-only empty row lost its disabled New test + reason (TestsList.tsx:103-109). Behaviour change; both actions must stay with the empty state.
2. pricetools1.source: density compact -> regular (10 sites, see review item 2).
3. pricetools1 double click (compare Export CSV downloads twice; detail 409 save PUTs twice): handlers unchanged in the diff but the raw button became kit Button; likely regression of this diff, writer to restore the single-fire guard. Not confirmed at base (no base worktree).
4. web-t31 logs "A table must have at least one Column with the isRowHeader prop set to true": a DataTable without an `isRowHeader` column (tests still pass, React recovers). Add `isRowHeader: true` to the first column.
5. Not from this diff (unchanged): web-t33.server createDoctor, rs-c3.static, testimport1.source, web-t38.docs, emptytbl1 loading states.

## Round 2 (review items 1-2, tests only)
- pricetools1.compare / .bulk / .detail: compact assertion -> `lims-table-regular` (and not `lims-table-compact`); scroll-box and no-"Load more" assertions kept.
- testfix1.pages (2 tests): "Import from Excel" now looked up as the one button after the grid in the list section, not in the message row; /catalog/imports navigation kept. Reason: kit EmptyState takes a single action, kit not editable (LD-442). New test stays in the row and header.
- No snapshots touched, no vitest -u (LD-443).
