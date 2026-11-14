# RS-C15 dispute (debugger): 6 failing tests are test defects; implementation needs no change

Run: rs-c15.behaviour = 6 failed / 19 passed; static + screens (after snapshot recorded) = 16/16 pass.

1. A4 x3 (review queue, refunds list, reconciliation) — `chipsAreComplete(document.body)` (rs-c15.fixtures.tsx:20-22) selects every `.lims-chip`.
   The failing "chips" ("Under review", "Waiting for approval", "Missed settlement") are the multi-select filter options of `packages/ui` FilterBar
   (`<ListBoxItem className="lims-option lims-chip">`, FilterBar.tsx:42). They are filter toggles, not status chips: no `data-tone`, no icon, by kit design.
   Spec 10-DESIGN-SYSTEM.md:127 ("colour-only status: tone + icon + word on every status") and :109 apply to status chips. Filters must stay unchanged (task brief) and
   `packages/ui` is not owned by C15. Fix is in the test: select `.lims-chip[data-tone], .lims-tone-*` or exclude `[role=option]`.
2. A3 settings — `toBeChecked()` (rs-c15.behaviour.test.tsx:96) throws "Invalid Chai property: toBeChecked": jest-dom is not registered in vitest.rs-c15.config.ts
   (no setupFiles; no jest-dom anywhere under features/payments). Chip assertions on lines 93-95 pass before it. Fix: assert `.checked` / `aria-checked`, or register jest-dom.
3. Keyboard x2 (review queue link, reconciliation Resolve) — `tabTo` assumes Tab reaches links/buttons inside table cells. The kit DataTable is an ARIA grid (RS-C7 ruling, as the tests' own header says):
   probe of Tab order shows ... Reset filters -> `TR[role=row]` (one tab stop for the whole grid) -> body. In-cell controls are reached with arrow keys / Enter, not Tab.
   Spec 10-DESIGN-SYSTEM.md:146 requires a keyboard-only path, which the grid gives; the test must use arrow keys into the cell. DataTable is not a C15 path.
Not changed: any implementation file. Snapshot file `__tests__/__snapshots__/rs-c15.screens.test.tsx.snap` recorded with `-u rs-c15.screens` (LD-170) as a regression baseline only.
