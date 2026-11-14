# C0 — Foundation & Contracts — 04 UI/UX (design system, web shell, Flutter base, developer experience)

Status: DRAFT for build, 2026-11-05. Owner: **C0-0D** (`packages/ui`, `packages/ui-flutter`, `apps/web/src/core`). Abbreviations as in `01-PRD.md`.

Binding rules from CV §13–§14: compose UIs **only** from `@lims/ui` / `lims_ui`; WCAG 2.2 AA; no colour-only status; keyboard-first for front desk and result entry; every page has empty/loading/error/success states; in-app help on every screen; English UI v1 through a message catalogue; Devanagari user data rendered with bundled Noto Sans Devanagari.

The kit is **brand-neutral**. No client brand appears in it (the Metro Labs green/lime theme in 00 §4 is that lab's report letterhead, a C6 template concern). Each tenant may override one accent colour (§1.6).

---

## 1. Design tokens (`packages/ui/tokens/tokens.json` → CSS variables, TS, Dart)

Values below are [CONV] choices. Contrast is **not** asserted in this document. It is computed by the token test (AC-0D-8.1) over the pairs listed in `tokens/contrast-pairs.json`. A pair that fails blocks the build, and the token value must be adjusted.

### 1.1 Colour — neutral and base

| Token | Value | Use |
|---|---|---|
| `color.neutral.0` | `#FFFFFF` | surfaces |
| `color.neutral.50` | `#F8FAFC` | page background |
| `color.neutral.100` | `#F1F5F9` | subtle fills, neutral chip bg |
| `color.neutral.200` | `#E2E8F0` | borders (decorative) |
| `color.neutral.300` | `#CBD5E1` | input borders (UI part, ≥ 3:1 against surface required by test) |
| `color.neutral.500` | `#64748B` | placeholder, disabled text (exempt from contrast as disabled) |
| `color.neutral.600` | `#475569` | secondary text |
| `color.neutral.700` | `#334155` | neutral chip text |
| `color.neutral.900` | `#0F172A` | primary text |
| `color.accent.default` | `#1D4ED8` | primary actions, focus ring, links (overridable per tenant, §1.6) |
| `color.accent.fg` | `#FFFFFF` | text/icons on accent |
| `color.accent.subtle` | `#EFF6FF` | selected row, active nav background |
| `color.focus.ring` | = `color.accent.default` | 2 px outline, 2 px offset |

### 1.2 Colour — semantic tones (fg on bg; border)

| Tone | fg | bg | border | Meaning |
|---|---|---|---|---|
| `neutral` | `#334155` | `#F1F5F9` | `#CBD5E1` | inactive, waiting, stored |
| `info` | `#1E40AF` | `#EFF6FF` | `#BFDBFE` | in progress, informational |
| `success` | `#166534` | `#F0FDF4` | `#BBF7D0` | done, approved, released, paid |
| `warning` | `#92400E` | `#FFFBEB` | `#FDE68A` | attention needed, pending action, on hold |
| `danger` | `#B91C1C` | `#FEF2F2` | `#FECACA` | rejected, failed, cancelled, abnormal flag |
| `critical` | `#7F1D1D` | `#FEE2E2` | `#F87171` | critical values (HH/LL), always with icon + bold label |

### 1.3 Status mapping (contract statuses from IC §10; labels are kit message keys `ui.status.<kind>.<code>`)

| Kind | Status → tone (label text in English) |
|---|---|
| specimen (IC §10.1) | `ordered` neutral "Ordered" · `collected` info "Collected" · `in_transit` info "In transit" · `received` info "Received" · `aliquoted` info "Aliquoted" · `in_process` info "In process" · `resulted` warning "Resulted" (awaiting verification) · `verified` warning "Verified" (awaiting approval) · `approved` success "Approved" · `reported` success "Reported" · `rejected` danger "Rejected" · `recollection_ordered` warning "Recollection ordered" · `stored` neutral "Stored" · `discarded` neutral "Discarded" |
| result (IC §10.2) | `pending` neutral "Pending" · `resulted` warning "Resulted" · `verified` warning "Verified" · `approved` success "Approved" · `cancelled` neutral "Cancelled"; flags (not states): `on_hold` → extra warning chip "QC hold"; `qc_review_required` → warning chip "QC review" |
| report_version (IC §10.3) | `rendering` info "Rendering" · `rendered` info "Ready to release" · `render_failed` danger "Render failed" · `released` success "Released" · `superseded` neutral "Superseded" |
| order (IC §10.4) | `pre_registered` neutral "Pre-registered" · `registered` info "Registered" · `in_progress` info "In progress" · `completed` success "Completed" · `cancelled` danger "Cancelled" |
| invoice (IC §10.5) | `issued` success "Issued" · `cancelled` danger "Cancelled" |
| payment_intent (IC §10.6) | `created`/`initiated`/`pending` info · `settled` success "Paid" · `failed`/`expired` danger · `held_for_review` warning "Under review" · `refunded`/`partially_refunded` neutral |
| dead_letter | `open` danger "Open" · `replayed` success "Replayed" · `discarded` neutral "Discarded" |
| result flag (`FlagBadge`, IC §4.5 `flag`) | `N` none (no badge unless `showNormal`) · `L` danger "Low" · `H` danger "High" · `LL` critical "Critical low" · `HH` critical "Critical high" · `A` danger "Abnormal" |

A status code the kit does not know (an `x-extensible` enum gained a value — CV §4.11) renders as a neutral chip with the raw code. It never crashes.

### 1.4 Typography

| Token | Value |
|---|---|
| `font.family.sans` | `"Noto Sans", "Noto Sans Devanagari", sans-serif` — both bundled as woff2 in `packages/ui/assets/fonts/` (OFL-1.1), `font-display: swap`; **no external font request** (AC-0D-8.7; 04 §11) |
| `font.family.mono` | `"Noto Sans Mono", monospace` — barcodes, ids, codes |
| `font.size` scale (px / line-height px) | `xs` 12/16 · `sm` 13/18 · `base` 14/20 (dense staff UI) · `md` 16/24 (portal body, form inputs on touch) · `lg` 18/28 · `xl` 20/28 · `2xl` 24/32 · `3xl` 30/36 |
| `font.weight` | regular 400 · medium 500 · semibold 600 · bold 700 |
| numerals | `font-variant-numeric: tabular-nums` on `DataTable` numeric columns, `ResultValue`, `MoneyText` |

Devanagari: the Devanagari face has taller ascenders. Components with a fixed height (inputs, chips, table rows) use `min-height` instead of `height` so a Devanagari name never clips. A visual test renders a fixed synthetic Devanagari string in every text component.

### 1.5 Space, shape, elevation, motion, breakpoints

| Group | Tokens |
|---|---|
| space (px) | `0` 0 · `0.5` 2 · `1` 4 · `2` 8 · `3` 12 · `4` 16 · `5` 20 · `6` 24 · `8` 32 · `10` 40 · `12` 48 · `16` 64 |
| radius (px) | `sm` 2 · `md` 4 · `lg` 6 · `xl` 8 · `full` 9999 |
| elevation | `0` none · `1` `0 1px 2px rgb(15 23 42 / 0.08)` (cards) · `2` `0 4px 12px rgb(15 23 42 / 0.12)` (popovers) · `3` `0 12px 32px rgb(15 23 42 / 0.18)` (dialogs) |
| motion | `fast` 150 ms · `normal` 250 ms · easing `cubic-bezier(0.2, 0, 0, 1)`; `prefers-reduced-motion: reduce` → durations 0 |
| breakpoints (px) | `sm` 640 · `md` 768 · `lg` 1024 · `xl` 1280 · `2xl` 1536 |
| z-index | base 0 · sticky 10 · nav 20 · dropdown 30 · drawer 40 · dialog 50 · toast 60 |
| touch target | ≥ 44 × 44 CSS px for portal/partner (WCAG 2.2 target size AA needs ≥ 24 × 24; 44 is the kit's [CONV] choice); ≥ 48 dp in Flutter |

### 1.6 Per-tenant accent override

- Source: `TenantSettings.branding.accentColor?: '#RRGGBB'` (C2; merged branding block, 08 §4.12 — CR-C0-009 merged into CR-C2-008). When unset, the default accent is used.
- The shell sets `--lims-accent` on `<html>` from server-rendered settings (no client fetch).
- Derivation (`packages/ui/src/theme/accent.ts`): `accent.fg` = white or `#0F172A`, whichever has the higher contrast against the accent. If neither reaches 4.5:1, the accent is darkened in OKLCH lightness steps of 0.02 until white reaches 4.5:1. `accent.subtle` = accent mixed 8% with white. Link colour = accent darkened until it reaches 4.5:1 on `neutral.0`. If there is no input or the input is invalid, the default is used (AC-0D-8.2).
- Only the accent is overridable. Semantic tones never change per tenant, so "red = rejected" is consistent for every lab.

---

## 2. Component inventory (`@lims/ui`)

All components:
- are built on `react-aria-components` primitives (keyboard and ARIA behaviour);
- take user-visible text as message keys or pre-translated strings (never concatenated sentences, CV §13);
- forward `data-testid`;
- render Devanagari correctly;
- have a story (input for the axe scan) and unit tests.

Props are TypeScript; `?` = optional. Types `IsoDate`, `IsoUtc`, `DecimalString`, `Money`, `Uuidv7` come from `@lims/shared-ts/types`.

### 2.1 Actions

```ts
interface ButtonProps { variant?: 'primary' | 'secondary' | 'ghost' | 'danger'; size?: 'sm' | 'md'; type?: 'button' | 'submit';
  isLoading?: boolean; isDisabled?: boolean; iconStart?: IconName; shortcut?: string /* shown as hint, e.g. 'Ctrl+Enter' */;
  onPress?: () => void; children: React.ReactNode }
interface IconButtonProps { label: string /* required accessible name */; icon: IconName; variant?: 'ghost' | 'secondary'; onPress: () => void }
interface MenuProps { trigger: React.ReactNode; items: { id: string; label: string; icon?: IconName; isDanger?: boolean; isDisabled?: boolean }[]; onAction: (id: string) => void }
```
While `isLoading`, a button is disabled and shows a spinner with an accessible "Working…" label. A primary button inside `Form` is the submit target for `Ctrl+Enter`.

### 2.2 Form fields (every field: `label` required, `name` required, `description?`, `error?` (string, linked via `aria-describedby`), `isRequired?`, `isDisabled?`, `isReadOnly?`)

```ts
interface TextFieldProps extends FieldBase { value?: string; onChange?: (v: string) => void; maxLength: number /* REQUIRED: mirror spec maxLength */;
  inputMode?: 'text' | 'numeric' | 'tel' | 'email'; autoComplete?: string; prefix?: string; suffix?: string; normalize?: 'nfc' /* default nfc (CV §13) */ }
interface TextAreaProps extends FieldBase { value?: string; onChange?: (v: string) => void; maxLength: number; rows?: number /* default 3 */; showCount?: boolean /* default true */ }
interface IntegerFieldProps extends FieldBase { value?: number; onChange?: (v: number | undefined) => void; min: number; max: number; step?: number }
interface DecimalFieldProps extends FieldBase { value?: DecimalString; onChange?: (v: DecimalString | undefined) => void;
  decimals: number /* max fraction digits, from catalog analyte */; min?: DecimalString; max?: DecimalString; allowNegative?: boolean;
  suffix?: string /* unit hint, CR-C12-009 */ }
interface MoneyFieldProps extends FieldBase { value?: Money; onChange?: (v: Money | undefined) => void; min?: Money; max?: Money; allowNegative?: boolean /* default false */ }
interface SelectProps<V extends string> extends FieldBase { value?: V; onChange?: (v: V) => void; options: readonly { value: V; label: string; isDisabled?: boolean }[]; placeholder?: string }
interface CodedSelectProps extends FieldBase { codedSet: string /* x-coded-set name */; value?: string; onChange?: (code: string) => void;
  options: readonly { code: string; display: string; isActive: boolean }[] /* loaded by the feature via BFF; inactive codes hidden unless currently selected */ }
interface ComboboxProps<T> extends FieldBase { value?: T; onChange?: (v: T | undefined) => void; loadOptions: (query: string, signal: AbortSignal) => Promise<readonly T[]>;
  getKey: (t: T) => string; renderOption: (t: T) => React.ReactNode; renderValue: (t: T) => string;
  minChars?: number /* default 1 */; debounceMs?: number /* default 150 */; allowCreate?: { label: string; onCreate: (query: string) => void } /* e.g. quick-add doctor, 00 A5 */ }
interface CheckboxProps { label: string; isSelected?: boolean; onChange?: (v: boolean) => void; isDisabled?: boolean; description?: string }
interface RadioGroupProps<V extends string> extends FieldBase { value?: V; onChange?: (v: V) => void; options: readonly { value: V; label: string }[]; orientation?: 'horizontal' | 'vertical' }
interface SwitchProps { label: string; isSelected?: boolean; onChange?: (v: boolean) => void; isDisabled?: boolean }
interface FileUploadProps extends FieldBase { accept: readonly ('application/pdf' | 'image/jpeg' | 'image/png' | 'text/csv'
    | 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')[] /* ⊆ the operation's x-upload list (08 §4.13) */; maxBytes?: number /* default 15 MB, CV §10.2 */;
  multiple?: boolean; maxFiles?: number; onSelect: (files: readonly File[]) => void; progress?: Readonly<Record<string, number>>;
  scanState?: Readonly<Record<string, 'pending' | 'clean' | 'infected' | 'unavailable'>> /* per file; replaces FileDropzone/FileDrop requests (08 R22) */ }
```

Form wrapper:
```ts
interface FormProps { onSubmit: (data: FormData) => Promise<void> | void; children: React.ReactNode; submitShortcut?: boolean /* default true: Ctrl+Enter */;
  errorSummary?: boolean /* default true */; problem?: ProblemLike /* server problem+json: maps errors[].path (JSON Pointer) to fields */ }
```
- Behaviour: on submit with errors, an `ErrorSummary` appears at the top with links to each field, and focus moves to it. Server `errors[]` are mapped by JSON Pointer to the field `name`. Unmapped errors are listed in the summary only.
- Client validation mirrors the generated JSON Schema (ajv). The server remains the authority (CV §4.7).
- Validation messages: `ui.validation.required` "Enter {label}", `ui.validation.max_length` "{label} must be {max} characters or fewer", `ui.validation.decimals` "{label} can have at most {decimals} decimal places", `ui.validation.range` "{label} must be between {min} and {max}".

### 2.3 Date and time (`DatePicker`, `DateTimePicker`, `DateRangePicker`, `DateText`)

```ts
type CalendarMode = 'AD' | 'BS';
interface DatePickerProps extends FieldBase { value?: IsoDate; onChange?: (v: IsoDate | undefined) => void;
  calendar?: CalendarMode /* default: primary of tenant calendarDisplay (AD | BS | AD_BS → AD | BS_AD → BS) */;
  showAlternate?: boolean /* default true: shows the other calendar as a hint under the field */;
  min?: IsoDate; max?: IsoDate; allowManualEntry?: boolean /* default true */ }
interface DateTimePickerProps extends FieldBase { value?: IsoUtc; onChange?: (v: IsoUtc | undefined) => void; timezone?: string /* default tenant timezone */; calendar?: CalendarMode; minuteStep?: 1 | 5 | 15 }
interface DateRangePickerProps extends FieldBase { value?: { from: IsoDate; to: IsoDate }; onChange?: (v: { from: IsoDate; to: IsoDate } | undefined) => void; calendar?: CalendarMode; maxDays?: number }
interface DateTextProps { value: IsoDate | IsoUtc; mode?: 'AD' | 'BS' | 'AD_BS' | 'BS_AD' /* default tenant calendarDisplay */; withTime?: boolean }
```
- **The value is always A.D.** (`IsoDate`/`IsoUtc`). B.S. is display only (04 D12). Conversion only through `@lims/shared-ts/bsdate`.
- B.S. calendar grid: month names (English transliteration v1: Baisakh, Jestha, Asar, Shrawan, Bhadra, Asoj, Kartik, Mangsir, Poush, Magh, Falgun, Chaitra) [CONV], days per month from `daysInBsMonth`. The header shows "2082 Shrawan" plus the A.D. range of that month.
- Manual entry formats: A.D. `DD/MM/YYYY` (CV §13), B.S. `YYYY-MM-DD`. Invalid text → `ui.validation.date_invalid` "Enter a date like {example}". Out of supported range (1975–2099 B.S.) → `ui.validation.date_out_of_range` "Dates must be between {min} and {max}" (maps `common.date_out_of_range`).
- Display: A.D. `DD/MM/YYYY` / `DD/MM/YYYY hh:mm A`; B.S. `YYYY-MM-DD B.S.` (CV §13). In `AD_BS` mode `DateText` renders `DD/MM/YYYY (YYYY-MM-DD B.S.)`, and in `BS_AD` mode the reverse. The B.S. part always comes from the library, and docs and tests never hard-code a conversion outside the golden table.
- Keyboard: arrows move days, PageUp/PageDown months, Shift+PageUp/PageDown years, Home/End week start/end, Enter selects, Esc closes, `T` jumps to today, `C` toggles A.D./B.S. grid.

### 2.4 Barcode input

```ts
interface BarcodeInputProps { label: string; name: string; onScan: (value: string, meta: { source: 'scanner' | 'keyboard'; durationMs: number }) => void;
  pattern?: RegExp /* default /^[A-Z0-9]{1,20}$/ (IC §9.3 barcode charset) */; autoFocus?: boolean /* default true */;
  scannerMaxInterKeyMs?: number /* default 30 [CONV] */; minScanLength?: number /* default 4 */;
  submitKeys?: readonly ('Enter' | 'Tab')[] /* default ['Enter','Tab'] */; allowManual?: boolean /* default true */;
  clearAfterScan?: boolean /* default true */; feedback?: 'sound+visual' | 'visual' /* default 'sound+visual' */; isDisabled?: boolean; error?: string }
function useScanCapture(opts: { onScan: BarcodeInputProps['onScan']; enabled: boolean; pattern?: RegExp; scannerMaxInterKeyMs?: number }): void;
```
Behaviour (keyboard-wedge scanners type like a fast keyboard and end with Enter/Tab — 00 B1):
1. Characters are buffered. If every gap between keys is ≤ `scannerMaxInterKeyMs` and the run ends with a submit key and has ≥ `minScanLength` characters, the input is classed `source: 'scanner'`.
2. The value is uppercased and trimmed, then checked against `pattern`. Valid → `onScan` fires **once**, with a short success tone (WebAudio, bundled, ~80 ms) and a green border flash (`motion.fast`). Invalid → the inline error `ui.barcode.invalid` "This doesn't look like a sample barcode", an error tone, `onScan` does not fire, and the field keeps the text selected for re-scan.
3. Manual typing (slower keys) + Enter → `source: 'keyboard'` (allowed when `allowManual`). Features may require scanner-only by checking `meta.source`.
4. A repeated identical scan within 1,500 ms [CONV] is ignored (scanner double-fire), with a visual "duplicate scan ignored" hint.
5. `useScanCapture` listens at document level while `enabled` and no other editable element has focus. It is for scan-first screens such as specimen receipt (C5), so staff do not need to click a field first.
6. Barcodes are PHI-class P2 (IC §1). The kit never logs scanned values and never puts them in URLs (CV §9.2, REQ-SEC-098).

### 2.5 Data display

```ts
interface DataTableProps<Row> {
  columns: readonly ColumnDef<Row>[]; rows: readonly Row[]; getRowId: (r: Row) => string;
  isLoading?: boolean; error?: { title: string; requestId?: string; onRetry?: () => void }; emptyState: EmptyStateProps;
  page?: { hasNext: boolean; hasPrevious: boolean; onNext: () => void; onPrevious: () => void; limit: number } /* cursor pagination only (CV §4.3) */;
  sort?: { value: string /* e.g. '-received_at' */; onChange: (v: string) => void };
  selection?: { mode: 'single' | 'multiple'; selectedIds: ReadonlySet<string>; onChange: (ids: ReadonlySet<string>) => void; max?: number /* default 200 = bulk limit CV §4.1 */ };
  density?: 'compact' | 'regular'; stickyHeader?: boolean /* default true */; onRowAction?: (r: Row) => void /* Enter / double-click */;
  rowActions?: (r: Row) => readonly { id: string; label: string; isDanger?: boolean }[]; onRowActionMenu?: (r: Row, actionId: string) => void;
  caption: string /* accessible table name */; virtualize?: boolean /* default true when rows > 200 */ }
interface ColumnDef<Row> { id: string; header: string; cell: (r: Row) => React.ReactNode; align?: 'start' | 'end' | 'center';
  width?: number | 'auto'; sortKey?: string /* must be one of the operation's sort enum values */; isRowHeader?: boolean; hideBelow?: 'md' | 'lg' | 'xl' }
interface FilterBarProps { filters: readonly FilterDef[]; value: Readonly<Record<string, string | readonly string[] | undefined>>; onChange: (v: FilterBarProps['value']) => void; onReset: () => void }
type FilterDef = { id: string; label: string } & ({ kind: 'select'; options: readonly { value: string; label: string }[]; multiple?: boolean } | { kind: 'date_range' } | { kind: 'text'; maxLength: number } | { kind: 'coded'; codedSet: string; options: readonly { code: string; display: string }[] });
interface StatusChipProps { kind: 'specimen' | 'result' | 'report_version' | 'order' | 'invoice' | 'payment_intent' | 'dead_letter' | 'generic';
  status: string; tone?: Tone /* only for kind 'generic' */; label?: string /* only for 'generic' */; size?: 'sm' | 'md' }
interface FlagBadgeProps { flag: 'N' | 'L' | 'H' | 'LL' | 'HH' | 'A'; showNormal?: boolean }
interface ResultValueProps { value?: DecimalString | string; flag?: FlagBadgeProps['flag']; unit?: string; decimals?: number } // abnormal → bold value + text flag (00 §4)
interface MoneyTextProps { value: Money; grouping?: 'lakh' | 'international' }
interface IdTextProps { value: string; truncate?: number /* default 8 */; copyable?: boolean }  // mono font; for UUIDs and invoice numbers, never for barcodes in logs
interface DescriptionListProps { items: readonly { term: string; value: React.ReactNode }[]; columns?: 1 | 2 | 3 }
interface TimelineProps { items: readonly { at: IsoUtc; label: string; actor?: string; tone?: Tone }[] }
interface StatTileProps { label: string; value: string; delta?: { value: string; direction: 'up' | 'down' | 'flat'; isGood?: boolean }; href?: string }   // 00 F1
interface TimeSeriesChartProps { title: string; series: readonly { id: string; label: string; points: readonly { at: IsoUtc; value: DecimalString }[] }[];
  referenceBand?: { low?: DecimalString; high?: DecimalString }; unit?: string; height?: number }   // results trend (00 C7): in-house SVG, values drawn as given (no smoothing)
interface BarChartProps { title: string; categories: readonly string[]; series: readonly { id: string; label: string; values: readonly number[] }[]; valueFormat?: 'integer' | 'money' }
```
- Table keyboard: Tab enters the grid. Arrow keys move between cells. Enter triggers `onRowAction`. Space toggles selection. Shift+Space extends the selection. `Ctrl+A` selects the visible page (multi mode). The row actions menu opens with `Shift+F10` or the context-menu key.
- Charts always have a text alternative: a visually hidden data table generated from the same series (CV §14), plus axis labels with units.

### 2.6 Feedback, overlays, layout

```ts
interface DialogProps { title: string; isOpen: boolean; onClose: () => void; size?: 'sm' | 'md' | 'lg'; children: React.ReactNode; footer?: React.ReactNode; isDismissable?: boolean /* default true; false for blocking confirmations */ }
interface ConfirmDialogProps { title: string; body: React.ReactNode; confirmLabel: string; tone?: 'default' | 'danger'; isOpen: boolean; onCancel: () => void;
  requireReason?: { codedSet: string; options: readonly { code: string; display: string }[]; freeText?: { maxLength: number; isRequired: boolean } };
  onConfirm: (r: { reasonCode?: string; reasonText?: string }) => Promise<void> | void }   // reason-coded actions: reject, cancel, amend (IC §10)
interface DrawerProps { title: string; isOpen: boolean; onClose: () => void; side?: 'end' | 'start'; width?: 'sm' | 'md' | 'lg'; children: React.ReactNode }
function useToast(): { show(t: { tone: Tone; title: string; description?: string; durationMs?: number /* default 5000; tone 'danger' persists until dismissed */ }): void };
interface BannerProps { tone: Tone; title: string; children?: React.ReactNode; action?: { label: string; onPress: () => void } }
interface EmptyStateProps { title: string; body?: string; action?: { label: string; onPress: () => void }; icon?: IconName }
interface ErrorStateProps { title: string; body?: string; requestId?: string /* shown as 'Reference: xxxxxxxx' */; onRetry?: () => void }
interface LoadingSkeletonProps { variant: 'page' | 'table' | 'form' | 'detail'; rows?: number }
interface PageShellProps { topBar: React.ReactNode; nav: React.ReactNode; children: React.ReactNode; help?: React.ReactNode; banner?: React.ReactNode }
interface PageHeaderProps { title: string; breadcrumbs?: readonly { label: string; href?: string }[]; actions?: React.ReactNode; status?: React.ReactNode; helpKey: string /* REQUIRED: in-app help (CV §14) */ }
interface TabsProps { items: readonly { id: string; label: string; badge?: string }[]; selectedId: string; onChange: (id: string) => void }
// Layout primitives: Stack, Inline, Grid, Card, Divider, VisuallyHidden; Tooltip, Popover, Spinner, Badge, KeyboardShortcutsDialog
```

### 2.7 Message keys owned by the kit

Namespaces: `ui.*` for kit components and `core.*` for the web shell. Module screens use `<m>.<screen>.<key>` (CV §13). The kit ships `packages/ui/src/i18n/en.json`. Adding a language later = adding a file, with no code change.

Status key added by CR-C6-005: `ui.status.report_version.discarded` "Discarded" (status mapping §1.3, kind `report_version`).

### 2.8 Components added by the CR register (08 §4.6; props as in the requesting chunk's 04-UI-UX unless stated)

Delivered by 06 T0D-12b (web set; the Phase-1 consumers' components before M3, C9/C13/C14/C16 components before their wave) and T0D-15 (Flutter, CR-C16-016 widgets, CR-C17-010 pins), each with stories, axe scan and tests (review C0 #25). `QrCode` (C13) is **not** built: CR-C13-013 was withdrawn (C13 TRD) and no other web chunk uses it (C16 `LimsQrCode` is Flutter; 08 A25 §(c)(ii) C13 hand-off). `PrintFrame` shows branding images as `data:` URIs, which the staff-web CSP allows (`img-src 'self' data:`, 08 A18.1). The polling/SSE helpers send `X-Lims-Background` on background requests (08 A25 D-206).

| Section | Component / change | Requested by | Note |
|---|---|---|---|
| 2.2 Form fields | `CodeField` | C3 | upper-casing, regex hint |
| 2.2 | `FormulaEditor` | C3 | diagnostics from `@lims/shared-ts/formula` |
| 2.2 | `OtpInput` | C6 + C2 (`OtpCodeInput` mapped) | 6 numeric cells, `autocomplete="one-time-code"`, paste fills, Enter submits |
| 2.2 | `SecretField` | C15 | masked, never pre-filled |
| 2.2 | `RichTextEditor` | C6 | allowlisted marks; sanitised client + server (REQ-SEC-088) |
| 2.2 | `KeyValueListEditor` | C7 | |
| 2.2 | `WeekdayTimeRangeEditor` | C16 | |
| 2.2 | `PeriodPicker` | C8 (C4 may reuse) | |
| 2.2 | `FileUpload.scanState`, csv/xlsx `accept` values; `DecimalField.suffix` | C4, C10, C3; C12 | in the prop types above |
| 2.5 Data display | `EditableGrid` | C3 | cell editing, per-row status/error cell |
| 2.5 | `DiffTable` | C3 + C2 (`JsonDiffView` mapped) | rows `{label, before, after, changed}`; values as text nodes; "changed" text marker |
| 2.5 | `PermissionMatrix` | C2 | keyboard grid; non-assignable codes disabled |
| 2.5 | `DataUriImage` | C2 | `<img>` from PNG or SVG data URI only; never inline SVG markup |
| 2.5 | `StatusStepper` | C3 | import/publish progress |
| 2.5 | `CodeBlock` | C7 | |
| 2.5 | `SecretRevealOnce` (+ `requireAcknowledgement?: boolean`, default true) | C7 + C2 (`SecretRevealField` mapped) | secret never re-rendered after close |
| 2.5 | `ImageThumbnailGrid`, `PdfFileCard` | C6 (C11 uses the grid) | |
| 2.5 | `DurationText`, `FreshnessBadge` | C8 | |
| 2.5 | `ControlChart` | C9 | Levey-Jennings; shapes + text, hidden data table |
| 2.5 | `BarcodeSymbol` (Code 128 SVG) | C11 (C5 uses it) | value `^[A-Z0-9-]{1,32}$`, never logged |
| 2.5 | `TextDiff` | C14 (Phase 3) | grapheme-aware |
| 2.5 | `QueueBoard`, `TokenSlip` | C16 | |
| 2.6 Feedback/layout | `PrintFrame` | C4 | print-only iframe, `@media print` |
| shell (§7) | support-session banner slot | C2 (CR-C2-009) | part of the C0 shell, not a feature component (C2's `SupportBanner` maps here) |

Mapped to existing components (no new component, 08 R22): `MoneyInput`→`MoneyField`; `DualDate`→`DateText mode="AD_BS"`; `AsyncCombobox`→`Combobox`; `StatusBadge`→`StatusChip`; `StatusTimeline`→`Timeline`; `FileDropzone`/`FileDrop`→`FileUpload`; `ShortcutHint`→`Button.shortcut` / `KeyboardShortcutsDialog`; `AppPage`→`PageShell` + `PageHeader`; `NumberField`→`DecimalField`; `Textarea`→`TextArea`; `DateTimeField`→`DateTimePicker`; `Skeleton`→`LoadingSkeleton`; `Toast`→`useToast`; `KeyboardShortcutsHelp`→`KeyboardShortcutsDialog`; `MoneyText`, `DataTable`, `ConfirmDialog` (with reason), `Badge` exist.

---

## 3. Navigation manifest format (`apps/web/src/features/<m>/nav.manifest.ts`)

```ts
import type { NavManifest } from '@/core/nav/types';
export const navManifest: NavManifest = {
  module: 'lab',
  entries: [
    { id: 'lab.status_board', label: 'lab.nav.status_board', routeId: 'staff.lab.status_board',
      permission: 'lab.status_board.read', group: 'laboratory', order: 10, icon: 'activity', chord: 'g s' },
  ],
};
```

```ts
// apps/web/src/core/nav/types.ts
export type NavGroup = 'front_desk' | 'laboratory' | 'reporting' | 'billing' | 'catalog' | 'instruments' | 'analytics'
  | 'quality' | 'inventory' | 'partners' | 'engagement' | 'home_collection' | 'admin' | 'platform';
export interface NavEntry {
  readonly id: string;              // '<module>.<snake>' unique across all manifests
  readonly label: string;           // message key
  readonly routeId: RouteId;        // must exist in contracts/routes.yaml with origin staff_web and the same permission
  readonly permission: PermissionCode;
  readonly group: NavGroup;
  readonly order: number;           // ascending within group
  readonly icon?: IconName;
  readonly chord?: `g ${string}`;   // two-key navigation chord, unique across all manifests
  readonly phase?: '1' | '1.5' | '2' | '3';
}
export interface NavManifest { readonly module: ModuleName; readonly entries: readonly NavEntry[] }
```

Build rules (`build-nav.ts`): unique `id` and `chord`; `routeId` exists in `routes.yaml`; `permission` equals that route's `permission`; `module` equals the directory. Any violation fails the build. Group order in the sidebar is the `NavGroup` order above. Routes with path parameters (detail pages) are not nav entries.

---

## 4. Keyboard model (staff web)

| Scope | Keys | Action |
|---|---|---|
| Global (shell) | `?` | open Keyboard shortcuts dialog (lists global + current page shortcuts) |
| | `Alt+N` / `Alt+M` | focus navigation / focus main content |
| | `Alt+H` | toggle help panel |
| | `g` then a letter | navigate to the nav entry with that chord (1.5 s window [CONV]) |
| | `Esc` | close the topmost dialog / drawer / popover |
| Forms | `Ctrl+Enter` | submit (`Form`) |
| | `Enter` in single-line field | moves to the next field when `Form` has `enterAdvances` (front-desk mode [CONV]); otherwise default |
| Tables | arrows, Enter, Space, Shift+Space, Ctrl+A, Shift+F10 | §2.5 |
| Date picker | §2.3 | |
| Page-level | `Alt+<letter>` | declared by the module in its `04-UI-UX.md` and registered with `shortcuts.register(pageId, …)`. The registry throws in dev, and the build check fails, on duplicates within a page or conflicts with global keys (AC-0D-7.5) |

Shortcuts are never active while an IME composition is in progress (Devanagari input).

---

## 5. Accessibility rules (WCAG 2.2 AA, CV §14)

1. Every input has a visible label. Placeholder text is never the label.
2. Errors are text, linked by `aria-describedby`, and summarised at form level (`ErrorSummary`).
3. Visible focus everywhere (`color.focus.ring`, 2 px). Focus is never trapped except inside an open dialog (focus returns to the trigger on close).
4. Colour is never the only signal: chips and flags carry text, critical values carry an icon + "Critical" text.
5. Live regions: toasts `role="status"` (danger tone `role="alert"`); `BarcodeInput` announces "Scanned" / "Invalid barcode"; table loading announces "Loading results".
6. Target size ≥ 24 × 24 px (AA) everywhere, and the kit uses 44 × 44 px on touch surfaces (§1.5).
7. Reflow: portal/partner pages usable at 320 CSS px width without horizontal scroll (except data tables, which scroll inside their own container).
8. Motion respects `prefers-reduced-motion`.
9. Automated: axe-core scan of all stories in CI (AC-0D-8.6). Manual: one keyboard-only walk-through per component release.

---

## 6. Responsive rules

| Surface | Primary target | Rules |
|---|---|---|
| Staff web (`apps/web`) | reception/lab PCs ≥ 1280 px (ASSUMPTION) | full layout ≥ `xl`; at `lg` (1024) the side nav collapses to icons; below `lg` a "best on a larger screen" banner appears but everything still works. Density `compact` default for tables |
| Patient portal (C6), partner portal (C13) | phones first | single column below `md`; tables become stacked cards (`DataTable` `hideBelow` + card renderer); `font.size.md` body |
| Flutter apps | phones 360–430 dp | `lims_ui` layouts; text scaling up to 200% without clipping |

---

## 7. Web shell (`apps/web/src/core/shell`)

```
┌───────────────────────────────────────────────────────────────────────────────┐
│ TopBar: [≡] Tenant display name · Centre selector (if >1 centre) · [?] [Help] [User ▾] │
├──────────────┬────────────────────────────────────────────────────────────────┤
│ SideNav      │ Banner slot (e.g. offline, session warning, support session)   │
│ grouped by   │ PageHeader: breadcrumbs · title · status · actions · help key  │
│ NavGroup     │ ─────────────────────────────────────────────────────────────── │
│ (filtered by │ Main content (module page)                                     │
│ permissions) │                                                                 │
│              │                                                 HelpPanel ▸    │
└──────────────┴────────────────────────────────────────────────────────────────┘
```

| Region | Content and behaviour |
|---|---|
| TopBar | tenant `display_name` (from `ctx.core.tenant`); **centre selector** shown when the membership has > 1 centre. It sets a session-scoped "working centre" preference that features may use as a default (e.g. C4 registration centre). It is **not** an authorisation input: RLS still uses the membership (CV §5.8). Help toggle; shortcuts `?`; user menu (display name, "Sign out" → C2 route). During a support session (CV §6) a persistent warning banner reads "Support session — actions are recorded" (`core.shell.support_session`); this banner is the shell slot fed from `SessionState.actor.support_session` (CR-C2-009; 08 §4.6) |
| SideNav | entries from the generated manifest, filtered by `ActorProfile.permissions` (IdentityPort via BFF). Collapsible; state remembered per user in a cookie-free server preference (C2 setting) or not at all (v1: not remembered [CONV]) |
| Banner slot | offline/API-unreachable banner; session-expiry warning; maintenance banner (C1 flag) |
| Main | module route segment; must render its own `loading.tsx` and `error.tsx` using `LoadingSkeleton`/`ErrorState` |
| HelpPanel | content from `src/features/<m>/help/<helpKey>.ts`: `{ title, sections: { heading, body }[], shortcuts?: { keys, action }[], links?: { routeId, label }[] }`. Production build fails if any `PageHeader.helpKey` has no help file (CV §14; 04 L26 ढ) |
| SessionTimeoutDialog | at idle − 2 min: "You'll be signed out in 2 minutes because of inactivity." [Stay signed in] [Sign out] (`core.session.expiring`) |

Shell copy (`core.*`, English v1):
- `core.shell.no_modules`: "You have no modules assigned. Contact your lab administrator."
- `core.shell.offline`: "We can't reach the server. Your work on this page is not lost — try again."
- `core.shell.forbidden`: "You don't have access to this page."
- `core.shell.not_found`: "We couldn't find that record. It may not exist, or it may belong to another centre."
- `core.shell.error`: "Something went wrong. If it keeps happening, share this reference with support: {ref}."
- `core.session.expired`: "You were signed out because your session ended. Sign in again to continue."

---

## 8. Flutter base (`packages/ui-flutter`, package `lims_ui`)

| Item | Specification |
|---|---|
| Theme | `LimsTheme.light(accent: Color?)` → `ThemeData` with `ColorScheme` built from `tokens.g.dart` (generated from the same `tokens.json`); same tones and status mapping as §1.2–§1.3; Material 3 [CONV] |
| Fonts | Noto Sans, Noto Sans Devanagari, Noto Sans Mono bundled as package assets (no runtime download — 04 §11) |
| State management | Riverpod (binding for C16/C17, CV §2.5) — `lims_ui` widgets are state-agnostic; examples in `example/` use Riverpod |
| Widgets | `LimsScaffold` (app bar, offline banner slot, sync status slot) · `LimsButton` · `LimsTextField` (maxLength required) · `LimsDecimalField` · `LimsMoneyField` · `LimsDatePicker` (A.D./B.S.; B.S. grid via `nepali_date_picker` 8.0.0 inside the widget only, values A.D. through `lims_shared/bsdate` — 04 D13) · `LimsStatusChip` · `LimsFlagBadge` · `LimsResultValue` · `LimsListTile` · `LimsEmptyState` · `LimsErrorState` · `LimsLoading` · `LimsDialog` / `LimsConfirmDialog` (with reason codes) · `LimsSnackbar` · `LimsBarcodeScanner` (camera scan; package chosen at pin time per `02-TRD.md` §2.2; returns the same pattern-validated value semantics as §2.4) · `LimsOfflineBanner` · `LimsSyncStatus` (queued/syncing/synced/error counts for C17) · added by CR-C16-016 (08 §4.6): `LimsPhoneField`, `LimsOtpField`, `LimsCodeField` (grouped `XXXXX-XXXXX`), `LimsStageTimeline`, `LimsSlotPicker`, `LimsSegmentedControl`, `LimsBottomNav`, `LimsCard`, `LimsQrCode`, `LimsPdfViewer`, `LimsProfileSwitcher`, `LimsAppLockGate` |
| Dependency pins (CR-C16-017, CR-C17-010) | router/app links, external browser, local auth (biometric prompt), PDF render, QR render, `url_launcher`-class hand-off, on-device location capture — each with licence check and no runtime egress, recorded in `02-TRD.md` §2.3 |
| Accessibility | `Semantics` labels on every interactive widget; 48 dp targets; text scale up to 2.0; colour + text for status |
| Security hooks (for C16/C17) | `LimsSecureScreen` wrapper to set screenshot protection on PHI screens where the platform supports it (REQ-SEC-109) — implementation detail confirmed in C17 TRD; sensitive text fields default `enableSuggestions: false`, `autocorrect: false` (REQ-SEC-111) |

---

## 9. Developer experience (non-UI deliverables)

### 9.1 Commands (root `package.json` scripts; owner 0A unless noted)

| Command | Does |
|---|---|
| `pnpm dev:up` / `dev:down` / `dev:reset` | dev stack (`02-TRD.md` §3.6) |
| `pnpm codegen` (0C) | all generators (`02-TRD.md` §5.3) |
| `pnpm mock:<m>` / `pnpm mock:list` (0C) | Prism mock per domain |
| `pnpm db:migrate` / `pnpm db:new <schema> <verb_object>` (0B) | apply migrations / create a correctly named file with the owner-switch header and checklist comment |
| `pnpm db:test` (0B) | isolation + role + policy + immutability suites |
| `pnpm db:policies:dump` (0B) | regenerate `db/policies/*.sql` |
| `pnpm worker:registry-sync` / `pnpm worker:replay` (0D) | `02-TRD.md` §7 |
| `pnpm test:probes --module <m>` (0C) | probe coverage report for one module |
| `pnpm ui:stories` (0D) | component story server on 127.0.0.1 |

### 9.2 Failure messages (style)

Boot and CI failures name the file, the rule and the fix, for example:
`module 'lab': handler missing for operationId 'rejectSpecimen' (contracts/openapi/lab.yaml). Add services/api/src/modules/lab/handlers/rejectSpecimen.ts and export it from handlers/index.ts.`
Messages never include secrets, connection strings or PHI.

### 9.3 API style

API style rules are CV §4. C0 adds no rules. `_common.yaml` (`02-TRD.md` §5.1) is the only place shared HTTP components live.

## 10. CR candidates for this kit

- **CR-C0-009** (raised in `02-TRD.md` §17 list by reference): `TenantSettings.branding.accentColor` for §1.6 — MERGED in 08 into CR-C2-008 (final `branding` block, 08 §4.12).
- Components likely requested in Wave 1 that are deliberately **not** in v1 of the kit: label-print preview (C5 owns label printing), rich-text editor for narrative reports (C6; needs a server-side sanitiser per REQ-SEC-088 — CR when C6 specifies it), signature capture (C17), queue display board (C16). Each comes by CR with its props spec. **Accepted since:** `RichTextEditor` (CR-C6-010) and the queue display board `QueueBoard`/`TokenSlip` (CR-C16-016) — see §2.8.
