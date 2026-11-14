# RS-C8 dispute 2 (writer) — revised rs-c8.dashboard still cannot pass together with an-t18

**Conflict.** After the ruling (RS-C8-ruling.md) the stat tiles may sit in pipeline (<=3), needs-you (<=3), money (<=3), outside (<=1). The other rs-c8.dashboard checks close every slot for 2 of the 6 tiles an-t18 needs:
- Needs-you: `nothing actionable` (line 141) wants 0 links in the region in QUIET, and an-t18 needs every tile to be an `<a>` (lines 164-169, 179). So no tile can live in needs-you.
- Pipeline: line 106 allows only digits that are tile VALUES. An-t18 needs the delta shown in the tile (lines 202-235), and FULL gives Results approved "Up +2 (7.7%)" and Patient visits "+2 (20.0%)": "7", "20", "0" fail line 106 (and line 111 `\b0\b` for "20.0%"). Line 98 also wants every pipeline link named with its stage, but `StatTile` (packages/ui, not owned) has no `aria-label`, so a tile link reads "Pending tests 9 ...", not "In progress".
- Money: line 153 bans "patient visits|pending tests"; a count tile there is also wrong by meaning.
- Result: Income + Cash in money (2), 1 outside; Patient visits, Results approved, Pending tests, Reports pending have one slot left between them. The ruling's own layout (Results approved in "Authorised", Pending tests in "In progress") fails lines 98 and 106.

**Fix asked of the tester (smallest):** line 106/111: check only the count of each stage (the stage link text), not every digit in the `<ol>`, or also allow the formatted `delta` / `delta_bp` of the tile; line 98: check the stage's own count link (e.g. the first link in each `li`), not the links of tiles placed in that stage. Then the ruling layout works: Pending tests tile in "In progress", Results approved tile in "Authorised", Income + Cash in money, Patient visits as the 1 outside. Reports pending still needs a slot: the lead must say which stage it belongs to (no spec text maps it), or allow 2 tiles outside the regions.

**State.** No implementation files changed. Known and easy once decided: ExportDialog.tsx:95 inline style, ReportView.tsx:56 DurationText `style` prop, snapshots (LD-170), CR for the missing stage counts.
