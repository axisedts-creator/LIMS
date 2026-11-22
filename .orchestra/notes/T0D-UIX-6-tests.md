# T0D-UIX-6 tests (tester)
- `apps/web/src/core/__tests__/uix6.buttons.test.ts` (67 tests) + `vitest.uix6.config.ts` (jsdom, runs uix1 + uix6). Run: `.orchestra/notes/T0D-UIX-6-verify.cmd`.
- Method as uix1 (kit.css then shell.css, real cascade) plus states rest/hover/focus/visited; covers DONE WHEN 1 primary, 2 no underline (a.lims-btn*, 4 states), 3 secondary + disabled, 4 ghost, 5 danger, 6 icon, 7 focus 2px accent offset 1px, 8 size kept; guards: no !important on button rules, no hex, auth card (outside .lims-shell) unchanged.
- State now: 50 fail / 17 pass in uix6 (right reasons: border null, neutral-0/100 fills, no text-decoration, outline-offset 2px); uix1 63 pass.
- uix1 edits: bare `.lims-btn` keeps white/neutral.300 assert (secondary assert removed); primary "no border" assert dropped, it contradicts done_when 1 (1px accent border) and is asserted in uix6.
- Writer choices pinned loosely: secondary border and hover fill = a tint (accent-subtle/highlight/brand or color-mix with accent), border must differ from the fill; secondary icon button rest stays white/neutral.200 (uix1 icon test), only colour accent + hover accent.subtle; focus colour accent or focus-ring.
- Not tested: real browser pixels, per-page choice of primary button (markup), danger secondary (kit has none).
