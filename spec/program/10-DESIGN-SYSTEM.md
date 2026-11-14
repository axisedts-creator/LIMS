# 10 — Design system "Metro Green": palette, type, layout, screens

Status: ACTIVE (supersedes the slate/blue theme in `packages/ui/tokens/tokens.json` and every colour/radius statement in the chunk `04-UI-UX.md` files) · Date: 2026-11-13 · Owner: C0-0D (tokens, kit, shell); each chunk owns the layout of its own screens
Sources: the client's "My Health Now" interactive prototype (`Main.dc.html`: colours, radii, shadows, type, tap behaviour) and palette screenshot; the reference lab software capture (`ElabAssist_UI_Documentation.md`: what staff do all day, and what slows them); Watermelon UI healthcare-dashboard patterns (layout ideas only, no code copied). The Mobbin connector refused every call ("requires a paid plan"), so no Mobbin references were used.

## 1. Direction in three sentences

A calm, dense, green-and-paper clinical workspace: deep forest green for action and identity, warm off-white paper for the page, hairlines instead of boxes. One lime highlight per screen marks "what is current". Software for people who read results and scan barcodes for eight hours, so legibility, keyboard flow and status clarity beat decoration.

## 2. Tokens (values replace the current ones; token **names stay** so the 76 kit components and the four apps re-theme without code changes)

### 2.1 Colour (`packages/ui/tokens/tokens.json`, `color.*`)

| Token | Value | Use |
|---|---|---|
| `neutral.0` | `#FFFFFF` | cards, inputs, table body |
| `neutral.50` | `#F3F7F4` | page background (prototype `bg`) |
| `neutral.100` | `#EEF3EF` | subtle surface, table header, disabled fill |
| `neutral.200` | `#DCE8E0` | hairline dividers (**decorative only**: 1.26:1 on white) |
| `neutral.300` | `#7A9185` | form-control borders, focus-less outlines (3.38:1 on white, 3.12:1 on page) |
| `neutral.500` | `#5C7167` | tertiary text, placeholders (5.23:1 on white). The prototype's `#6B8076` is 4.22:1 and fails AA for small text, so it is used for ≥ 24 px or decorative marks only |
| `neutral.600` | `#4D6359` | secondary text (6.47:1) |
| `neutral.700` | `#2F463C` | strong secondary, table header text |
| `neutral.900` | `#13241D` | body text (16.18:1) |
| `accent.default` | `#0E4B3B` | primary button, links, active nav text, focus ring (10.06:1 on white) |
| `accent.hover` (new) | `#0A3328` | primary hover/pressed |
| `accent.fg` | `#FFFFFF` | text on `accent.default` |
| `accent.subtle` | `#E6F2EA` | selected row, active filter, soft buttons |
| `accent.highlight` (new) | `#D9EE8C` | the single "current" marker: active nav pill, today's date, new item. Text on it: `neutral.900` (12.76:1) or `accent.default` (7.93:1) |
| `accent.brand` (new) | `#9DBE2E` | logo, illustrations, charts fill. **Never as text or icon on white** (2.13:1). Text on it: `neutral.900` (7.58:1) |
| `focus.ring` | `{color.accent.default}` | 2 px ring, 2 px offset, always visible |

Tones (status colours), each `fg / bg / border`; every tone pairs colour with an icon and a word, never colour alone:

| Tone | fg | bg | border | Contrast fg on bg | Used for |
|---|---|---|---|---|---|
| `neutral` | `#3A4F45` | `#EEF3EF` | `#CFDDD4` | 7.84 | draft, pending, no flag |
| `info` (new hue: petrol) | `#1B566F` | `#E5F1F6` | `#BBD7E4` | 7.00 | in progress, instrument source, hints. The palette has no cool hue; status needs one that is neither green, amber nor red |
| `success` | `#14633F` | `#E3F3E8` | `#B9DEC6` | 6.32 | authorised, paid, normal |
| `warning` | `#7A4300` | `#FFF4E5` | `#F2D6A8` | 7.35 | pending review, overdue soon, abnormal (non-critical) |
| `danger` | `#8A2E2E` | `#FBEAEA` | `#EBBFBF` | 7.19 | rejected, failed, overdue |
| `critical` | `#B42318` | `#FEF0EE` | `#F1B5AE` | 5.92 | critical value chips; `critical.solid` `#B42318` with `#FFFFFF` text (6.57) for the blocking banner |

