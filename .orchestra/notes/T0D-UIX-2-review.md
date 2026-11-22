CHANGES

Reviewed `git diff ecda4cc4c..HEAD` (commits 4a892ad2d tester, afba75c9f writer). uix2.markup.test.ts: 7/7 pass. No route, permission, contract, server, CSS, tokens or PHI/secret change found. 24 files (limit 40). Defects:

1. apps/web/.uix2-forkB/PriceCompare.tsx and apps/web/.uix2-forkB/PriceListDetail.tsx: scratch copies committed outside the owned paths (brief: "apps/web/src/features/catalog (non-test .tsx)"). Fix: `git rm -r apps/web/.uix2-forkB`.

2. done_when (1) says "density regular". These use `density="compact"`: BulkUpdateDialog.tsx:142, compact-ui.tsx:135, PanelMembers.tsx:61, PriceCompare.tsx:120, PriceListDetail.tsx:235, PriceListTools.tsx:176 and :224, TestDetailsView.tsx:127 and :172, UnitsScreen.tsx:151 (all under apps/web/src/features/catalog/components/). Fix: set `density="regular"` (or drop the prop; regular is the kit default).

3. done_when (4) deliverable missing: `.orchestra/notes/T0D-UIX-2-screens.md` (the list of changed screens) does not exist. Fix: writer adds it.

4. done_when (6) is not met: catalog web tests fail at HEAD because they still pin the old raw-table markup. A test that pinned old markup may change, so the tester must update these. They must not be skipped:
   - cattests1.tests-page.test.tsx (27 tests) and catunits1.units-page.test.tsx (5): `getByRole('table')`. The kit DataTable is a react-aria grid (packages/ui/src/components/DataTable/DataTable.tsx:2 and :220, aria-label=caption). Fix: query `getByRole('grid', { name })`.
   - cattests1.tests-page.test.tsx:499 `expect(text).toMatch(/Tests/)`: the caption is now an aria-label, so it is no longer text content. Fix: assert the grid's accessible name instead.
   - pricetools1.compare.test.tsx "the table has a caption or accessible name": same role change. Fix: use role grid.
   - pricetools1.source.test.ts "compact table class and empty-row kit parts": pins `lims-table-compact`/EmptyRow. Fix: assert DataTable with `density="regular"` and an `emptyState`.
   - web-t31 (DepartmentsList read-only), web-t32 (Analytes sort order), web-t33 (PanelsList read-only), web-t34 (PriceListsList, PriceListDetail versions/assignments, PriceSimulator, 4 tests), web-t35 (ImportsScreen/ImportDetail tables, 4 tests), testmgmt1.screens (columns; 25-row paging), testfix1.pages (empty list row actions, 2 tests). Fix: for each, re-run it, confirm the failure is only the table→grid or row markup, and then update the selector.
   - testfix1.pages "the row holds the two actions": the writer moved "Import from Excel" out of the empty row (TestsList.tsx:109), and the read-only empty row no longer shows a disabled New test with a visible reason (TestsList.tsx:105). This is a behaviour change, not only markup. Fix: keep both actions with the empty state, and keep the disabled-with-reason control for read-only actors (EmptyState `action` or the `body` text). Or the tester confirms the old behaviour is not required, and records why.

Not attributed to this diff. These look pre-existing; the diff touches none of the files involved. Confirm at base ecda4cc4c (a base worktree was not permitted in this session):
- rs-c3.static (server hashes, route tree) and testimport1.source (route tree, nav manifest).
- web-t38.docs: help/icd.md is missing.
- emptytbl1 worklist/pending loading states.
- web-t33.server createDoctor.
- pricetools1 double-click tests (compare Export CSV, detail 409 save; both deterministic). The handlers are unchanged in the diff. If they pass at base, they are a regression of this diff and must be fixed.

Commands run (from apps/web): `pnpm exec vitest run -c src/features/catalog/__tests__/vitest.<name>.config.ts` for uix2, cattests1, catunits1, emptytbl1, emptytbl2 (48/48), pricetools1, rs-c3, testfix1, testimport1, testmgmt1, uilist3 (173/173), web-t31..35, web-t38.
