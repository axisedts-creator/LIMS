# 13 — M series: the chosen UI direction (Metro Labs brand)

Status: ACTIVE. Amends `10-DESIGN-SYSTEM.md` (values only; token names, the 76 kit components and the contrast gate stay). Where 13 and 10 differ, 13 wins. Where a board and a contrast gate or an acceptance criterion differ, the gate and the criterion win.
Decision: FOUNDER 2026-11-16, "ui part is M series my pick" (answer to LD-241, "I show 3 directions, you pick"). Recorded as LD-246.
Owner: C0-0E (tokens, kit, shell), C0-0D (navigation), C0-0F (Flutter theme). Each chunk keeps the layout of its own screens.

## 1. What the M series is

A calm green clinical workspace on a light grey page: deep Metro green for identity and action, one lime pill for "what is current", white cards with large radii and no hard borders, fully round buttons, Poppins type, motion only in CSS. It is the look of the client's current "my health now" app, measured and corrected for contrast. The boards below are the reference for look and layout; they are not pixel specs and their sample content (names, counts, addresses, results) is invented.

Reference files (in this folder): `M0-foundations.png`, `M1-entry.png` (sign-in), `M2-platform.png` (platform home), `M3-worklist.png` and `M3-worklist-catalog-open.png` (staff shell and worklist), `M4-patient.png` (patient app, 24 screens in the board), `M5-phlebotomist.png` (phlebotomist app). Sources with the exact CSS values are in `sources/` (`.dc.html`: HTML with a small template layer, read the `<style>` block and the markup). Logos are in `logos/` (landscape and square marks, light and white).

## 2. Token values (names unchanged)

### 2.1 Colour (`packages/ui/tokens/tokens.json`)

| Token | 10 (Metro Green) | M series | Notes |
|---|---|---|---|
| `accent.default` | `#0E4B3B` | `#005A52` | Metro green: primary button, links, sidebar fill, focus ring. 8.13:1 on white |
| `accent.hover` | `#0A3328` | `#014D3C` | forest: hover, pressed, page titles. 9.87:1 with white text |
| `accent.fg` | `#FFFFFF` | `#FFFFFF` | |
| `accent.subtle` | `#E6F2EA` | `#ECF3D7` | pale lime: selected row, icon tiles, soft chips. `#014D3C` on it 8.63:1 |
| `accent.highlight` | `#D9EE8C` | `#A0C032` | the one "current" marker: active nav pill, primary action on dense toolbars. Text on it `#00362F` (6.43:1). Never text or icon on white (2.08:1) |
| `accent.brand` | `#9DBE2E` | `#A0C032` | logo disc, illustration and chart fills only |
| `accent.pop` (new) | none | `#E4F239` | focus outline on green, one icon on a green disc. Text on it `#00362F` (10.87:1) |
| `neutral.50` | `#F3F7F4` | `#F3F3F3` | page background |
| `neutral.200` | `#DCE8E0` | `#ECECEC` | hairline, decorative only |
| `neutral.300` | `#7A9185` | `#7A9185` (unchanged) | border of every form control, 3.38:1 on white. The board's lighter field border `#D3D8D0` is 1.45:1 and is NOT used for controls |
| `neutral.500` | `#5C7167` | `#5C6A66` | muted text. 5.66:1 on white, 5.10:1 on the page |
| `neutral.900` | `#13241D` | `#0A1A17` | ink, body text, 16.13:1 on the page |

Status tones, `fg / bg` (each tone keeps its border token and its icon and word, never colour alone):

| Tone | fg | bg | Contrast | Board label |
|---|---|---|---|---|
| `success` | `#14612F` | `#E4F4DE` | 6.58 | Ready, normal |
| `info` | `#1A4F8B` | `#E3EEFB` | 7.06 | In progress (hue moves from petrol to blue) |
| `warning` | `#7A4B00` | `#FFF1D0` | 6.61 | Waiting, urgent |
| `danger` | `#9C1C12` | `#FDE7E4` | 6.85 | STAT, overdue, rejected |
| `neutral` | `#46524E` | `#EEF0EC` | 7.10 | Not started, draft |
| `critical.solid` | `#B42318` | with white text | 6.57 | unchanged: blocking banner, critical chip |

Every derived border and every pair in `contrast-pairs.json` must still pass 10 section 2.6; the gate is extended with the pairs above. Tenant accent derivation (`src/theme/accent.ts`) stays; the Metro tenant default becomes `#005A52`.

### 2.2 Type

- Family `font.family.sans`: `"Poppins", "Noto Sans Devanagari", system-ui, sans-serif`. Poppins has no Devanagari glyphs; Nepali falls through to Noto Sans Devanagari (already bundled, weights 400 to 700). Mono stays Noto Sans Mono.
- Self-hosted, no CDN: add `@fontsource/poppins` (OFL-1.1, a published version at least two weeks old) woff2 latin 400, 500, 600, 700 to `packages/ui/assets/fonts` with `font-display: swap`, add its licence text, and remove the Plus Jakarta Sans files, their licence file and their `fonts.css` rules in the same change. A new third-party dependency, so the C0-0D dependency review (CR-UI-R-001) applies.
- Scale: display 40/700 (-.03em), page title 30/600 (-.02em, `accent.hover`), section 20/600 (-.01em), body 16/400, caption 13/500. Dense staff screens keep the 10 scale (table 13/18, body 14/20, caption 12/16). All numbers in tables, results, money and ids keep `font-variant-numeric: tabular-nums` (class `.num`); a test renders a column of digits in Poppins and fails if the glyph widths differ, and if Poppins is not tabular the `.num` class switches that column to Noto Sans.