Amber `#E2A100` from the prototype is 2.25:1 on white and is allowed only as a fill with dark text (7.19) or a chart mark. Tenant accent derivation (`src/theme/accent.ts`, T0D-11) stays; the Metro tenant default is `#0E4B3B`, and every derived accent must still pass the contrast pairs in §2.6.

### 2.2 Type

- Family `font.family.sans`: `"Plus Jakarta Sans", "Noto Sans Devanagari", system-ui, sans-serif`. **Plus Jakarta Sans has no Devanagari glyphs**; Nepali text falls through to Noto Sans Devanagari (already bundled), so the order matters and Devanagari weights 400–700 stay. Mono: `"Noto Sans Mono"` for barcodes, lab codes, instrument ids.
- Fonts are self-hosted (no CDN): add `@fontsource/plus-jakarta-sans` **5.3.0** (OFL-1.1, published 2026, ≥ 2 weeks old) woff2 latin 400/500/600/700/800 to `packages/ui/assets/fonts` and `fonts.css` with `font-display: swap`. New third-party dependency, so it needs the C0-0D dependency review (CR-UI-R-001).
- Scale (px / line): 12/16 caption, 13/18 table, 14/20 body, 16/24 field value, 18/28 section, 20/28 page title (staff), 24/32 display, 30/36 hero. Weights 400/500/600/700; page titles 700 with `letter-spacing: -0.01em`.
- All numbers in tables, results, money and ids use `font-variant-numeric: tabular-nums` (class `.num`). Result values are 15 px semibold so a value is never smaller than its flag.

### 2.3 Shape, depth, motion, size

| Token | Value | Notes |
|---|---|---|
| `radius.sm` | 8 | chips in dense tables, checkboxes |
| `radius.md` | 12 | inputs, buttons, menu items (prototype: 12–14) |
| `radius.lg` | 16 | cards, panels (prototype: 16–18) |
| `radius.xl` | 20 | dialogs, drawers, sheets (prototype: 20) |
| `radius.full` | 9999 | status pills, avatars, segmented tabs |
| `elevation.1/2/3` | `0 1px 2px rgb(14 75 59 / .06)` / `0 4px 12px rgb(14 75 59 / .10)` / `0 12px 32px rgb(14 75 59 / .18)` | green-tinted shadows (prototype `rgba(14,75,59,.06–.25)`); cards use a hairline **or** elevation 1, never both |
| `motion` | 150 ms standard, `cubic-bezier(0.2,0,0,1)`; mobile press scale `.96` | no motion longer than 250 ms; honour `prefers-reduced-motion` |
| control height | 40 desktop, 44 touch (`touchTarget` token) | |

### 2.4 Density
Three table densities (compact 32 px rows, default 40, comfortable 48) selectable per user and remembered. Registration and result entry open in compact by default on screens ≥ 1280 px.

### 2.5 Dark mode
Out of scope for this release (not asked for, doubles the contrast matrix). The tokens are semantic so it can be added later.

### 2.6 Contrast gate
`contrast-pairs.json` gains: `neutral.500` on `neutral.0/50/100`; `neutral.300` vs `neutral.0/50` (non-text 3:1); `accent.default`↔`accent.fg`; `accent.default` on `accent.highlight`; `neutral.900` on `accent.highlight` and `accent.brand`; each tone `fg` on its `bg`; `critical.solid`↔white; focus ring vs `neutral.0/50`. The existing build test fails the build on any pair below 4.5 (text) or 3.0 (non-text).

## 3. Shell (staff web, `apps/web`)

```
┌ rail 248 ─┬──────────────────────── top bar 56 ─────────────────────────────────────┐
│ logo      │  [ Search name · lab code · mobile · PID · barcode        Ctrl+K ]  Centre ▾  🔔  User ▾ │
│ Front desk│───────────────────────────────────────────────────────────────────────────│
│  Register │  Page title                                           [ Secondary ] [ Primary ] │
│  Accession│  filter bar · saved views                                                  │
│ Lab       │  ┌ table / worklist ─────────────────────────────┐ ┌ side panel (detail) ┐ │
│  Worklist │  │ sticky header, row status chip, bulk bar on select│ │ opens on row select │ │
│  Results  │  └───────────────────────────────────────────────┘ └──────────────────────┘ │
│ Reports … │                                                                            │
└───────────┴───────────────────────────────────────────────────────────────────────────┘
```

