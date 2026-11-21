APPROVE

# T0D-UIGUARD-1-INVENTORY review (reviewer), diff 3aff146c8..HEAD

Checked against done_when (1)-(5), LD-438, LD-439, LD-440 and LD-441.
- (1) rule 2: RulesView now uses kit FilterBar with the same URL keys (kind/test/analyser/item/history). The item Combobox and the Show history switch sit in the new additive `children` slot, and reset reads "Clear filters".
- (2) rule 6: the ReportBody daily_consumption BarChart is wrapped in ChartCard.
- (3) the INVENTORY rule 2/6/7 entries are gone from uiguard1.exceptions.ts (tester, LD-441) and from notes/T0D-UIGUARD-1-exceptions.md (writer). Nothing new was added. The new test asserts the registry has no INVENTORY or /inventory line.
- (4) rule 7: no raw h1-h4 or ul/ol remains in features/inventory/components or app/(staff)/inventory (grep shows 0). The uiguard1.inventory test checks every component file.
- Display only: no route, permission, action, API or contract change. No PHI or secrets. Paths are owned: inventory components, kit additive props and the writer mirror notes. tokens.json, kit.css and shell.css are untouched, and nothing under admin, platform or (auth) was edited.
- Kit props are additive and keep the default markup: FilterBar `children`, Timeline `title` and `labelFirst`.

Runs (reviewer, lane tree):
- verify.cmd (build:nav + uiguard1-inventory config): 98/98 pass.
- vitest.t20 config: 171/172 pass. The failure is "API 500 -> page throws"; AlertsView and its page are not touched by this diff.
- vitest.t23 config: 229/230 pass. The failure is "In transit Card lists transfers". The test uses closest('section,div,article') from the title, which lands in lims-card-head (T0D-UIKIT-2). This is a stale tester pin, not caused by the ul->p change.
- vitest.t25 config: 107/107 pass.
- packages/ui uikit1.table, batch2-display, batch2-data: 161/161 pass.
- Not run: the t21, t22 and t24 configs.

Open items for the lead (not defects of this diff):
- The t23 pin needs the tester to fix it (closest('.lims-card') or a role query). The t20 alerts 500 test is pre-existing.
- The writer notes say they did not check each screen against the LD-436 mocks (LD-439 a). Structurally the rules hold: PageHeader is used in 19 views, FilterBar in RulesView, ChartCard in ReportBody, and nothing is raw. No visual mock comparison was done.
- History in the UnresolvedView detail now uses the kit formatDateTime instead of the local en-GB UTC `when`. The text format changed. The reviewer did not run uiconsole1.inventory.test.tsx, so it is not confirmed that it still passes.