### 2.3 Shape, size, motion

| Item | Value |
|---|---|
| Cards, panels, dialogs, drawers | radius 24, white, no border, on `neutral.50` |
| Icon tiles, tooltips | radius 16 |
| Buttons, chips, segmented tabs, search and single-line fields, avatars | fully round (`radius.full`) |
| Multi-line text, table cells, rows | not round |
| Button height | 48 (also the touch target); field and nav item 46; table rows keep 32, 40, 48 densities; dense registration (compact) may use fields of 40 |
| Elevation | none on cards; `elevation.2/3` only on menus, dialogs, drawers, tinted `rgb(0 90 82 / .10 to .18)` |
| Motion | content enters with 450 ms ease-out (`cubic-bezier(.2,.7,.2,1)`, rise 8 to 12 px or slide 24 px); hover and press 150 ms; at most ONE looping animation per screen; everything off under `prefers-reduced-motion`; CSS only |
| Not allowed | three.js or any WebGL, any animation library, autoplay video, a loop on a data screen. Images are optimised SVG or WebP/AVIF; the entry and splash art is CSS gradient plus the logo |

## 3. Shell (staff web)

Replaces the 8-heading fold of 10 section 3 and LD-140 (`rail-groups.ts`). The sidebar shows the 14 NavGroups of C0 04-UI-UX section 3 as its groups, in this order: `front_desk`, `laboratory`, `reporting`, `billing`, `catalog`, `instruments`, `analytics`, `quality`, `inventory`, `partners`, `engagement`, `home_collection`, `admin`, `platform`. `platform` is only in the platform-staff shell (M2); the tenant shell has the other 13.

- Sidebar 296 px wide, `accent.default` fill, white text, the Metro Labs logo and the tenant name on top (the logo files in `logos/`, copied into `packages/ui/assets/brand/`; LIMS stays independent of Code Peak branding), "Find a screen" search field under it, the user card pinned at the bottom (display name and role).
- One group open at a time (accordion); a closed group is one row with its icon, label, entry count and a chevron; the open group shows a small-caps heading with its count and its entries. Optional sub-headings inside a group are used where a group has sections (Laboratory: Daily work, Microbiology, Anatomic pathology; Reporting: Smart summaries; Billing: Payments; Catalog: Pricing). Opening a group scrolls it to the top of the list.
- The entry list scrolls inside the sidebar (`overflow-y: auto`, thin scrollbar); the sidebar itself is fixed at the viewport height; the logo, search and user card never scroll away.
- Entry: 46 px pill, 20 px stroke icon, 14/500 label, ellipsis never needed because the longest label fits; the active entry is the `accent.highlight` pill with `#00362F` text; an optional count badge, an optional "view only" tag, and an optional round "+" that goes straight to the create screen of that entry (Tests, Panels & packages, Price lists, Users).
- "Find a screen" filters every entry of every group as you type, expands every group that has a match, hides sub-headings while filtering, and says "No screen matches this search." when none match. Keyboard: the field and every entry are reachable by Tab; the focus outline is `accent.pop`, 3 px, 2 px offset.
- Sidebar controls keep the 3:1 non-text rule: the search field border and the "view only" tag border use `#8FB8B0` or lighter on `accent.default` (the board's translucent white border is decorative and does not pass).
- Top bar: white, 76 px, breadcrumb on the left, centre switcher (outlined pill, `accent.default` border) and notifications on the right. Page: title 30/600, one line of help text, then cards.

## 4. Navigation content and who sees what

Entries come from the `nav.manifest.ts` files and are shown only when the role holds the entry's permission (unchanged rule). The administrator role pack (`corp_admin`, `std_admin`; 11-ROLE-MATRIX R5) holds every screen permission the matrix ticks and NO clinical sign-off, so an administrator sees all 13 tenant groups, with `Approve` marked "view only". The board M3 is drawn for the administrator: 124 entries, including Front desk > Discount approvals and Discount limits & settings, Catalog > Tests (with "+ New test"), Panels & packages, the Pricing section, and Admin (12 entries plus Invite user from the "+" on Users). Other roles see the subset their permissions allow. Task T0D-NAV-COMPLETE-1 completes the manifests so every entry above exists in the built app.

## 5. Entry, platform and mobile

- Entry (M1): deep green into lime hero, logo, white card with pill fields (control border `neutral.300`), one primary pill button. Platform home (M2) and worklist (M3) are the layout references for the two shells; each chunk lays out its own screens with the same card, chip and pill rules.
- Patient app (M4, C16) and phlebotomist app (M5, C17): Flutter, same tokens through `lims_ui`; bottom navigation with a gradient-disc active tab; 48 dp targets; offline banner and per-tube checklist as drawn in M5. The boards are the screen designs for those apps; building the screens is separate from the token swap.

## 6. Acceptance

1. `tokens.json` and the generated CSS, TypeScript and Dart outputs carry the values of section 2; `contrast-pairs.json` includes every pair of section 2.1 and the gate is green.
2. Poppins is self-hosted, Plus Jakarta Sans is gone from `packages/ui/assets/fonts`, no CDN request for fonts.
3. The raw-colour and pixel-radius lint (T0D-UI-R07) passes; no colour, radius or font literal outside `packages/ui`.
4. The staff shell follows section 3 and reads its entries from the manifests; a test builds the tenant navigation for the administrator pack and asserts that every group has its entries and `platform` is absent.
5. Screens are checked by eye against the boards by the founder; differences caused by a gate (section 2.1, control borders) are expected.
6. Out of scope: dark mode, 3D, public marketing site.
