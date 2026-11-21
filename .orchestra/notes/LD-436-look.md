# EXACT MATCH (LD-437): founder 2026-11-21 16:43 NPT: "I want exactly the sample you showed to me". The mock is the visual target. Match its layout, order of blocks, spacing, hierarchy, tones, states and labels exactly; do not substitute your own design.

# LD-436 look spec (read this with LD-353, LD-344, LD-352)

Founder approval 2026-11-21 16:08 NPT in chat: "yes approved acc to those update all the screen ui and organize them properly".
Read by the lead as: the COMPACT look drawn inside LD-344, LD-352 and LD-353; 3D and animated illustration (LD-241) stay out.
The roomier alternative on the canvas is NOT approved and must not be built.

Mock sources (HTML with inline styles; open them as text, they use a canvas runtime and do not render in a plain browser):
- LD-436-mock-today.dc.html      the Today screen (sample data)
- LD-436-mock-worklist.dc.html   the Front-desk worklist (sample data)
Their sample numbers, names and times are layout only. Never copy them into code.
Their pixel values are what the EXISTING web scale produces (type scale minus 10 percent from shell.css, 30px controls, 32px menu rows).
Build with the kit parts and tokens, not with the literal pixel values. tokens.json does not change.

## What each part of the mock is in the kit
- Shell (sidebar 14.5rem, brand band 2.75rem, Find a screen, 32px rows, two line user card, top bar with trail and search): unchanged, LD-344 and LD-352.
- Page title row: PageHeader (h1 16px weight 600), one caption line, PeriodPicker, one primary Button (accent fill).
- Card: white fill, 1px hairline neutral.200, radius 12, elevation.1 only. Title row = h2 at weight 500, md size, one short caption on the right (new Card title row, T0D-UIKIT-2).
- Pipeline: StatusStepper. Completed stages accent with a check, later stages outlined, ONE lime marker (accent.highlight with accent.subtle ring) on the stage with the most waiting. Overdue count in the danger tone.
- Needs you: ActionList (new, T0D-UIKIT-2). Row = tone icon chip, title (weight 500), one detail line (caption size, neutral.500), count Badge in a tone, chevron. First row most urgent. Row is a link.
- Money: Card with StatTile cells separated by 1px hairlines, values through MoneyText (NPR, lakh grouping), delta line in a tone, then a collected of billed bar (accent on neutral.100 track).
- Charts: ChartCard with title and caption. Billed per day = bars, past days neutral border tone, current day accent with its value above it, hairline gridlines at 0, 50 and 100. Tests by department = horizontal bars, accent on neutral.100 track, value right aligned.
- Worklist: PageHeader, Tabs with counts (underline tab, accent), FilterBar (search, two selects, Clear filters), DataTable (header row 10.8px weight 500 on neutral.50, rows one height, numbers right aligned with tabular figures, accession number in the mono family, StatusChip with dot and word, avatar initials and name, row menu IconButton), selected row accent.subtle, hover one neutral step, pager with total.
- Status tones: awaiting = warning, collected = neutral, in testing = info, ready = success, overdue = danger (critical only for critical results).

## Rules that bind every screen (LD-353 plus LD-436 R7 to R16)
Weights 400 and 500 only (600 only for the page title and stat numbers). One control height (30px compact, 24px small). No raw h1 to h4 and no raw ul or ol for page structure. Status is a word plus a dot in a tone, never colour alone. Charts always in ChartCard. One lime marker per screen. No gradients, glows, coloured card fills, 3D or looping animation. 150 ms hover and focus, 450 ms only for a drawer or panel, prefers-reduced-motion honoured. EmptyState, ErrorState and NotAvailable keep the table header and carry one small illustration drawn in code from the tokens.
Display only: no route, permission, contract, operation or API change.

## Card surface and where these files live (LD-438)
- The kit base card (lims-card in packages/ui kit.css) stays the M series card: radius 24, no border, no shadow. m-series-kit and ui-r03-kit-pass stay green and are not edited.
- The staff web card of the mock (white, 1px neutral.200 hairline, radius md 12, elevation.1) is set in apps/web/src/core/shell/shell.css next to the lims-card padding rule, tokens only. Dialogs and drawers keep radius 24 and elevation.3.
- This overrides 10-DESIGN-SYSTEM.md line 62 and 13-M-SERIES.md line 55 for the staff web only.
- The lane cannot read C:/LIMS-state. This file and the two mock sources are copied to .orchestra/notes/ in the lane worktree; read them there.
