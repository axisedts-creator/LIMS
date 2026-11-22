# T0D-UIX-1 tests (tester)
- `apps/web/src/core/__tests__/uix1.look.test.ts` (63 tests) + `vitest.uix1.config.ts` (jsdom). Run: `.orchestra/notes/T0D-UIX-1-verify.cmd`.
- Method: parses `packages/ui/.../kit.css` then `shell.css` (shell loads after kit), builds DOM fixtures with the kit's real class lists, computes the winning value per property (important, specificity, order) via `Element.matches`. Any selector form works, only final values count.
- Covers DONE WHEN 1 buttons, 2 controls and label and date icon, 3 filter bar, 4 tables (3 densities, sticky, align-start/end/center, rows 40/32, hover, selected, edge to edge, empty row), 5 tabs, 6 DescriptionList (2 cols, 3 cols at 80rem).
- Guards: kit.css and tokens.json unchanged (LD-438), no hex or rgb in shell.css, LD-340/344/352 sidebar values kept, no selector the matcher cannot read.
- State now: 50 fail, 13 pass (kit-side values already right, e.g. 2-col dl at prop 2, guards). Checked a throwaway css (deleted) makes all 63 pass, so the asserts are satisfiable.
- Needs from the writer: tab selected state may use `[data-selected]` or `[aria-selected='true']`; row-empty needs a `.lims-row-empty` rule; header band edge to edge = negative wrapper margin equal to card padding (or card padding 0).
- Not tested: real browser pixels, mobile widths, auth page and sidebar pills (pinned), topbar bell and centre switcher (not in the brief).
