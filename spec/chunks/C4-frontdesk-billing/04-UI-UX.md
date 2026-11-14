# C4 Front Desk & Billing — 04 UI/UX

Status: DECISION draft, 2026-11-05. Staff web only (`apps/web`, server-only BFF — 04 S4). Composed only from `@lims/ui` (02-CV §14). UI language English with message keys `frontdesk.<screen>.<key>` / `billing.<screen>.<key>` (02-CV §13). Dates: tenant `calendarDisplay` everywhere **except** fiscal documents and statutory registers, which always show both B.S. and A.D. (02-CV §13; 04 L11).

## 1. Global rules

- Keyboard-first (02-CV §14): every action reachable without a mouse; tab order = visual order; visible focus ring from tokens; shortcuts listed in a `KeyboardShortcutsDialog` (and `Button.shortcut` hints) on every C4 screen and in in-app help.
- Reserved browser keys are never overridden: `F5`, `Ctrl+R`, `Ctrl+W`, `Ctrl+T`, `Ctrl+P` (printing goes through our print button so the print count is recorded first).
- Money: `MoneyField` accepts rupees with up to 2 decimals ("1250", "1,250.50"), converts to paisa client-side for display only — the server is authoritative. Display `NPR 1,250.00`. Never colour-only status (02-CV §14).
- Copy rules (US-BL-16, CI scan): never "IRD approved", "IRD-approved", "IRD certified", "approved by IRD"; never "commission". Use "referral" wording only where referrers are shown. CBMS status under stub: "Not sent — CBMS connection not configured".
- PHI on screen: patient full name and phone only on screens whose permission set includes them (mapper allowlists, TRD §5). Lists show masked phone `98xxxxxx42`. No PHI in page titles, URLs, toasts that persist, or browser storage (drafts live in memory only).
- Every page has `loading.tsx` and `error.tsx` (02-CV §2.4) and the in-app help component (04 L26 cl.6(ढ)).
- Live updates: polling through the BFF (approval inbox 10 s, approval wait 3 s, export status 2 s, QR payment 3 s) — no Supabase client in the browser (04 S4).

## 2. Components used (`@lims/ui`) and CR candidates

Assumed kit names (C0-0D confirms; anything missing is requested in **CR-C4-013**; no local look-alikes):
`AppShell`/`PageHeader` (core), `Card`, `Button`, `IconButton`, `TextField`, `TextArea`, `Select`, `RadioGroup`, `Checkbox`, `Switch`, `DatePicker` (A.D.), `Tabs`, `Dialog`, `ConfirmDialog`, `Drawer`, `useToast`, `Banner`, `Badge`, `EmptyState`, `LoadingSkeleton`, `Spinner`, `Tooltip`, `FormField` (label + `aria-describedby` error), `HelpPanel`.
Kit components per CR-C4-013 as accepted in 08 R22/§4.6: `MoneyField`, `MoneyText`, `DateText` (`mode="AD_BS"`, B.S. + A.D. text), `Combobox` (async server search, keyboard list), `DataTable` (cursor pagination, keyboard row navigation, column sort), `FileUpload` (+ `scanState`), `StatusChip` (text + icon, never colour-only), `Button.shortcut` / `KeyboardShortcutsDialog` (shortcut hints), `ConfirmDialog` with coded reason select + conditional text, and the new `PrintFrame` (hidden iframe, `@media print` stylesheet, fires `window.print()` after load). `QrCode` (CR-C13-013, local SVG) for the Pay-by-QR dialog.

## 3. Registration page — `/frontdesk/registrations/new` (route `staff.frontdesk.registration_new`)

### 3.1 Layout (≥1280 px: three columns; 1024–1279: two columns, payment under bill; <1024: single column, warning banner "Registration is optimised for desktop")
```
┌───────────────────────── PageHeader: "New registration"  [centre: A1 ▾]  shortcut hint ──────────────────────────┐
│ A. PATIENT (col 1)              │ C. TESTS (col 2)                         │ E. BILL (col 3)                     │
│  [F2] Search name/mobile/code   │  [F4] Search test / package              │  lines table, surcharge lines        │
│  result list (≤20)              │  selected items table (priority toggle)  │  discounts (F6)                       │
│  [Alt+N] New patient form       │  D. TRF upload [Alt+U]                    │  totals: gross, discount, exempt,     │
│ B. VISIT                         │                                          │  taxable, VAT, other tax, NET         │
│  visit type OPD/IPD (Alt+O/I)   │                                          │ F. PAYMENT [F8]                       │
│  billing mode cash/credit       │                                          │  method, amount, reference; + add    │
│  credit party (if credit)       │                                          │  tendered / change (cash)            │
│  referrer [F3] + quick add      │                                          │  [Pay by QR] (flag)                   │
│  collection mode                │                                          │  balance after payment               │
│  urgent (Alt+R)                 │                                          │ [Ctrl+Enter] Register & print        │
└──────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```
Quote is refreshed (F8 `quoteRegistration`) 300 ms [CONV] after any change to items, priority, referrer, credit party, centre or discounts; the bill panel shows a "Prices updating…" skeleton meanwhile; Register is disabled until the latest quote returned.

