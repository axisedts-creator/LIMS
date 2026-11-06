# C12 Inventory — 04 UI/UX

Status: DECISION, 2026-11-06. Staff web only (`apps/web`, route segment `(staff)/inventory`). No mobile UI.

Components come only from `@lims/ui` (C0 04-UI-UX §2; CV §14). Names below are the C0 inventory names. Anything missing is listed in §9 as a CR candidate.

Message keys follow `inventory.<screen>.<key>` (CV §13). English v1. Copy text below is the English value.

## 1. Global rules

| Topic | Rule |
|---|---|
| Layout | `PageShell` + `PageHeader` (`helpKey` required: `inventory.help.<screen>`) on every page; content in `Card`/`Stack`/`Grid` |
| Quantities | `DecimalField` (`decimals` = 6 max, displayed trimmed; `allowNegative` false) followed by the unit text (CR-C12-009, accepted in 08 §4.6, adds `suffix`; until C0-0D ships it an adjacent text). Quantity display: trimmed decimals + unit display (`mL`, `test`), e.g. `400 test`, `0.1 mL` |
| Pack entry | `Select` "Unit" next to every quantity: base unit + active packs ("BOX (400 test)"). Choosing a pack shows "= 800 test" below the field (computed client-side for display only; the server is the authority) |
| Money | `MoneyText` (grouping `lakh` [CONV: Nepali convention]); `MoneyField` for prices. Money columns and fields render only when the actor holds `inventory.cost.read` (the server omits them anyway) |
| Dates | `DatePicker` / `DateText` honour the tenant `calendarDisplay` (04 D12); expiry dates are A.D. values; B.S. shown as hint when the setting is AD_BS/BS_AD |
| Status | `StatusChip kind="generic"` with tone + label per §8 table |
| Tables | `DataTable` with cursor paging (limit 50), `FilterBar`, `caption`, `emptyState`; `onRowAction` opens detail |
| Reason-coded actions | `ConfirmDialog` with `requireReason` (coded set from #28 by reason group) |
| Errors | `Form` `problem` maps `errors[].path` to fields; non-field codes show a `Banner tone="danger"` with the registry title + `request_id` |
| Branch scope | store pickers list only stores of the user's visible branches (#11) |
| Idempotency | each form generates a UUIDv7 key when opened and reuses it on resubmit; a successful submit resets it |
| Help | in-app help panel (`Alt+H`) per screen; the consumption-model explanation (PRD §1.1 text) is `inventory.help.consumption_model`, linked from S1, S13, S17 |

Navigation (`nav.manifest.ts`, group `inventory`, phase `2`; route ids from CR-C12-002):

| Entry id | Label | Route id | Permission | Order | Chord [CONV] |
|---|---|---|---|---|---|
| inventory.home | Inventory | staff.inventory.home | inventory.item.read | 10 | `g y` |
| inventory.stock | Stock | staff.inventory.stock | inventory.item.read | 20 | — |
| inventory.purchase_orders | Purchase orders | staff.inventory.purchase_orders | inventory.item.read | 30 | — |
| inventory.receipts | Goods receipts | staff.inventory.receipts | inventory.item.read | 40 | — |
| inventory.transfers | Transfers | staff.inventory.transfers | inventory.item.read | 50 | — |
| inventory.counts | Stock counts | staff.inventory.counts | inventory.item.read | 60 | — |
| inventory.bench | Bench | staff.inventory.bench | inventory.bench.record | 70 | — |
| inventory.items | Items | staff.inventory.items | inventory.item.read | 80 | — |
| inventory.rules | Consumption rules | staff.inventory.rules | inventory.item.read | 90 | — |
| inventory.unresolved | Waiting consumption | staff.inventory.unresolved | inventory.item.read | 100 | — |
| inventory.alerts | Alerts | staff.inventory.alerts | inventory.item.read | 110 | — |
| inventory.reports | Reports | staff.inventory.reports | inventory.item.read | 120 | — |
| inventory.suppliers | Suppliers | staff.inventory.suppliers | inventory.item.read | 130 | — |
| inventory.stores | Stores | staff.inventory.stores | inventory.item.read | 140 | — |
| inventory.settings | Settings | staff.inventory.settings | inventory.master.manage | 150 | — |

The chord `g y` is unique only if no other manifest uses it. The C0 build check (C0 04-UI-UX §3) enforces uniqueness; on a collision C12 changes its chord.

## 2. Keyboard and scanner

| Scope | Keys | Action |
|---|---|---|
| Line editors (S6, S7, S8, S9, S10) | `Alt+L` | add line (focus item field of the new line) |
| | `Ctrl+Delete` | remove focused line (draft only) |
| | `Ctrl+Enter` | submit (Form default) |
| | `Enter` in a qty field | move to next field |
| Lists | `/` | focus the FilterBar text filter |
| S11 count entry | `Enter` | save counted qty of the current line and move to the next uncounted line |
| Scan-first screens (S7 receive, S8 issue, S11 count, S12 bench) | `useScanCapture` enabled when no editable field has focus | see below |

Scanner behaviour. Item barcodes use `BarcodeInput` with `pattern = /^[\x21-\x7E]{1,64}$/` (override of the sample-barcode default; supplier codes are not sample barcodes) and `clearAfterScan = true`. Lowercase scans are accepted; the server upper-cases the value before storing and before lookup (`02-TRD.md` #8, #10). On scan:
1. call #10 lookup;
2. on success, add a line for the item (or focus its existing line and add 1 pack when the barcode carries a pack);
3. on 404, show the toast "inventory.scan.unknown" **"This barcode is not linked to an item. Link it from the item page."** and play the kit's error tone.

The scanned value is never logged and never put in a URL (C0 04-UI-UX §2.4 rule 6 applies by analogy; item barcodes are not PHI, but the rule is kept uniform). GS1 multi-field barcodes are not parsed (PRD §4.2). The lot number field accepts a second scan into a focused `TextField`.

## 3. Screens

Fields are given as name — component — type/validation — required — default — max length.

### S1 Inventory home (`/inventory`)
- Header "Inventory". Actions: "New PO" (po.manage), "Receive goods" (stock.manage).
- Row 1: `StatTile` ×4 — "Below reorder" (count of open `below_reorder`), "Expiring in N days" (`expiry_soon`), "Expired on hand", "Waiting consumption" (unresolved facts). Each links to the filtered S16/S15.
- Row 2: `Banner tone="warning"` when automatic consumption is off. Copy **"Automatic consumption is off. Stock is not deducted for tests, QC or reruns until a manager turns it on in Settings."** With master.manage the banner offers the action "Open settings".
- Row 3: a `DataTable` of the 10 newest open alerts (columns: kind, store, item, lot, raised, occurrences).
- Set-up checklist `Card` (shown until done): stores per branch ✓, items ✓, packs ✓, rules ✓, analyser bindings ✓, opening balances ✓, consumption switched on ✓.

### S2 Items list / S3 Item detail
List columns: Code, Name, Category, Base unit, Lot-tracked, Active, Updated. Filters: category (select), active (select), text (code/name prefix, maxLength 60).

Create/edit form (`Form`; Drawer on S2, inline on S3):

| Field | Component | Validation | Req | Default | Max |
|---|---|---|---|---|---|
| Code | TextField | `^[A-Z0-9][A-Z0-9_.\-]{0,31}$`, upper-cased on blur | yes | — | 32 |
| Name | TextField | 1–200 | yes | — | 200 |
| Category | Select | reagent/kit/consumable/control/calibrator/other | yes | reagent | — |
| Base unit | CodedSelect `uom` | — | yes | test | — (read-only once the item has any pack, rule or movement — same condition as AC-01.5 and the DB trigger; tooltip "Used by packs, rules or stock — create a new item to change the unit") |
| Manufacturer | TextField | ≤ 120 | no | — | 120 |
| Catalogue no. | TextField | ≤ 64 | no | — | 64 |
| Storage | Select | ambient/refrigerated/frozen/other | no | — | — |
| Track lots | Switch | — | — | on | — |
| Expiry required | Switch | only when Track lots on | — | on | — |
| Open stability (days) | IntegerField | 1–3650 | no | — | — |
| Container size | DecimalField + unit | > 0 | no | — | — |
| HS code | TextField | `^[0-9]{4,10}$` | no | — | 10 |
| Default tax | CodedSelect `tax_codes` | — | no | — | — |
| Notes | TextArea | ≤ 1000 | no | — | 1000 |

S3 tabs:
- **Overview** (DescriptionList).
- **Packs**: table Code/Label/Unit/Qty in base/Default/Active, plus "Add pack" with fields Code `^[A-Z0-9_]{1,16}$`, Label ≤ 60, Unit (CodedSelect), Qty in base (DecimalField > 0), Purchase default (Checkbox). Qty in base is shown read-only after creation, with the note **"Pack size cannot change. Add a new pack instead."**
- **Barcodes**: `BarcodeInput` "Scan or type barcode" + pack select.
- **Stock**: balances by store/lot (#34 item filter).
- **Movements** (#35).
- **Rules** (#69 item filter).
- **Suppliers** (supplier items of this item).

### S4 Stores (`/inventory/stores`)
Columns: Code, Name, Branch, Kind, Default consumption (Badge), Active. Form fields: Branch (Select of visible branches; create only), Code (`^[A-Z0-9][A-Z0-9_\-]{0,15}$`, 16), Name (1–120), Kind (Select), Default consumption store (Switch; help text **"Tests and QC from analysers without their own store are deducted here."**). Store detail tab "Reorder settings": `DataTable` of items with inline `DecimalField`s for Reorder level, Reorder qty, Max level, a `Combobox` for Preferred supplier, and a Switch for Stocked (#16 per row on blur, with If-Match).

### S5 Suppliers
Columns: Code, Name, PAN, Phone, Active. Form: Code (16), Name (200), PAN (TextField `^[A-Za-z0-9]{1,20}$`, label "PAN / VAT no. (as on supplier invoice)"), Contact name (120), Phone (40, `inputMode tel`), Email (254, `inputMode email`), Address (TextArea 500), Payment terms days (IntegerField 0–365), Notes (1000). Tab "Items": item + pack + supplier code (64) + last price (`MoneyField`) + lead time (0–365) + default tax.

### S6 Purchase orders
List columns: PO no., Supplier, Store, Status (chip), Total†, Created, Expected. Filters: status (multi), supplier, branch, created range.

Editor (draft):
- Header fields: Supplier (Combobox #17; required), Receiving store (Select; required), Expected on (DatePicker; ≥ today), Notes (TextArea 1000).
- Lines table (editable): Item (Combobox #1 + scan), Pack (Select of the item's packs; required), Qty (DecimalField, max 3 decimals and 9 integer digits — `DecimalStringPacks`, `02-TRD.md` §6.1 — > 0), Unit price† (MoneyField ≥ 0), Discount† (MoneyField ≥ 0, ≤ gross), Tax (CodedSelect `tax_codes` plus an option "Exempt (no tax code)" that sends `is_exempt: true` and no `tax_code` — 08 A4.1, A17 D-70 [CONV: label]; tax code labels show the code display ("VAT") followed by the rate from the line's `tax_rate_bp` snapshot after save, e.g. "VAT 13%"), Net† / VAT† / Total† (read-only, from the server after save).
- Footer totals† (server). Buttons: "Save draft" (primary), "Approve" (po.approve; disabled while unsaved changes exist), "Delete line".
- Copy under totals: **"Amounts are calculated by the system when you save."**

Detail (non-draft): DescriptionList header; lines with Ordered / Received / Open / Closed-short; `Timeline` of approve/sent/receipts/close; actions per state:
- approved: "Mark as sent", "Print", "Receive", "Cancel";
- sent: "Receive", "Cancel", "Print";
- partially_received: "Receive", "Close";
- received: "Close".

"Mark as sent" dialog: Channel (RadioGroup email/phone/in person/portal/other; required), Reference (TextField 120).

Print view S6-P (`/purchase-orders/[po_id]/print`): plain print CSS; tenant display name, branch name, PO no., dates (dual calendar per setting), supplier block, lines, totals, approved-by display name. "DRAFT — NOT APPROVED" diagonal watermark for drafts. No QR, no signatures [CONV].

### S7 Goods receipt
Start from a PO ("Receive" pre-fills open lines) or "New receipt" (kind purchase; opening balance appears only with stock.adjust).

Header fields:

| Field | Component | Validation | Req | Default | Max |
|---|---|---|---|---|---|
| Store | Select | visible stores | yes | PO store | — |
| Supplier | Combobox | — | purchase: yes | PO supplier | — |
| Received at | DateTimePicker | within back-date window | yes | now | — |
| Supplier invoice no. | TextField | — | no | — | 64 |
| Invoice date | DatePicker | — | no | — | — |
| Invoice total† | MoneyField | ≥ 0 | no | — | — |
| Notes | TextArea | — | no | — | 1000 |

Lines: Item, Pack, Qty packs (DecimalField ≤ 3 decimals, ≤ 9 integer digits), **Lot no.** (TextField 64; required for lot-tracked; accepts a scan), **Expiry** (DatePicker; required when expiry required; must be ≥ received date), Manufactured (DatePicker, optional), Unit price†, Discount†, Tax.

Inline line errors:
- missing lot: **"Enter the lot number printed on the pack."**
- expired: **"This lot has already expired. It cannot be received."**
- over receipt: **"More than ordered (open: {open})."**

Mismatch warning (Banner warning): **"Invoice total {invoice} differs from the calculated total {calc} by {diff}."**

Buttons: "Save draft", "Post receipt" (`ConfirmDialog`: **"Post this receipt? Stock will be added and the receipt can no longer be edited."**).

### S8 Stock and issue (`/inventory/stock`)
- Filters: Store (required; defaults to the user's first visible store, remembered per session), Category, Item text, Below reorder (Checkbox), Expiring within days (IntegerField 1–365), Show zero (Checkbox).
- Columns: Item code, Item, Lot, Expiry (red text "Expired" / amber "Expires in n days" — text, not colour only), Lot status, Qty, Available, Open container (Badge), Reorder level, Value†, Avg cost†.
- Row actions: Issue, Transfer, Wastage, Movements.
- "In transit" `Card` above the table: dispatched transfers to/from this store.

Issue drawer:
- Issued to (RadioGroup department/analyser/general);
- Department (Select via C3 HTTP departments list; required if department);
- Analyser (Combobox via C7 HTTP; required if analyser);
- Occurred at (DateTimePicker, default now);
- lines: item, qty + unit, lot (Select: "Auto (FEFO)" default + candidate lots).

The **FEFO preview** panel shows #36 output: lot, expiry, open container, take, available, plus shortfall. Copy: **"Lots are taken in the order shown: opened containers first, then earliest expiry."**

### S9 Transfers
List columns: No., From, To, Status, Lines, Dispatched, Received. Editor: From store (Select, visible), To store (Select from #11 with `purpose=transfer_target`: all active stores of the tenant, minimal fields; the destination need not be in the sender's scope), lines (item, lot (auto/FEFO or pick), qty). Dispatch confirmation: **"Dispatch? Stock leaves {from} now and shows as in transit."** Receive screen: per line, Received qty (DecimalField 0–dispatched) + Discrepancy reason (CodedSelect `transfer_discrepancy`, required when less).

### S10 Wastage, adjustments, expiry write-off (tabs)
- **Wastage**: store, occurred at, reason (CodedSelect `wastage`, required), note (TextArea 500), lines.
- **Adjustment** (tab visible with stock.adjust): store, reason (`adjustment`), direction per line (RadioGroup in/out), lines. Submit triggers step-up when aal1.
- **Expiry write-off**: store → table of expired lots with stock (from #34 `expired_only=true`) with checkboxes (max 200) → "Write off selected" (ConfirmDialog **"Write off all remaining stock of {n} expired lots?"**).

### S11 Stock count
- List columns: No., Store, Status, Opened, Posted, Lines counted / total.
- "New count": store, category (optional), notes.
- Count screen: table Item, Lot, Expiry, **Counted** (DecimalField), Counted at (auto on entry), Reason (CodedSelect `adjustment`, optional). Book quantity is hidden by default; the Switch "Show system quantity" requires stock.adjust (DECISION: blind count).
- `useScanCapture`: a scan focuses the item's first line; an unknown item/lot pair can be added with "Add line".
- "Review" shows variance per line (server preview) and totals (value†).
- "Post count" (stock.adjust) — ConfirmDialog with `uncounted_policy` RadioGroup "Leave uncounted lines unchanged" (default) / "Treat uncounted lines as zero".

### S12 Bench (`/inventory/bench`)
For technologists. Store selector (bench stores first).
- **Open containers** table: Item, Lot, Analyser, Opened, Open expiry (text "Open expiry passed" when past), actions Finish / Discard.
- "Open container" form: Item (scan or search), Lot (Select of lot candidates with stock in this store, FEFO-ordered; required for lot-tracked), Analyser (Combobox; optional; help **"Choose the analyser this bottle is loaded on. Automatic deductions for that analyser use this lot."**), Opened at (default now).
- Discard dialog: Remaining qty (DecimalField + unit), Reason (CodedSelect `wastage`).
- **Log calibration / manual QC** form: Kind (RadioGroup Calibration/QC), Analyser (Combobox; optional for QC), Test (Combobox via C3 HTTP; required), Analyte (Select from the test's analytes; QC optional), Observations (IntegerField 1–50; QC only; default 1), Occurred at (DateTimePicker; within back-date window; default now), Reason (CodedSelect `calibration`; calibration required), Note (TextArea 500, help **"Do not enter patient details."**).
- Success toast: **"Logged. {n} items deducted."** For `no_rule`: **"Logged. No consumption rule matches, so nothing was deducted."**

### S13 Consumption rules
- Filters: kind, test, analyser, item, show history.
- Columns: Kind, Test, Analyte, Analyser ("Any analyser" when null), Item, Qty + unit, Effective from, Status (Current / Superseded / Inactive).

Create form:

| Field | Component | Validation | Req |
|---|---|---|---|
| Kind | RadioGroup: Per test, Per analyte result, Per rerun, Per QC observation, Per calibration, Per analyser-day | — | yes |
| Test | Combobox (C3 HTTP) | required unless per analyser-day | cond. |
| Analyte | Select (test analytes) | per analyte: required; per QC: optional ("Every QC result on this analyser") | cond. |
| Analyser | Combobox (C7 HTTP) + "Any analyser" checkbox | per analyser-day: required | cond. |
| Item | Combobox (#1) | active | yes |
| Quantity | DecimalField > 0 + Unit Select (base or pack) | | yes |
| Notes | TextArea 500 | | no |

Inline guidance (Banner info) per kind:
- Per test: **"Deducted once for each test on an order when its first result is verified."**
- Per analyte result: **"Deducted once for each verified result of this analyte."**
- Per rerun: **"Deducted when the analyser reports a rerun. Not every analyser reports reruns."**
- Per QC observation: **"Deducted for each QC result received from the analyser. If you leave the analyte empty, this is deducted once for every analyte in every QC run."**
- Per calibration: **"Deducted when someone logs a calibration on the Bench page, or when the analyser reports a calibration (supported analysers only)."**
- Per analyser-day: **"Deducted once per day for each day the analyser sent any results."**

"Preview" button → #74 result in a Drawer. Edit quantity = "Change quantity" → supersede dialog: **"The old rule stops now. Earlier deductions are not changed."**

### S14 Analyser bindings (tab in S4 "Analysers")
Table: Analyser (label from `instruments.v_pub_instrument_directory`, CR-C9-006; else id + C7 HTTP lookup client-side), Store, Since. Bind: Analyser (Combobox), Store (Select). Success toast with resolution count: **"Linked. Waiting records for this analyser will be posted shortly."**

### S15 Waiting consumption (`/inventory/unresolved`)
Columns: Occurred, Kind, Analyser, Test, Reason "No store found". Actions: "Post to store…" (Select store → #77), "Dismiss" (reason `fact_dismiss`). Header copy: **"These deductions could not be posted because no store is linked to the analyser and no default store is set."**

### S16 Alerts
Columns: Kind (text), Store, Item, Lot, First raised, Last raised, Occurrences, Status. Filters: kind, status, store. Action: Acknowledge. Kind labels: Below reorder level / Expiring soon / Expired stock on hand / Open container past stability / Stock below zero / Waiting consumption / Expired lot in use / Stock record mismatch / Counts differ from lab.

### S17 Reports (`/inventory/reports`)
`Tabs`: Daily consumption · Analyser-wise · Cost per test† · Wastage · Expiry · Valuation · Reconciliation.

Common filters: `DateRangePicker` (`maxDays` 366), store/branch, analyser, test, item. "Export CSV" button (report.export).

| Tab | Visual |
|---|---|
| Daily consumption | `DataTable` + `BarChart` (value† or qty per day) |
| Analyser-wise | table grouped by analyser with a test-count sub-table |
| Cost per test | table: Test, Analyser, Tests, Direct CPT, Loaded CPT, Standard CPT (with "incomplete" Badge), Breakdown (Drawer). Footnote: **"CPT excludes wastage, expiry and count differences. See the Wastage report."** |
| Wastage | grouped by category |
| Expiry | table with days to expiry |
| Valuation | "As of" `DateTimePicker` (default now) |
| Reconciliation | two tables: tests (C12 verified events vs lab) and analysers (QC observations vs analyser QC records; listed, no alert — D-74). Tab shown only to users with all centres (`02-TRD.md` #92; otherwise hidden and the API returns 403). The E15 timezone banner is dormant in v1 (08 A13 P-15: only Asia/Kathmandu) |

### S18 Settings
Form (master.manage; otherwise read-only DescriptionList):

| Field | Component | Validation | Default |
|---|---|---|---|
| Automatic consumption | Switch + DateTimePicker "Start from" | when turning on, start ≥ now − 1 h (DECISION: no retro deduction; also enforced by the server, `02-TRD.md` #27 → `400 common.validation_failed`) | off |
| VAT included in cost | Switch | help **"Turn off if your lab can claim purchase VAT back (ask your auditor)."** (B7) | on |
| Allow approving own PO | Switch | — | off |
| Allow receipts without PO | Switch | — | on |
| Over-receipt tolerance % | DecimalField 0–50 (stored bp) | — | 0 |
| Expiry alert days | IntegerField 1–365 | — | 30 |
| Default consumption store | Select | active store | — |
| Lock store during count | Switch | — | off |
| Analyser-day rules need activity | Switch | — | on |
| Reconciliation alert % | DecimalField 0–100 | — | 2 |
| Back-dating limit days | IntegerField 0–31 | — | 7 |
| Number patterns ×5 | TextField 40 | tokens `{yy}` `{fy}` `{fyl}` `{seq:N}`; preview of next number shown | per 05 §2.4 |

## 4. Accessibility (WCAG 2.2 AA target, CV §14)
- Every field has a label; units are part of the accessible name, e.g. "Quantity (test)".
- Expiry and status are always text plus tone, never colour only.
- Tables have captions. Charts have the kit's hidden data table.
- Line editors are fully keyboard operable (§2). Focus moves to the ErrorSummary on failed submit.
- Toasts for success; `Banner` (role alert) for blocking errors.

## 5. Responsive rules
- Target: desktop and laptop ≥ 1280 px. The tablet (≥ 768 px) works for S12 Bench and S11 Count (touch-sized controls).
- Column hiding via `hideBelow`: Value/Avg cost `lg`, Manufacturer `xl`, Updated `md`.
- Line editors stack fields vertically below `md`.
- No phone layout is promised [CONV].

## 6. Copy for empty states
Per `03-APP-FLOW.md` §5 (the same strings are message keys `inventory.<screen>.empty`).

## 7. User manual pages (`docs/manual/inventory/`)
One page per screen, plus:
- `consumption-model.md` (PRD §1.1 text + how rules work);
- `cost-per-test.md` (PRD §8 formulas in plain language);
- `stock-count.md`;
- `vat-in-cost.md` (B7 note).

## 8. Status chip mapping (`StatusChip kind="generic"`)

| Entity | Status → tone / label |
|---|---|
| PO | draft neutral "Draft"; approved info "Approved"; sent info "Sent"; partially_received warning "Partly received"; received success "Received"; closed neutral "Closed"; cancelled danger "Cancelled" |
| GRN | draft neutral; posted success "Posted"; cancelled danger |
| Transfer | draft neutral; dispatched warning "In transit"; received success; cancelled danger |
| Count | open warning "Counting"; posted success; cancelled danger |
| Lot | available success; quarantined warning "Quarantined"; blocked danger "Blocked" |
| Fact | posted success; no_rule neutral "No rule"; unresolved warning "Waiting"; dismissed neutral; reversed neutral "Reversed" |
| Alert | open danger; acknowledged warning; resolved success |

## 9. Kit gaps (CR candidates to C0-0D)
- CR-C12-009: `DecimalField.suffix` (unit inside the field).
- Candidate (not raised yet): an editable line-grid component like the `EditableGrid` C5 lists as a CR candidate. C12 reuses whatever C0 ships for C5. Until then, line editors are built as `DataTable` rows whose cells are `@lims/ui` fields. That is composition, not a look-alike.
- Candidate: `StatusChip` kinds for inventory documents (today `generic` is used).
