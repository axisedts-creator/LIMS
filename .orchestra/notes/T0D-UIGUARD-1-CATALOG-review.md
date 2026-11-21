APPROVE

Reviewed `git diff f983220e6..HEAD` (writer ff0b08ffc, 4016cf3c4; tester 8468b5eb5 per arbiter TESTS_WRONG ruling).

Done when:
1. Rule 1: TestHeader and CatalogForbidden draw the kit PageHeader. /catalog/credit-parties/[credit_party_id] now re-exports the list page (which has a PageHeader) instead of redirecting. No route file was added or removed, and permissions and reads stay the same.
2. Rule 2: kit FilterBar with "Clear filters" on CommentCodesScreen, master-ui (useListFilter), DoctorsList, ImportsScreen, TestImportScreen, PriceVersionEditor, PriceCompare and TestsList. In PriceListDetail and TestMgmtViews the old `lims-filter-bar` rows were form rows; they are reclassed to `lims-inline`. The doctors search still POSTs (D-C3-06).
3. Rule 3: catalog.css has no 600/700 weight (now font-weight-medium) and no px control height.
4. Rule 5: AnalytesTab keeps its thead and shows EmptyRow and PlaceholderRows. "Add analyte" is kept.
5. No CATALOG / features/catalog lines remain in uiguard1.exceptions.ts or notes/T0D-UIGUARD-1-exceptions.md. Nothing was added. The writer did not touch the registry (LD-441).
6. Rule 7: no raw h1–h4/ul/ol under features/catalog/components or app/(staff)/catalog. Headings come from Card region or DrawerSection; lists use role=list/listbox.
7. Tests: only the two tests named by the ruling changed (cattests1:190, unslop1:79-96).

Kit props are additive and small, and are named in the impl notes (LD-441): Card `region`, DrawerSection `action` (a union, so existing onSave callers are unchanged), FilterDef text `search`. tokens.json, kit.css and shell.css are unchanged. Nothing under admin, platform, (auth) or (platform) was touched, and no server, API, permission, route or contract changed. No PHI and no secrets; the report preview data stays synthetic. PRICETOOLS-1 and TESTMGMT-1 are already reviewed and merged, so there is no ownership conflict. 34 files exceeds the brief's 30-file cap, but LD-439(a) requires every area screen to be rebuilt, which supersedes it.

Checks run by the reviewer (per-task vitest configs):
- Green: uiguard1 36/36, unslop1 30/30, cattests1 40/40, catunits1 20/20, emptytbl2 48/48, testfix1 122/122, testmgmt1 141/141, uilist3 173/173, web-t31 125/125, web-t32 107/107, web-t34 116/116, web-t35 96/96. Kit tests for Card, Drawer, FilterBar, uikit, m-series and ui-r03: 330/330.
- Red, but not caused by this diff: emptytbl1 (2, lab worklist/pending), pricetools1 (2, double-click), rs-c3.static (4, server/route baseline), testimport1.source (3, route tree / nav count), web-t33 createDoctor (1, server), web-t38 icd help (3). The diff touches no server, route, nav, help or lab file, and the writer reports all of these red on a clean HEAD. Not re-run on the base tree.