### 3.2 Fields

**A. Patient search**
| Field | Type | Validation | Default | Max | Behaviour |
|---|---|---|---|---|---|
| Search | `Combobox` | name ≥ `patient_search_min_chars` (3) or digits ≥10 or code/reg-no pattern | focus on load | 100 | 250 ms debounce; ↑/↓ moves, Enter selects; Esc clears |
| Result row | — | — | — | 20 rows | shows: patient code, name, sex, age ("43 Years"), masked phone, last visit date (tenant calendar) |
| Membership (selected patient) | `Badge` | — | — | — | plan name + "valid to" date from `EngagementPort.getActiveMembership` (CR-C16-014, 08 R25); hidden when none (always hidden while the C16 phase stub returns `undefined`) |
Barcode/QR scanner (keyboard wedge): a burst of ≥8 characters within 50 ms ending in Enter [CONV] is treated as a scan; if it matches the registration-no or patient-code pattern the search runs immediately in exact mode. Specimen barcodes are C5's and are not resolved here (a scan matching the barcode pattern shows "This is a sample barcode — open it from the Lab status board").

**A2. New patient (Alt+N opens inline form; Esc returns to search)**
| Field | Type | Required | Validation | Max |
|---|---|---|---|---|
| Full name | TextField (Unicode; Devanagari allowed) | yes | 1–200 chars after trim | 200 |
| Sex | RadioGroup male/female/other/unknown (keys M/F/O/U) | yes | — | — |
| Date of birth | DatePicker (A.D.; B.S. shown beside via `DateText mode="AD_BS"`) | one of DOB/age | not in future; age ≤150 y | — |
| Age | three number fields years/months/days | one of DOB/age | years 0–150, months 0–11, days 0–31 | — |
| Mobile | TextField | no | 10-digit local → shown as +977…; or E.164 `^\+[1-9][0-9]{7,14}$` | 16 |
| Email | TextField | no | basic email syntax | 254 |
| Address | TextArea | no | — | 300 |
| Consents | Checkbox group: "Processing of my data for testing (required)", "SMS", "WhatsApp", "Email", "Share report with referring doctor" | processing yes | consent text version shown with a "Read consent text" link (HelpPanel) | — |
Duplicate dialog (409): table of candidates (code, name, sex, age, masked phone, last visit) → "Use this patient" (Enter on row) or "Create anyway" (requires reason from `duplicate_override_reasons`).

**B. Visit**
| Field | Type | Required | Default | Notes |
|---|---|---|---|---|
| Centre | Select (header) | yes | user's default centre (first of scope) | only centres in scope |
| Visit type | RadioGroup OPD/IPD | yes | OPD | Alt+O / Alt+I |
| Billing mode | RadioGroup Cash/Credit | yes | Cash | Alt+C toggles |
| Credit party | Combobox (C3 search) | iff credit | — | shows a lock/limit badge from the F8 quote's `credit_status` (`ok` / "Locked" / "Over limit"); `front_desk` holds no `billing.credit_party.read`, so B19 is not called here |
| Referrer | Combobox (C3 doctor search) + "Self" chip | if `require_referrer` | Self | F3 focuses; "+ Add doctor" (Alt+D) opens quick-add dialog (C3 operation; name, phone?, NMC no?) — fields per C3 spec; created doctor is flagged "pending verification" by C3 |
| Collection mode | Select walk-in/centre/home/partner | yes | walk-in | |
| Urgent | Switch | — | off | Alt+R; sets every item urgent unless overridden per row |