- **Navigation is generated (`apps/web/src/core/nav/build-nav.ts`, shell in `core/shell/AppShell.tsx`) from each feature's `nav.manifest.ts` and filtered by the user's permissions** (role matrix, `11-ROLE-MATRIX.md`). A user never sees a screen they cannot open. Groups follow the work, not the database: Front desk · Lab · Reports · Accounts · Catalog · Instruments · People & access · Settings.
- Rail collapses to 72 px; collapsed items keep an accessible name and a tooltip (the reference product's icon-only menu has neither). Active item = `accent.highlight` pill with `accent.default` text.
- Global search accepts name, lab code, mobile, patient id and **barcode**, opens the order directly when a barcode matches. `Ctrl+K` anywhere. A scanner wedge typing into an empty page lands in search.
- Centre/lab switcher in the top bar replaces the reference "ChangeLab" menu; the active centre is always visible.
- One primary button per page. Destructive actions are never styled like neighbours and always confirm with the object named.
- Required fields are marked with text "Required" under the label group heading, not only `*`; every input has a programmatic label (reference product: labels unattached on several masters).

## 4. Screens (layout rules; each chunk's `04-UI-UX.md` keeps fields and validation)

| Screen | Layout decision | Replaces / answers (reference-product finding) |
|---|---|---|
| **Today** (role-aware landing) | Left: pipeline counts as a horizontal stepper (Draft → To collect → To receive → In progress → To authorise → Authorised → Released; rejected and critical shown apart), each count a filter. Right: "needs you" list (what this role must act on). Money strip only for roles with `billing.cash_report.read`, always showing currency and period. No grid of equal KPI tiles | Dashboard: 7 unlabelled money boxes, 6 coloured tiles, plain-link bulk actions |
| **Register** | One screen, three sections stacked left (Patient · Tests · Billing) and a sticky summary right (tests, total, paid, balance, discount authority). Age **or** date of birth in one field that computes the other. Tests: search-as-you-type with chips, packages expand. Actions: "Save draft" (secondary) and "Register and collect" (primary), visually distinct. `Ctrl+Enter` submits | Registration: age and DOB duplicated, adjacent similar buttons, 3 payment UIs |
| **Accession / receive** | Scan-first: a large barcode input holds focus. Status as **tabs with counts** (To collect · To accept · To receive · Hold · Rejected), not a 16-item dropdown. Batch actions in one bar, grouped | Accession: long status dropdown, unlabelled transfer-centre dropdown |
| **Worklist and result entry** | Table of samples by test group; row opens a right panel with the results grid. Each value shows its source chip (`Truth-H80E 10:42` in `info` tone), range, flag, delta against the previous result. Three-step track Entered → Sr. technician → Pathologist with the current step highlighted and the next actor named. Critical value: `critical` chip plus a call-log prompt before the result can be authorised. Chromatogram thumbnails open a viewer | Pathology Result: raw column names (AGE1), overlapping status buttons and dropdown |
| **Report preview and release** | Paper-white preview on `neutral.100`, template switcher, release / hold, delivery channels as checkboxes with last-sent status | Search toolbar of 20+ similarly named buttons |
| **Masters** (every list) | List on the left, **drawer** form on the right with sections and per-section Save. Never a 40-field page | Client / Laboratory Configuration: 40+ fields, one Save |
| **Instruments** | Link card per instrument (state dot + word, last heartbeat, queue depth), host-query log (barcode, answer `OK`/`NF`, reason, ms), QC panel, commissioning checklist as a stepper | Machine mapping: raw field names without help |
| **Roles and access** | Role list, matrix grid from the permission registry (`PermissionMatrix`), "Apply pack" (`11-ROLE-MATRIX.md`), diff before save, MFA badge on roles holding privileged permissions | Role Management: opaque permission popup |
| **Accounts** | Ledger table with opening/closing balance columns, entity picker first, status chips for the approval chain Initiated → Verified → Approved | Account screens: default filter Pending hides other rows |

Empty states say what to do next; first-load states use skeletons, not spinners; errors name the field and the fix.

## 5. Mobile (Flutter `patient_app`, `phlebo_app`, `ui-flutter`) and `apps/portal`

Follow the prototype directly: Plus Jakarta Sans, `#F3F7F4` page, white cards radius 16–18, primary pill buttons `#0E4B3B`, lime highlight for the current tab/selection, 44 px targets, tap scale `.96`, bottom navigation with text labels. `ui-flutter` reads the same token values (`build-tokens.ts` already generates `lib/src/tokens.g.dart` from `tokens.json`); no hand-copied hex. Flutter needs TTF: the Plus Jakarta Sans files go through `packages/ui-flutter/tool/woff2ttf.py` into `assets/fonts` beside the Noto files. Phlebotomist app: large offline/online chip, one task per screen, barcode scan as the primary action.

## 6. What makes it look "AI-generated", and the rules against it

| Do not | Do instead |
|---|---|
| gradient or glass hero blocks, purple/blue-violet accents, glow shadows | flat `neutral.50` page, white surfaces, green-tinted shadow level 1 only |
| emoji or mixed icon sets | one stroke icon family, 20 px, 1.75 px stroke, no filled/outline mixing |
| three-up icon cards, centred marketing layouts, "Welcome back 👋" | left-aligned data screens, the user's real work first |
| every element `rounded-xl` with a card inside a card | the radius ladder in §2.3; one container level; hairlines and spacing separate content |
| a dozen equal KPI tiles | one pipeline, one "needs you" list, numbers beside their meaning |
| lime or green everywhere | green for action and identity; lime marks only the current item; tones only for status |
| colour-only status | tone + icon + word on every status |
| lorem-style placeholder copy | real lab words (Accession, Authorise, Lab code), Nepali labels available (Devanagari) |

## 7. Applying it to code that already exists

Because components read tokens by name, the re-theme is mostly a token change. Tasks are in the task files since 2026-11-13 (binding rule: lead decision LD-140):

1. **C0, lanes C0-0E (`R01` to `R04`, `R07`) and C0-0F (`R05`)** (ids `T0D-UI-R01 … R05`, `R07`; split off C0-0D on 2026-11-13 so they run in parallel with T0D-18): **R01** tokens, contrast pairs and generated outputs (`tokens.ts`, `tokens.css`, `tokens.g.dart`); **R02** fonts (web and Flutter TTF); **R03** kit component pass (radius, states, density, StatusChip / FlagBadge / StatTile / DataTable / Tabs / Drawer / PageShell / PermissionMatrix / StatusStepper) with axe and snapshot updates; **R04** staff shell (rail, top bar, search, centre switcher, permission-filtered nav); **R05** Flutter theme and widgets in `packages/ui-flutter`; **R07** lint test for raw colours, pixel radii and inline styles. These ids do not hold up other chunks (listed in `GateIgnore` in `queue.ps1`). There is no R06: `apps/portal` belongs to C6 and the two Flutter apps to C16 and C17, so their screens are restyled by their own chunks, not by C0.
2. **RS-<chunk>**: one restyle pass per finished chunk with screens: `RS-C2`, `RS-C3`, `RS-C4`, `RS-C5`, `RS-C6` (includes `apps/portal`), `RS-C7`, `RS-C8`, `RS-C15`. Each runs in its own lane (`C2r` … `C15r`) that starts only after `T0D-UI-R07` is done. These ids are in `GateIgnore` too (2026-11-13), so C9 to C17 do not wait for them. Appearance and arrangement only; no API, field, validation, permission or route change.
3. **Chunks still building** (C9 to C14, C16, C17, and C2 tasks T20, T26, T30): an `[ALL]` line in their lead-decision files (LD-140) says: use only `packages/ui` / `lims_ui` components and token names; no hex colours, no pixel radii, no inline styles; new screens follow sections 3 to 4 and 6. The lint test (R07) fails the build on a raw colour literal or `border-radius` px value outside `packages/ui`, except in directories listed in `packages/ui/scripts/raw-style-pending.json`; the lead removes a directory from that list when its restyle task is done.
4. Visual regression: R03 records snapshots of the kit; RS tasks record snapshots of their key screens.

Requests to C0 (CR-UI-R-001 to 003): dependency `@fontsource/plus-jakarta-sans` 5.3.0 (R02); new tokens `accent.hover`, `accent.highlight`, `accent.brand`, `tone.critical.solid` (R01); radius ladder change (R01, R03). The tasks carry the requests; the CR text is filed by C0 when R01 and R02 start.

## 8. Acceptance

- Every token pair in §2.6 passes in CI.
- No component imports a colour or radius literal (UI-R07 lint).
- Axe: zero serious/critical violations on the kit stories and on Today, Register, Worklist, Instruments, Roles.
- A keyboard-only user can register a patient, accession a tube and authorise a result without the mouse.
- Collapsed rail items expose accessible names; Devanagari renders in names, labels and the report preview.
- Side-by-side with the prototype: same page background, same primary, same radii and shadow family (design review, not a pixel test).
