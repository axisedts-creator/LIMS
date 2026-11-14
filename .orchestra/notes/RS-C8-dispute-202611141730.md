# RS-C8 dispute (writer) — chunk test an-t18 and rs-c8.dashboard cannot both pass

**Conflict.** `rs-c8.dashboard.test.tsx` "at most 3 stat tiles" (line 173) needs `container.querySelectorAll('.lims-stat').length <= 3`. The chunk test `an-t18.page.test.tsx` needs one `.lims-stat` element per tile, found by `tileEl(label)` (line 100-104): `.lims-stat` whose FIRST `.lims-stat-label` equals the label.
- Lines 151-155 (first populated test) need 5 separate `.lims-stat` tiles at once: Patient visits, Income (net sales), Results approved, Reports pending, Pending tests. Cash collected (net) is a 6th (line 178).
- Also 164-169 (each tile `closest('a')` href), 266-292 (`cellOf` walks up while a parent holds exactly one `.lims-stat`; stale marker per tile), 322-323, 360-361, 535 (`a.lims-stat` are links).
- 5-6 required `.lims-stat` elements vs a ceiling of 3: no markup satisfies both. A single `.lims-stat` with several labels does not help (`tileEl` reads only the first label).

**Why I did not pick a side.** The task says "chunk tests stay green" AND "no grid of equal KPI tiles" (10-DESIGN-SYSTEM s4, s6; LD-140). The tester's note says an-t18 "pins the six tile labels, which must still render" but an-t18 pins the six `.lims-stat` elements, not only the labels. I may not edit either test.

**Needed from the lead / tester (one of):**
1. Update an-t18 (lines above) to the restyled structure: pipeline / needs-you / money strip instead of `.lims-stat` per tile (tester-owned edit); or
2. Raise the rs-c8 ceiling and accept the six-tile arrangement (conflicts with s6, so I advise against); or
3. Confirm an-t18 is superseded for the dashboard screen by RS-C8 (LD-140), so it is replaced.

**State.** No implementation files changed. Two other rs-c8 failures are known and easy once this is decided: ExportDialog.tsx:95 inline `style`, ReportView.tsx:56 `style="short"` (a DurationText prop, flagged by the scanner; fix = `{...{ style: 'short' }}`), plus the missing snapshots (LD-170).