**C. Tests**
| Element | Behaviour |
|---|---|
| Search (F4) | C3 orderable search by short code ("CBC") or name/package; results show code, name, kind (Test/Panel/Package), price from the current quote context once added |
| Add | Enter adds and keeps focus in search; duplicates of the same orderable are refused with toast "Already added" |
| Items table | columns: Code, Name, Kind, Priority (toggle `U`), Price, Surcharge, Remove (`Del`) |
| Limits | 1–50 items |

**D. TRF upload (Alt+U)** — `FileUpload`, accepts `.jpg .jpeg .png .pdf`, ≤15 MB, ≤5 files. Each file row shows name (metadata), size, state badge: "Scanning…" / "Clean" / "Rejected by security scan" / "Scan failed — upload again". Preview button only when Clean: downloads through F21a `…/trf-attachments/{attachment_id}/content` via the BFF (attachment; no Storage URL in the browser — 08 A13 P-2). `FileUpload.scanState` mapping: pending→`pending`, clean→`clean`, quarantined→`infected`, failed→`unavailable`.

**E. Bill**
| Element | Detail |
|---|---|
| Lines | Code, Name, Unit price, Discount, Tax (Exempt / VAT 13% / other code), Net |
| Urgent surcharge | separate line "Urgent charge — <code>" |
| Discount (F6) | Dialog: scope Line (select line) / Bill; kind Amount / Percent; value; reason (required, `discount_reasons`); text if reason requires; shows "% of gross" and whether approval is required |
| Approval | when required: banner "Approval needed (limit X%)" + "Request approval (Alt+A)"; state chip Pending (timer to expiry) / Approved by <name> / Rejected (note) / Expired |
| Totals | Gross, Discount, Exempt, Taxable, VAT, Other tax, **Net** (bold, large) |

**F. Payment (F8)** (cash mode only; hidden for credit with text "Billed to <credit party> monthly")
| Field | Type | Validation | Default |
|---|---|---|---|
| Method | Select (`payment_methods` coded set) | required per row | Cash |
| Amount | `MoneyField` | 1 paisa ≤ amount; Σ rows ≤ Net | Net (first row) |
| Reference | TextField | required when method `requires_reference`; refuses 13–19 digit runs ("Do not enter card numbers") | — | max 100 |
| Tendered (cash) | `MoneyField` | ≥ amount | — | display only: Change = tendered − amount |
| Add method | `+` (Alt+P) | ≤5 rows | — |
| Balance after | MoneyText | Net − Σ amounts | — |
| Pay by QR | Button, visible when `pay_by_qr_enabled` (C15 live) | opens QR dialog (§3.6) | — |
Zero payment is allowed (full due; e.g. hospital patients paying later): Register shows confirm "No payment — NPR x will be due".

### 3.3 Submit
`Ctrl+Enter` (or button "Register & print"): disabled while quoting; sends F9 with the current `quote_fingerprint` and a per-draft Idempotency-Key. Responses:
| Response | UI |
|---|---|
| 201 | Success panel (§3.4), auto-print invoice (cash), auto label print (setting) |
| 409 `common.version_conflict` | banner "Prices changed since you added tests. Review and register again." changed lines highlighted |
| 409 `frontdesk.patient_duplicate_suspected` | duplicate dialog |
| 403 `frontdesk.discount_approval_required` | approval banner |
| 422 `frontdesk.consent_required` / `frontdesk.referrer_required` / `billing.payment_exceeds_due` / `frontdesk.discount_exceeds_limit` | field error at the right field |
| 409 `billing.credit_party_locked` / `billing.credit_limit_exceeded` | banner "Credit party is locked / over limit — choose Cash or contact finance" |
| 503 `billing.counter_busy` | auto-retry once (same key), then banner "Billing is busy, press Ctrl+Enter to retry" |
| 422 `catalog.tax_config_missing` | banner "Tax rate for <code> is not configured in the catalog — contact finance" (tax rules are maintained in C3 Pricing › Tax) |

