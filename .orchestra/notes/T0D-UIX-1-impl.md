# T0D-UIX-1 impl (writer)
- Files: `apps/web/src/core/shell/shell.css` only (one appended block, LD-442/436/437/438 cited). kit.css, tokens.json, tests untouched.
- [CONV] Every rule scoped to `.lims-shell` so auth pages and dialogs portalled outside the shell keep the kit base (auth is pinned).
- [CONV] Base button/input rules put their exclusions in `:where(:not(...))` (zero specificity) so variants (primary/ghost/danger/sm/icon, date input) win by order; excluded: `.lims-rail-close`, textarea, `.lims-rte-surface`, `.lims-rail-search`.
- [CONV] Tokens: 8px = radius-sm, 30/24/32/40/14px literal px as the mock; edge to edge = `.lims-card .lims-data-table` margin-inline `calc(-1 * space-3)` (card padding is space-3 !important).
- Tests: uix1 63/63; shell configs uikit2, r04, m2, m4, density, elabmenu, unslop1 green; packages/ui m-series-kit + ui-r03-kit-pass 177/177.
- elabmenu-wide (whole web suite): 379 fail / 5057 pass, all in nav/route/behaviour files (elabmenu3.walk, rs-c4, misreports1...); none of the 14 tests that read shell.css failed, so not from this change (not re-run on HEAD).
- Open: dialogs/popovers rendered outside `.lims-shell` still show kit pill buttons; topbar bell and centre switcher now radius 8 (no pill); no real-browser pixel check.
