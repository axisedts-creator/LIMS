CHANGES

Re-review round 2 of `git diff ecda4cc4c..HEAD` (adds 3ef7eb6ca tester, 2fccd1772 writer). Round 1 items 1 (scratch fork removed), 2 (density regular at all sites), 3 (screens.md added) and the double-click/isRowHeader follow-ups are fixed. Paths: only apps/web/src/features/catalog and .orchestra/notes/T0D-UIX-2-*; no CSS, tokens, route, permission, contract, PHI or secret change. 37 files (limit 40).

Run at HEAD (from apps/web, `pnpm exec vitest run -c src/features/catalog/__tests__/vitest.<name>.config.ts`): uix2 7/7, cattests1 40/40, catunits1 20/20, testmgmt1 141/141, web-t31 125/125, web-t32 107/107, web-t33 102/103 (createDoctor server test; untouched by this diff, pre-existing), pricetools1 190/193, testfix1 120/122.

Remaining defects (done_when 6: touched-feature web tests must be green; both are tests that pin the old markup, so the TESTER changes them):

1. pricetools1 3 tests still pin compact density, contradicting done_when (1) "density regular" and the updated pricetools1.source:
   - apps/web/src/features/catalog/__tests__/pricetools1.compare.test.tsx "no cursor, no \"Load more\" button; the table scrolls inside its own box and is compact"
   - apps/web/src/features/catalog/__tests__/pricetools1.bulk.test.tsx "the preview table is compact density and scrolls inside its own box"
   - apps/web/src/features/catalog/__tests__/pricetools1.detail.test.tsx "every price tool table is compact density (lims-table-compact)"
   Fix: replace the compact assertion with the regular-density assertion (kit DataTable regular class / no `lims-table-compact`); keep the scroll-box and no-"Load more" assertions unchanged.

2. apps/web/src/features/catalog/__tests__/testfix1.pages.test.tsx:184-202 require "Import from Excel" inside the empty message row. The kit EmptyState takes one action (packages/ui/src/components/EmptyState/EmptyState.tsx:9, not owned, kit CSS/kit not editable this round), so the writer placed it as a secondary Button directly under the grid (TestsList.tsx:109). Behaviour is kept: shown only when the unfiltered list is empty, disabled for read-only actors, pushes /catalog/imports; the read-only reason stays as page text (TestsList.tsx:65) and the header New test stays disabled. Fix (tester): in both tests look up "Import from Excel" in the list section next to the grid (e.g. `within(root).getByRole('button', { name: /import from excel/i })`, asserting it is a sibling after the grid) instead of inside `messageRow(t)`; keep the /catalog/imports navigation assertion. Record the reason (EmptyState single action, LD-442 no kit edits) in notes/T0D-UIX-2-tests.md.

Not attributed to this diff (files untouched): web-t33.server createDoctor, rs-c3.static, testimport1.source, web-t38.docs, emptytbl1 loading states. web-t34 116/116 and web-t35 96/96 green at HEAD. No file outside owned paths; no `density="compact"` left in source (only in notes and a negative test assertion).