### 3.4 Success panel
Shows: Registration no (large, selectable), Invoice no + "Printed (original)" or "Print" button, Paid / Due, SMS status text ("SMS queued", "SMS not sent: no consent", "SMS disabled for this lab"), Labels status ("Preparing labels…" while C5 #14a returns `409` and is retried every 1 s up to 10 s; after `200` the page opens C5 route `staff.lab.order_labels` (via `@lims/shared-ts/routes`) in a print frame and shows "Labels ready — printing"; on failure C5's error text + "Retry (Alt+L)") — 08 A13 D-4. Buttons: Print copy (marks copy), Open order (Alt+G), New registration (`Ctrl+Shift+N` — resets all state and focuses search).

### 3.5 Shortcuts (registration)
| Key | Action |
|---|---|
| F2 | focus patient search |
| Alt+N | new patient form |
| F3 | focus referrer |
| Alt+D | quick-add doctor |
| F4 | focus test search |
| Del | remove focused item |
| U | toggle urgent on focused item |
| Alt+R | urgent for whole order |
| Alt+O / Alt+I | OPD / IPD |
| Alt+C | toggle cash/credit |
| F6 | discount dialog |
| Alt+A | request approval |
| F8 | focus payment amount |
| Alt+P | add payment method row |
| Alt+U | TRF upload |
| Ctrl+Enter | register & print |
| Ctrl+Shift+N | new registration (after success, or discard with confirm) |
| Alt+L | retry label print |
| Esc | close dialog / clear search |
| ? | shortcut help |

### 3.6 Pay by QR dialog (Phase 1.5)
Gateway select (eSewa / Khalti; Fonepay disabled with tooltip "Not available yet" while B8 open) → B12 → shows the payment action (`action.kind = redirect` → `QrCode` of the URL; `qr` → `QrCode` of `qrPayload`; `form_post` → `QrCode` of `action.launchUrl` plus an "Open on this PC" button that opens `launchUrl` in a new window — 08 A19 D-113, CR-C15-016; C4 never builds or posts `fields` itself; a `form_post` without `launchUrl` is not rendered and the dialog shows "Payment could not be started. Cancel and try again." [CONV] — 03-IC §4.9 `IntentAction`) + amount + expiry countdown; polls B7 every 3 s; "Check now" (B13; `general` rate tier). On balance 0: "Payment received" (driven only by the server ledger — REQ-SEC-059). Close keeps the intent; reopening shows the open intent (one per order — 04 P6). "Cancel payment" (08 A19 D-113): a reason `Select` filled from C15 P24b `listPaymentCancelReasons`, then C15 P5 `cancelPaymentIntent` `{reason_code}` — both called through the staff BFF with `payments.intent.create` (held by `front_desk`); there is no C4 cancel endpoint; C15's error text is shown in the dialog. B12 errors `payments.amount_not_supported` and `payments.return_url_not_allowed` show C15's error text in the dialog banner.

### 3.7 Keyboard-only acceptance script (US-FD-03 AC6)
Returning patient, 3 items, cash: `F2` type mobile → `Enter` (select) → `F4` "CBC" `Enter` → "LIPID" `Enter` → "TSH" `Enter` → `F8` (amount prefilled = Net) → `Ctrl+Enter` → print dialog `Enter`. = 9 groups ≤ 12.

## 4. Order page — `/frontdesk/orders/{order_id}` (route `staff.frontdesk.order`)
Header: registration no, status badge (text), patient (code, name, sex/age), centre, visit type, billing mode, referrer, registered date (tenant calendar), flags chips.
Tabs:
| Tab | Content | Actions (permission) |
|---|---|---|
| Items | table: code, name, priority, status, price | Add tests (`frontdesk.order.edit`) → mini quote from F8b `quoteOrderItemsChange` over the added tests + optional payment → F13 with that `quote_fingerprint`; Remove (reason dialog; disabled with tooltip when `removable = false`) |
| Billing | from B7: invoices (no, date B.S./A.D., net, status, print count), credit notes, ledger entries (kind, method, amount, by, time, receipt no), refund requests (status), balance, eligibility basis, open finance tasks | Record payment (`billing.payment.record`, dialog = §3.2 F), Print/Print copy, Print receipt |
| Attachments | TRF list with scan states | Upload (`frontdesk.trf.upload`), preview (F21a) |
(No History tab: no operation serves combined frontdesk/billing history and `audit.*` is not C4's — review C4 #26.)
Cancel order: button (`frontdesk.order.cancel`) → `ConfirmDialog` (with reason select) (`order_cancel_reasons`) → if paid > 0 show "Finance must issue a credit note and refund NPR x".
Pre-registered orders: banner "Booked — confirm on arrival" + "Confirm & bill" (F12, runs the payment panel).

## 5. Patient page — `/frontdesk/patients/{patient_id}`
Demographics card (edit with If-Match; conflict → "Updated by someone else — reload"), consents (history table: date, version, flags; "Update consent" dialog), visits table (registration no, date, centre, status), Anonymise (`tenant_admin`, aal2; the page opens for it because `frontdesk.patient.read` includes `tenant_admin` — 08 A13 D-28) with retention info text.

## 6. Front-desk worklist — `/frontdesk/worklist`
Tabs: "Recollection needed" (flag rows: registration no, patient, specimen type code, rejection reason code display, created; actions: Call notes, Resolve with `flag_resolutions`), "Booking cancelled after registration", "Pre-registered today" (slot time, patient, source), "Possible duplicates created today" (F26 `listPossibleDuplicatePatients`; shown only with `frontdesk.registration.create`). `DataTable` keyboard: ↑/↓ rows, Enter opens order, `R` resolve.

## 7. Discount approvals inbox — `/frontdesk/discount-approvals`
Columns: Requested (relative time + expiry countdown), Centre, Requested by, Patient code, Gross, Discount (amount + %), Reason, Status. Row detail drawer: line list with discounts. Keys: `A` approve (confirm), `R` reject (note required). 403 `auth.mfa_required` → banner "Approving discounts requires MFA — complete MFA in your profile" (link per C2 route).

## 8. Billing screens

### 8.1 Invoices list — `/billing/invoices`
Filters: FY (B.S.), date range (`DatePicker` with `DateText mode="AD_BS"`), centre, status, invoice no (exact), credit party. Columns: Invoice no, B.S. date, A.D. date, Buyer, Net, Status (Issued/Cancelled text badge), Prints, CBMS. Sort: issued desc / invoice no.

### 8.2 Invoice detail — `/billing/invoices/{invoice_id}` (route `staff.billing.invoice`)
Shows the fiscal layout (same as print) + side panel: print history (B37: print no, original/copy, by, time, reason), credit notes, CBMS submissions (B2 `cbms_submissions[]`: document, attempt, outcome, time). Actions: Print (B3; reason select when count ≥1), Cancel (B4, finance; `ConfirmDialog` (with reason select) + summary "A credit note for NPR x will be issued"), Partial credit (B5; line picker with amounts), Request refund (B10; shows refundable amount; text "A second finance user must approve"). Cancelled invoices show a red-outlined **text** banner "CANCELLED on <B.S.> / <A.D.> — <reason> — Credit note <CN no>".

### 8.3 Print templates (invoice, credit note, receipt)
Rendered in `PrintFrame` from the print payload; A4 portrait and 80 mm thermal variants [CONV] selected per workstation in local UI preference (no PHI).
Invoice content order: branding block (legal name, address lines, phones, logo — `TenantSettings.branding`, 08 §4.12), "TAX INVOICE" (or "ABBREVIATED TAX INVOICE"), seller PAN, invoice no, invoice date B.S. + A.D. and time, FY, buyer name, buyer PAN (if any), registration no, referrer ("Referred by: Self" when none), lines (S.N., code, description, rate, discount, amount), totals (gross, discount, exempt, taxable, VAT 13%, other tax with code, net, amount in words), payment block (paid, due — labelled "Payment summary (not part of the invoice)"), copy mark "Copy of Original / प्रतिलिपि — Print no. n" when n ≥ 2, cancelled banner when applicable, printed by + time, footer note (tenant). Statutory field set per VAT Rules schedules is UNVERIFIED (04 L10, B6) → layout is data-driven so fields can be added without code change.
Credit note: "CREDIT NOTE", CN no, date, original invoice no/date, reason, lines, totals.
Receipt (non-fiscal): "PAYMENT RECEIPT", receipt no, date, order registration no, invoice no(s), method, amount, balance after.

### 8.4 Dues — `/billing/dues`
Columns: Registration no, Patient (masked), Centre, Invoiced, Paid, Credited, Due, Oldest invoice age. Action: open order billing tab.

### 8.5 Daily cash — `/billing/daily-cash` (route `staff.billing.daily_cash`)
Inputs: date (`DatePicker` with `DateText mode="AD_BS"`; default today), centre, staff. Table rows staff × method: entries, reversals, gross, reversed, net; totals row; sessions table (staff, centre, opened, closed, expected cash, counted cash, variance — negative variance shown with text "Short NPR x", positive "Excess NPR x"). Export (B28 `daily_cash`).
My shift (all cashiers, header widget): current session totals by method; "Close shift" dialog: counted amount per method (cash required, others optional), note, variance preview.

### 8.6 Credit parties — `/billing/credit-parties` and `/billing/credit-parties/{credit_party_id}` (route `staff.billing.credit_party`)
List: code, name, limit, used (outstanding), credit days, lock state. Detail tabs: Terms (edit — finance), Charges (month picker; uninvoiced/invoiced/voided), Bills (periodic invoices), Statement (months × invoiced/paid/credited/closing, with FY column), Payments (record party payment against a bill). "Generate monthly bill" (B21) with month select, issuing branch select (required) and preview total.

### 8.7 Registers — `/billing/registers`
Tabs: Sales register, Cancelled invoices, Credit notes. Filters: FY / date range / centre. Columns per TRD `SalesRegisterRow` (SN, B.S. date, A.D. date, invoice no, buyer, PAN, total, exempt, taxable, VAT, other tax, status); the Credit notes tab per TRD `CreditNoteRegisterRow` (SN, B.S. date, A.D. date, credit-note no, kind "Cancellation"/"Partial", invoice no, buyer, PAN, reason, exempt, taxable, VAT, other tax, net). Export buttons: Excel (disabled with tooltip until BL-T19 merges), XML, PDF. When the job is `ready`, "Download" streams B29a (no URL shown or copied).

### 8.8 Audit trail — `/billing/audit-trail`
Filters: user, action, date range. Columns: time (B.S./A.D.), user, action, document, document no, details summary. Export.

### 8.9 CBMS — `/billing/cbms`
Banner when mode stub: "CBMS connection is not configured. Documents are queued and will be sent once the connection is set up." Table: kind, no, date, state, attempts, last outcome; Retry for `failed_permanent` (settings permission).

### 8.10 Finance worklist — `/billing/worklist`
Tabs: Credit notes required (task rows → open invoice with lines preselected), Payments to review (home-collection / gateway overpayments → refund or keep as advance; home-collection payments on a method that is inactive for the lab, kind `home_payment_method_inactive`, label "Home-collection payment on an inactive payment method" [CONV] → resolve with `other` and a note, or refund — 08 A19 D-128), Refund approvals (B10c pending requests; Approve `A` → B10a / Reject `R` → B10b with note; own requests show "Needs another approver" and Approve is disabled — `billing.refund_self_approval_forbidden`).

### 8.11 Settings — `/frontdesk/settings`, `/billing/settings`
Front desk: discount self-limit (% and NPR), absolute max %, require referrer, consent text version, registration SMS, label auto-print, buyer PAN pattern, search min chars. Billing: invoice series scope (locked with explanation once the FY has invoices; "Branch" disabled with text "The invoice number pattern must contain {branch}" unless it does — 08 A13 D-23), prices include tax (with B7 warning text "Confirm with your auditor"), abbreviated invoices (with L9 warning), Pay by QR, receipt numbering (on/off; the pattern is a tenant numbering setting in C2), credit-days auto-lock, variance alert, refund alert. Tax rates are maintained in Catalog › Pricing › Tax (C3, `catalog.price_list.manage`); link only (08 R18).

## 9. Accessibility

WCAG 2.2 AA target (02-CV §14): labels for every input; errors linked via `aria-describedby`; `role="status"` live region for quote updates, approval status, payment status; focus returns to the trigger after dialogs; minimum target size 24×24 CSS px; contrast from tokens; status badges include text; tables have header cells and captions; print templates use real text (not images) so screen readers and copy work.

## 10. Responsive rules

Staff web targets desktop reception PCs: registration three-column ≥1280 px, two-column 1024–1279, single column <1024 with banner. Billing tables scroll horizontally inside `DataTable` below 1024 px; filters collapse into a Drawer. No mobile-specific flows in C4 (phlebotomy is C17).

## 11. In-app help and manual (04 L26 cl.6(ढ))

Each screen's `features/<m>/help/<screen>.md` (English) explains purpose, fields, shortcuts and, for billing, the IRD-related behaviour in neutral language ("Invoices cannot be edited or deleted. To correct an invoice, cancel it with a reason; a credit note is issued automatically."). User manual pages under `docs/manual/frontdesk/` and `docs/manual/billing/` mirror the help, plus `exports.md` (XML schema description), `cash-shift.md`, `credit-parties.md`, `cbms.md` (stub status explained). Nepali manual: B16-independent, added when translations are provided (02-CV §13 catalog keys make it possible).

Final sweep 2026-11-06 — second touch applied (§3.6 D-113 dialog; §8.7 B26 columns; §8.10 `home_payment_method_inactive`).
