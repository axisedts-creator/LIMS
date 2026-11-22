# T0D-UIX-5 impl (writer)
- Files: `apps/web/src/core/shell/layout.css` (new), `apps/web/src/app/layout.tsx` (one import line after shell.css). shell.css, kit.css, tokens.json untouched.
- Result: `vitest.uix5.config.ts` 5 files / 100 tests pass; web-style* 94 pass. packages/ui: 3 files fail (fonts/flutter assets, no-raw-style-literals 31 pre-existing violations, density), none name layout.css. Running `vitest run src/core` without a config gives "React is not defined" (no JSX config), not caused by this change.
- [CONV] Ghost Retry uses `background-color` / `border-width` (not the shorthands) so it does not reset the danger-tone fill and border of the parent row.
- [CONV] Block danger ErrorState rule comes first; the card and table `.lims-state` rules come later at equal specificity, so an ErrorState inside a card stays a compact centred column with its 40px art.
- [CONV] Stacked NotAvailable variant uses `:has()` with `~` (no nested :has); the 40px height is on `.lims-state`, so the card adds its own padding around it.
- Open: PageHeader 12px margin plus the 12px main gap = 24px visible (both required by the brief). The stat row `data-lead` (2fr) kit rule still wins where it is used.
