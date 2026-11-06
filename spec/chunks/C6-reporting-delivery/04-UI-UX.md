# C6 Reporting & Delivery — 04 UI/UX

Status: DECISION, 2026-11-06. Components come only from `@lims/ui` (C0 04-UI-UX §2). Components the kit lacks are requested in CR-C6-010 and listed in §5. Message keys use `reporting.<screen>.<key>` (02-CV §13). English v1. All sample values are synthetic.

---

## 1. Global rules for C6 staff screens

- Shell, nav and help come from C0 (`PageShell`, `PageHeader` with a required `helpKey`, `HelpPanel`). Every page has `loading.tsx` / `error.tsx`.
- Tables: `DataTable` with cursor pagination, `density="compact"`, `caption` set, `stickyHeader`.
- Statuses: `StatusChip kind="report_version"` for version statuses (labels `ui.status.report_version.*`, plus `discarded` via CR-C6-005); `kind="generic"` for report display status and delivery status, with tone mapping: released/delivered/read = success; held/rendering/sent/queued = warning/info; render_failed/failed/quarantined/rejected = danger; suppressed/discarded/cancelled = neutral.
- PHI in UI: patient name and registration no. show only on worklist, detail and narrative screens to users with `reporting.report.read`. Delivery screens show masked destinations only. No PHI in page titles (the browser tab title is "Report — Synthetic Lab Alpha", not the patient name).
- Destructive or privileged actions use `ConfirmDialog` (with `requireReason` where the API needs a reason code).
- Polling (02-CV §2.4): worklist 30 s; scan/print job states 5 s for up to 2 min, then a manual Refresh.

### 1.1 Keyboard shortcuts (registered per page; no conflicts with C0 globals)

| Page | Keys | Action |
|---|---|---|
| Worklist | `Alt+1`…`Alt+6` | switch tab |
| Worklist | `/` | focus the registration no./barcode search (`BarcodeInput`, scanner accepted) |
| Worklist | `Alt+R` | bulk release selected (opens confirm) |
| Report detail | `Alt+R` | release latest version |
| Report detail | `Alt+P` | print (opens variant dialog) |
| Report detail | `Alt+D` | download PDF |
| Narrative editor | `Ctrl+S` | save draft |
| Narrative editor | `Ctrl+Enter` | sign (opens confirm) |
| Narrative editor | `Alt+I` | add image |

Shortcuts are disabled while an IME composition is active (C0 §4).

### 1.2 Barcode scanner

The worklist search and the outsourced queue search use `BarcodeInput` (`allowManual: true`). A scan calls `searchReports({barcode})`. One match opens the report detail. Several matches filter the table. No match shows inline "No report found for this barcode". The scanned value is never put in the URL (C0 §2.4 rule 6). Barcode search also needs `lab.specimen.read` (it resolves the barcode through `LabPort.lookupSpecimens`, 02-TRD R2); users without it see the label "Registration no." and a scan shows "Barcode search is not available for your role — enter the registration no." [CONV].

---

## 2. Staff screens

### 2.1 Reports worklist — `/reporting` (`staff.reporting.worklist`, CR-C6-011)

Layout: `PageHeader` (title "Reports", helpKey `reporting.worklist`) · `Tabs` · `FilterBar` · `DataTable` · sticky bulk bar when rows are selected.

| Region | Content |
|---|---|
| Tabs | Awaiting content · Ready to release · Held (dues) · Render failed · Released today · All (badges = counts from the first page's `page` meta is not available → badge omitted [CONV]) |
| FilterBar | Centre (`select`, own centres), Family (`select` laboratory/narrative), Registered (`date_range`, max 31 days), Review flag (`select` yes/no) |
| Search | `BarcodeInput` label "Registration no. or barcode" (pattern `^[A-Z0-9]{1,20}$`, maxLength 20) |

Columns:

| Column | Source | Notes |
|---|---|---|
| ☐ | selection | only in Ready to release / Held tabs; max 200 (`selection.max = bulk_release_max`) |
| Reg no. | `registration_no` | row header, mono |
| Patient | `patient_display_name` | text node only |
| Centre | `centre_code` | |
| Family | `family` | "Lab" / "Narrative" |
| Items | `items_ready/items_total` | e.g. "7/9" |
| Status | `display_status` | chip; Held shows "Held — NPR 500.00" using `MoneyText` |
| Version | `latest_version_no` | "v2 (amended)" |
| Registered | `registered_at` | `DateText withTime` |
| Updated | `updated_at` | `DateText withTime`; sort key `-updated_at` default |

Row actions menu: Open · Download · Print · Release. Enter on a row opens the detail.

Empty-state copy:
- Awaiting content: "Nothing is waiting for results."
- Ready to release: "No reports are ready to release."
- Held: "No reports are held for dues."
- Render failed: "No failed reports. Good."
- Released today: "No reports released today yet."

Bulk release confirm: title "Release {n} reports?", body "Reports with dues will stay held unless an override exists. Messages are sent to patients who agreed to them." Buttons "Release {n}" / "Cancel". The result `Dialog` shows a table (Reg no., Outcome, Reason) and the summary "{released} released · {held} held for dues · {other} not released".

### 2.2 Report detail — `/reporting/reports/{report_id}` (`staff.reporting.report`)

Layout (2 columns ≥ `xl`, stacked below):

| Region | Content |
|---|---|
| PageHeader | "Report · {reg no.}" (reg no. is P2 but permitted on this permissioned screen; the tab title stays generic), status chip, actions (Release, Print, Download, ⋯ menu: Retry render, Regenerate, Resend, Revoke QR, Portal links) |
| Header card (`DescriptionList` 3 cols) | Patient, Age/Sex, Centre, Referrer ("SELF" when none), Registered, Family, Billing hint ("Balance due NPR x" / "Paid" / "Credit party") |
| Items card | `DataTable`: Test(s), Kind (Lab/Narrative/Outsourced), Needs (chips), Ready (✓/pending text), Specimen hint ("Awaiting recollection" when rejected), link to narrative editor / outsourced upload |
| Versions card | `Timeline` newest first: "v2 Amended · Released 05/11/2026 10:35 AM · basis: Paid in full · 3 pages" with Download per version; superseded versions marked; discarded ones collapsed under "Show discarded" |
| Deliveries card | counts by status + link "Open delivery log filtered to this report" |
| Banners | held (warning) with "Record override" for `billing.release.override`; render failed (danger) with code and Retry; partial (info); review flag (danger) "The order was cancelled after this report was released." |

Release dialog fields:

| Field | Type | Rule | Default |
|---|---|---|---|
| Audiences | `Checkbox` group: Patient, Referring doctor, Collection centre, Partner | only computed audiences enabled; patient always checked and disabled unless "Print only" | computed set |
| Print only (no messages) | `Switch` | sets `suppress_notifications: true` | off |

Override dialog (C4 API): `CodedSelect` "Reason" (`override_reasons` from C4 `listBillingCodes`), `TextArea` "Note" (maxLength 500), `DateTimePicker` "Valid until" (optional). Submit "Record override". On success the release dialog reopens.

Print dialog: `RadioGroup` "Paper": "With letterhead" / "Plain paper (pre-printed letterhead)" (default from tenant `letterheadDefault`), `IntegerField` "Copies" min 1 max 5 default 1. Submit → "Preparing print…" spinner → opens the PDF in a new tab via a download (attachment) when ready. On an unreleased version the Print action is shown only to users holding both `reporting.report.print` and `reporting.report.release` (draft stamped "NOT RELEASED"; 08 A13 D-37).

Regenerate dialog: `ConfirmDialog` with `requireReason` codedSet `regeneration_reasons` (seed: `demographic_correction`, `referrer_correction`, `template_correction`, `smart_summary_added`, `other` — `centre_correction` removed, 08 A13 D-36) and free text ≤500 (required for `other`). Help text: "After a released version, the new version prints as AMENDED REPORT with this reason, except 'Smart summary added'." (08 A13 D-33).

Revoke QR / link: `ConfirmDialog tone="danger"`, reason codedSet `token_revoke_reasons` (seed: `issued_in_error`, `wrong_recipient`, `security_concern`, `other`). Copy: "Anyone who scans this report's QR code will see 'could not be verified'. This cannot be undone."

### 2.3 Outsourced queue — `/reporting/outsourced`

Columns: Reg no., Patient, Test(s), External lab, File state chip, Registered. Filter: state (Awaiting file / Awaiting confirmation / Confirmed), centre.

Upload dialog fields:

| Field | Component | Validation | Required |
|---|---|---|---|
| File | `FileUpload accept=['application/pdf'] maxBytes=15 MB` | one file | yes |
| External lab name | `TextField maxLength=120` | 1–120 chars | yes |

File card (`PdfFileCard`, CR-C6-010): filename, size, pages, state chip with copy:
- pending_scan / scanning: "Checking the file for viruses…"
- sanitizing: "Preparing the file…"
- ready: "Ready. Open it and confirm it belongs to this patient."
- quarantined: "This file was blocked by the virus scanner and has been isolated."
- rejected: "This PDF could not be used ({reason}: encrypted / damaged / too many pages / took too long)."
- confirmed: "Confirmed by {user} at {time}."

Confirm: `Checkbox` "I have checked that this report belongs to {patient display name}" (required) → "Confirm".

### 2.4 Narrative editor — `/reporting/narratives/{narrative_id}` (`staff.reporting.narrative`)

Layout: left = patient/order context (`DescriptionList`: patient, age/sex, test, referrer, clinical note from TRF is C4's — not shown [DECISION, no cross-module PHI fetch]); centre = editor; right = images.

| Field | Component | Validation |
|---|---|---|
| Template | `Select` from N8 (active, matching kind/test) | changing template on a non-empty draft asks "Replace section text with the template?" |
| Sections | `RichTextEditor` per section (CR-C6-010), heading label from the template | each ≤ 20,000 chars HTML; required sections marked "Required" |
| Images | `ImageThumbnailGrid` (CR-C6-010) + `FileUpload accept=['image/png','image/jpeg'] maxBytes=15 MB multiple maxFiles=12` | ≤ 12 images; caption `TextField maxLength=200` |

Footer: "Saved {time}" status, buttons "Save draft" (secondary), "Sign report" (primary, `reporting.narrative.sign` only). Sign confirm: "Sign and lock this report? After signing, changes need an amendment."

Signed view: rendered HTML (sanitised; rendered by React from the sanitiser's output with the kit's `SafeHtml` wrapper requested inside the RichTextEditor CR — no `dangerouslySetInnerHTML` in feature code, 02-CV §1.3), signature line "Signed by {name}, {title} on {date}", button "Start amendment" (reason codedSet `narrative_amend_reasons`, seed: `transcription_error`, `additional_findings`, `wrong_side_or_site`, `other`).

Narrative worklist columns: Reg no., Patient, Test, Kind, Status, Assigned (none in v1), Registered. Empty: "No narrative reports waiting."

### 2.5 Delivery log — `/reporting/deliveries`

Columns: Created, Channel, Purpose, Recipient (Patient / Doctor / Centre / Staff), To (masked), Status chip, Attempts, Report (link to detail). Filters: status, channel, purpose, date range (≤ 31 days). Drawer: `Timeline` of transitions and attempts, failure code with plain-language explanation table:

| failure_code | Shown text |
|---|---|
| `no_consent` | "Not sent: the patient has not agreed to this channel." |
| `no_contact` | "Not sent: no phone number or email on file." |
| `channel_disabled` | "Not sent: this channel is switched off for your lab." |
| `provider_rejected` | "The messaging provider rejected the message." |
| `invalid_destination` | "The number or address was not accepted." |
| `template_not_approved` | "The WhatsApp template is not approved yet." |
| `retries_exhausted` | "Sending failed after several tries." |
| `circuit_open` | "The provider is not responding; we will try again." |
| `superseded_attempt` | "Replaced by a newer attempt." |

Action "Resend" (failed only). Never shows message text, links, OTPs or full numbers. The drawer content is also the page `/reporting/deliveries/{delivery_id}` (route `staff.reporting.delivery`) for deep links, with a "Back to delivery log" link (review fix #31). Print rows show channel "Print" and recipient "Patient".

### 2.6 Report templates — `/reporting/templates/{template_id}`

Form sections (all fields map to `TemplateConfig`, 02-TRD §6.5):

| Section | Fields (component · range · default) |
|---|---|
| Page | Size `Select` A4/Letter (A4); margins top/bottom/left/right `IntegerField` mm (top 35, bottom 40, left 12, right 12 [CONV]) |
| Letterhead | Header image `Select` "Lab letterhead header" / "None"; Footer image same; Plain-paper reserve top/bottom `IntegerField` mm 0–80 (35/30 [CONV]); note "Images are uploaded in Admin → Letterhead & branding." (link to C2 if permitted) |
| Header fields | ordered checklist of the 11 header fields (all on by default, Metro order: Name, Age/Gender, Reg No, Barcode No, Sample Coll Dt, Sample Rcv Dt, Reg Date, Reported Date, Report Status, Referred By, Sample Collected At) |
| Results | Show METHOD line `Switch` (on); Show units column (on); Group by package (on); Page break before each department (off); Show "Approved by" per department (on) |
| Signatories | Mode `RadioGroup` "Approving pathologists" / "Nominated signatories"; Max `IntegerField` 1–4 (2); Show signature images (on); Registration label `TextField` maxLength 20 ("NMC No.") |
| QR | Enabled (on); Size `IntegerField` 15–35 mm (22); Caption `TextField` maxLength 60 ("Scan to verify") |
| Watermark | Text `TextField` maxLength 40 (empty = none); Opacity `DecimalField` 0.05–0.30, decimals 2 (0.08) |
| Disclaimers | up to 5 `TextField` maxLength 200 (seed lines below) |
| Contact strip extra | `TextArea` maxLength 300 |
| Fonts | Base size `IntegerField` 7–11 pt (9) |

Seed disclaimer lines (synthetic tenant defaults, editable):
1. "Authorized signatory nominated by Lab Director."
2. "This report is not subject to use for any medico-legal purpose."
3. "Results relate only to the sample received."

Buttons: "Preview with sample data", "Save draft", "Publish" (privileged confirm: "Publish this template? New reports will use it. Reports already made keep their layout.").

### 2.7 Messages & channels — `/reporting/messages`

Table: Template, Purpose, Channels, Status per channel (Active / Draft; WhatsApp approval status chip). Edit drawer: `Select` language (English / Nepali), `TextArea` body (maxLength 1000, counter), `TextField` subject (email, maxLength 150), placeholder chips "Insert {lab_name}" etc. (only declared params), WhatsApp fields: provider template name (maxLength 128), language code (maxLength 16), variable order (ordered chips), approval status `Select` with help "Approval is done in your WhatsApp Business account. Record the result here."

Channel accounts card: per channel provider `Select` (production hides "Recording"), sender id `TextField` (maxLength 64), secret reference `TextField` (pattern `^[a-z0-9_./-]{1,128}$`, help "Name of the secret your operator stored. The secret itself is never entered here."), Active `Switch`, "Generate callback URL" (shown once in a copy dialog: "Copy this URL into the provider's settings. It will not be shown again.").

### 2.8 Reporting settings — `/reporting/settings`

Fields from 02-TRD §10.2 with the listed components: `RadioGroup` (auto release, narrative mode), ordered chips (patient channel order), `Switch` (email, referrer, centre delivery, critical alert, print critical label), `IntegerField` (fallback minutes 5–240, bulk max 1–200, reissue 0–5), `Combobox` membership pickers for nominated signatories (≤4) and critical-alert recipients (≤20), `Checkbox` group "Online payment on the patient portal" (eSewa, Khalti; default none; help "Turn on only after online payments are live for your lab." — 08 A11.1), `Switch` "Send a payment link when a report is held for dues" (`dues_link_enabled`, on — 08 A21.1). Centre contacts sub-table (Centre, Channel, Address masked, Label, Active).

### 2.9 Critical alerts panel — on the worklist `/reporting` (review fix #16)

| Element | Content |
|---|---|
| Placement | collapsible `Card` above the worklist tabs, title "Critical alerts", `Badge` with the count for the last 24 h (from the first page; "50+" when a next page exists [CONV]) |
| Data | R18 `listCriticalAlerts` (centre filter follows the worklist's Centre filter), polled every 30 s |
| Rows | Reg no. (mono; "—" when no report exists yet), Alerted (`DateText withTime`), Recipients: chips "Doctor — Queued/Sent/Delivered/Failed/Not sent", "Staff — Not sent (call)" for Phase-1 suppressed staff rows; link "Open report" when `report_id` is present |
| Never shown | the value, the analyte or the patient name (the event has no value; 04 L21 call log stays in C5) |
| Empty | "No critical alerts in the last 24 hours." |
| Error | inline `ErrorState` inside the card with Retry; the worklist below keeps working |
| Permission | visible with `reporting.report.read`; rows are centre-scoped by RLS |

---

## 3. Report PDF layout specification (`lab-report` template; reproduces 00 §4)

### 3.1 Page regions (A4 portrait, mm)

```
┌──────────────────────────────────────────────────────────┐
│ LETTERHEAD HEADER image (logo, brand, badges) — top margin │  ← omitted on plain variant; space reserved
├──────────────────────────────────────────────────────────┤
│ Sample Collected At: C000000099-SYNTHETIC CENTRE NINETY-NINE│
│ (centre address line)                                      │
│ ┌ PATIENT BLOCK (repeated on every page) ───────────────┐ │
│ │ Name        : Test Patient 0042  Reg No   : 0001SY000001│ │
│ │ Age/Gender  : 43 Years/MALE      Barcode No: E2600000042│ │
│ │ Sample Coll Dt: 05/11/2026 08:10 AM  Reg Date: 05/11/2026 08:02 AM│
│ │ Sample Rcv Dt : 05/11/2026 08:40 AM  Reported Date: 05/11/2026 10:30 AM│
│ │ Report Status : Final            Referred By: SELF      │ │
│ └───────────────────────────────────────────────────────┘ │
│ Tests                 | Results      | Biological Ref Range | Units │  ← column header repeated per page
│ SYNTHETIC HEALTH PACKAGE (BASIC) (MALE)          ← package heading │
│ HAEMATOLOGY                                       ← department     │
│ CBC (Synthetic panel)                             ← panel heading  │
│  RBC parameters                                   ← sub-heading    │
│  Haemoglobin           High  17.9   13.0 - 17.0   g/dL             │
│   METHOD : Synthetic Photometric Method                            │
│  ...                                                               │
│ Specimen: EDTA WHOLE BLOOD                         ← panel end      │
│ Approved by: Dr. Synthetic Signatory A                             │
├──────────────────────────────────────────────────────────┤
│ FOOTER (every page): [sig A img] [sig B img]          [QR 22mm] │
│ Dr. Synthetic Signatory A        Dr. Synthetic Signatory B       │
│ MD Pathology, NMC No. NMC-SYN-0001  Consultant Pathologist, NMC No. NMC-SYN-0002│
│ disclaimer lines (≤5, 7 pt)                        Page 1 Of 3  │  ← stamped by sandbox
│ contact strip: email · phones · website · address              │
│ LETTERHEAD FOOTER image                                         │
└──────────────────────────────────────────────────────────┘
       watermark text diagonal, centred, opacity per template
```

### 3.2 Element rules

| Element | Rule |
|---|---|
| Fonts | Latin: bundled Noto Sans; Devanagari: Noto Sans Devanagari (fallback chain in CSS family list); numbers in results use tabular figures if the font provides them (not required) |
| Base size | template `fonts.base_pt` (default 9 pt); headings: package 10 pt bold uppercase; department 10 pt bold; panel 9.5 pt bold; sub-heading 9 pt italic |
| Columns | Tests 44 %, Results 18 %, Biological Ref Range 26 %, Units 12 % [CONV]; long ref range text wraps inside its column |
| Flag | tag text ("High", "Low", "Abnormal", "Critical High") in the Results cell **left of the value**; value bold when flagged; never colour-only |
| METHOD line | under the analyte name, 7.5 pt, "METHOD : {name}" exactly |
| Specimen line | at panel end, "Specimen: {label}" |
| Comments | below the analyte or panel, 8 pt, plain text |
| Page breaks | never inside an analyte line + its METHOD line; a panel heading never ends a page (CSS `break-after: avoid`); department page break per template |
| Amended report | a box at the top of page 1: "AMENDED REPORT — replaces version {n} issued {date}." followed by one line per change "{analyte}: {reason display}" |
| Addendum (08 R1) | box at the top of page 1: "ADDENDUM — supplementary report to version {n} issued {date}. The original findings are not changed."; header "Report Status" = "Addendum" |
| Partial report | box: "PARTIAL REPORT — results for {k} test(s) are still pending." |
| Preliminary (Phase 2) | box: "PRELIMINARY REPORT — final results will follow." Also for an updated preliminary that replaces an approved preliminary (C5 reason `module_preliminary_update`, 08 A17 D-61): same box and header "Report Status" = "Preliminary"; no "AMENDED REPORT" box (02-TRD §4.5 rules 1 and 3) |
| Narrative section | heading = test name; subsections with template headings; images in a grid (1–3 columns), caption under each, max height 80 mm; "Signed by" line |
| Outsourced index | section "Tests performed by external laboratories": test name — lab name — "attached report follows"; external pages appended after our pages |
| QR | encodes `{LIMS_ORIGIN_PORTAL}/v/{token}`; error-correction level M [CONV]; caption below |
| Signature images | max 30 × 12 mm, aspect preserved; absent image → blank space of the same height |
| Watermark | `position: fixed` centred, rotated −30°, 48 pt, opacity per template (confirmed per page by spike C6-T05) |
| Plain variant | header/footer images omitted, reserved margins kept, everything else identical |
| Draft print | "NOT RELEASED" stamped diagonally by the sandbox on every page |
| Dates | per `calendarDisplay` (02-CV §13): `AD` → `DD/MM/YYYY hh:mm A`; `AD_BS` → `DD/MM/YYYY hh:mm A (YYYY-MM-DD B.S.)`; `BS` → `YYYY-MM-DD B.S. hh:mm A`; `BS_AD` → `YYYY-MM-DD B.S. hh:mm A (DD/MM/YYYY)` [CONV] (review fix #32; golden test per mode) |
| Age/Gender | "{years} Years/{SEX}" ("{months} Months" when < 1 year, "{days} Days" when < 1 month) — sex upper case: MALE/FEMALE/OTHER/UNKNOWN |

### 3.3 Narrative report template (`narrative-report`)

Same header/footer. Body: title "{KIND} REPORT" (e.g. "ULTRASONOGRAPHY REPORT"), the test name, then the sections and images. Signatory in the footer = the narrative signer.

---

## 4. Portal UX (`apps/portal`) — phone first

Layout: single column, max width 560 px, `font.size.md`, 44 px touch targets (C0 §1.5). Header: lab display name (text; no logo image in v1 to avoid image fetches, [CONV]). Footer: "Your data stays on servers in Nepal." and a link to the lab contact phone (from branding).

| Page | Content and copy |
|---|---|
| Landing `/r/{token}` | Title "View your lab report". Body "For your security we will send a 6-digit code to the phone number or email the lab has for you." Button "Send me a code". |
| Code `/r/{token}/code` | "Code sent to the mobile number registered with the lab. It expires in 10 minutes." (08 A13 D-31; e-mail channel: "Code sent to the email address registered with the lab…" [CONV]; no masked destination) `OtpInput` (CR-C6-010) label "6-digit code". Button "View report". Link "Send a new code" (disabled 60 s [CONV]). Errors: "That code is not right. You have {n} tries left." / "This code can no longer be used. Send a new code." |
| Report `/r/{token}/report` | `Card`: lab name, "Report for {patient_display}", Status "Final" / "Amended" / "Addendum" / "Partial" / "Preliminary" (unknown future kinds display as "Amended", 08 R13), "Issued {date}", list of panel names. Banner (if updated): "This report was updated on {date}. You are seeing the latest version." Button "Download PDF". Link "Sign out". Below the card: "Health summary" section (08 Addendum A4.7; see §4.1). |
| Invalid link | "This link is not valid. It may have expired or been replaced." Button "Request a new link" → "If this link was sent to you, a new one will arrive by the same method shortly." (always identical, whatever the API answered) |
| Dues page `/r/{token}/dues` (08 A21.1; dues links only) | Title "Payment due". `Card` "Amount due: NPR {amount}" and "Your report will be sent once payment is complete." Pay buttons exactly as the report-page dues card below (none before online payments are live → "Please pay at the lab counter or in the app."). No report status, panel names or Download. Balance 0 → "Payment received — your report will be sent once it is released." |
| Report page — dues (08 A11.1; ships with C15) | Shown only for patient links with an amount due: `Card` "Amount due: NPR {amount}" (`MoneyText`) and note "The exact amount is confirmed when you pay." Gateways configured → one button per gateway "Pay with eSewa" / "Pay with Khalti" (plain form POST, works without JavaScript). None configured (default, and always before online payments are live) → text "Please pay at the lab counter or in the app." and no button. Open request → "A payment is in progress." + link "See payment status". |
| Payment status `/r/{token}/payments/{id}` | queued: "Preparing your payment…" (page refreshes itself every 2 s); ready: button-styled link "Continue to eSewa" / "Continue to Khalti"; review: "We are confirming your payment. This can take a few minutes."; failed, not available: "Online payment is not available right now. Please pay at the lab counter or in the app."; failed, nothing due: "Nothing is due on this report."; in progress elsewhere: "A payment for this order is already in progress." |
| Payment return `/r/payments/{id}/done` | completed: success `Banner` "Payment received. Thank you." + link "Back to your report"; checking: "Checking your payment…" (refresh every 3 s up to 60 s), then "We have not received confirmation yet. If you paid, it will show at the lab shortly."; expired/failed: "The payment was not completed." + "Back to your report"; no session: "Open your report link again to see your payment status." (no data). The gateway's `outcome` value is never displayed or trusted. |
| App fallbacks | `/app/reports/{report_id}`: "Open the link the lab sent you to view this report." (no data — `portal.report_link_required`, review fix #31); other `/app/*` and `/phlebo/*`: "Open the app to continue." (no data — `portal.app_fallback`, 08 A13 D-38) |
| Rate limited | "Too many attempts. Please try again in {minutes} minutes." |
| QR valid `/v/{token}` | Green success `Banner` "This report is genuine." `DescriptionList`: Laboratory, Patient ({initials}), Tests, Issued, Version. |
| QR superseded | Amber banner "This report was replaced by a newer version." Same fields. Text "Ask the laboratory for the current report." |
| QR not found | Neutral banner "We couldn't verify this report." Text "Check that you scanned the QR code on the report, or contact the laboratory." |
| Generic error | "Something went wrong. Please try again later." with reference id |

### 4.1 Portal "Health summary" section (08 Addendum A4.7)

- **Source:** the version snapshot only — P3 `smart_summary` (= `report_versions.smart_summary_json`, 08 A2.3/A4.4). The portal never calls `SmartReportPort` and never reads `smartreport.*`.
- **Hidden** when `smart_summary_json` is NULL: no heading, no placeholder (08 A4.7). C14's optional "not available yet" copy (C14 04-UI-UX §5) is not used on the portal.
- **Read-only:** server-rendered text, no form controls; no prices, booking buttons, promotions or links next to follow-ups or advice (C14 04-UI-UX §5 "Must not").
- **Content and order:** C14's display contract (C14 04-UI-UX §5 "Must show", in the order of C14 04-UI-UX §4.2): section heading "Health summary" (08 A4.7), notice, score with "(not a diagnosis)" when present, tiles with text status words, findings, trends (text table; no chart in v1 [CONV — portal has no client JS dependency]), advice, follow-ups with test name and interval, disclaimer, approval line. Status words, direction words, trend words, band words and headings: C14 04-UI-UX §4.3 fixed copy.
- **Disclaimer text (same as the printed summary, 08 A4.7):** the fixed notice is C14 04-UI-UX §4.3 key "N1 notice", verbatim; the disclaimer paragraph is the snapshot's tenant `disclaimerText` (C14 04-UI-UX §4.2 row 9). Both always shown when the section is shown. The N1 wording is not restated here: C14 04-UI-UX §4.3 is its single source (changes there apply to the portal unchanged); `disclaimerText` comes from the snapshot.
- **Error state:** snapshot present but not renderable (03-APP-FLOW §3.7 step 4) → section heading "Health summary" with text "Your health summary cannot be shown right now. Your full report is available to download above." [CONV]; the rest of the page is unaffected.
- **Language:** `lang="ne"` on Devanagari block text (snapshot `language`), as C14 04-UI-UX §4.1.

Accessibility: WCAG 2.2 AA; works at 320 px without horizontal scroll; focus moves to the error message on failure; OTP input announces remaining tries; no time limit except OTP/session (announced in text).

---

## 5. Components

Used from `@lims/ui`: `PageShell`, `PageHeader`, `Tabs`, `FilterBar`, `DataTable`, `StatusChip`, `MoneyText`, `DateText`, `IdText`, `DescriptionList`, `Timeline`, `Card`, `Banner`, `Dialog`, `ConfirmDialog`, `Drawer`, `Form`, `TextField`, `TextArea`, `IntegerField`, `DecimalField`, `Select`, `CodedSelect`, `Combobox`, `Checkbox`, `RadioGroup`, `Switch`, `FileUpload`, `BarcodeInput`, `Button`, `IconButton`, `Menu`, `EmptyState`, `ErrorState`, `LoadingSkeleton`, `useToast`, `Spinner`, `Badge`, `Tooltip`.

Requested (CR-C6-010; ACCEPTED-MODIFIED in 08 — `OtpInput` is the one kit component also used by C2; `RichTextEditor`, `ImageThumbnailGrid`, `PdfFileCard` accepted; 08 R22, §4.6). Kit message key `ui.status.report_version.discarded` "Discarded" (CR-C6-005).

```ts
interface RichTextEditorProps extends FieldBase { value?: string /* sanitised HTML */; onChange?: (html: string) => void;
  maxLength: number /* text content chars */; allowed: readonly ('bold'|'italic'|'underline'|'bullet_list'|'ordered_list'|'table'|'h3'|'h4')[] }
interface SafeHtmlProps { html: string /* already server-sanitised; kit re-sanitises with the same allowlist */ }
interface OtpInputProps { label: string; length: 6; value?: string; onChange?: (v: string) => void; onComplete?: (v: string) => void; error?: string; isDisabled?: boolean }
interface ImageThumbnailGridProps { items: readonly { id: string; src: string /* BFF URL */; caption?: string; state: 'scanning'|'ready'|'rejected' }[];
  onCaptionChange?: (id: string, caption: string) => void; onRemove?: (id: string) => void; onReorder?: (ids: readonly string[]) => void; captionMaxLength: number; max: number }
interface PdfFileCardProps { filename: string; sizeBytes: number; pageCount?: number; state: string; stateLabel: string; tone: Tone; onDownload?: () => void }
```

---

## 6. Operator / developer experience

- **Renderer**: `pnpm --filter @lims/renderer dev` starts the renderer and the sandbox with the local font set; `pnpm --filter @lims/renderer render:sample` writes `out/sample.pdf` from `preview-sample.ts` (synthetic). Health `GET /internal/health` → `{status, browser_pid, contexts_busy, renders_since_recycle}`.
- **Runbooks** (`docs/manual/reporting/runbooks.md`): renderer stuck/out of memory (restart container; versions resume via sweep); sandbox rejections spike (check corpus, scanner); provider outage (circuit open → SMS fallback; manual resend after recovery); WhatsApp template rejected by Meta (switch channel order to SMS first in settings); rotate a callback token; revoke links in bulk after a mis-send (filter by delivery batch, revoke each — bulk revoke is a foreseen CR); restore a missing PDF (versions are immutable; re-render is **not** allowed for released versions; restore from the storage backup, I4).
- **Logs**: search by `report_id`/`delivery_id`/`request_id`; never by phone or name (not logged).

## 7. Message template wording (deliverable; global defaults in `reporting.g_message_templates`)

Placeholders `{name}` are declared params (02-TRD §7.2). The WhatsApp texts are the content to submit for Meta **utility** template approval. The exact variable syntax and button configuration are set in the provider console and recorded in `provider_variable_order` (Meta syntax UNVERIFIED in 04; approval is external, B9). No template contains PHI (04 R4–R6; REQ-SEC-070).

| Code | Purpose | Channels | Params | English default text |
|---|---|---|---|---|
| `reporting.report_ready` | report_ready | whatsapp, sms, email | lab_name, url | WhatsApp/SMS: "{lab_name}: your lab report is ready. Open {url} and enter the code we send you to view it." Email subject: "Your report from {lab_name} is ready"; body: "Your lab report is ready. Open the secure link below and enter the code we send you to view it.\n{url}\nThe link expires after some time. If it has expired, open it and ask for a new one." |
| `reporting.report_updated` | report_ready | whatsapp, sms, email | lab_name, url | "{lab_name}: an updated version of your lab report is ready. Open {url} and enter the code we send you to view it." |
| `reporting.report_ready_referrer` | report_ready | sms, whatsapp, email | lab_name, url | "{lab_name}: a report for your patient is ready. Open {url} and enter the code we send you." |
| `reporting.report_ready_centre` | report_ready | sms, whatsapp, email | lab_name, url | "{lab_name}: a report for your centre is ready. Open {url} and enter the code we send you." |
| `reporting.portal_otp` | otp | sms, email | otp_code, lab_name, minutes | "{otp_code} is your {lab_name} report code. It expires in {minutes} minutes. Do not share it." Email subject "Your {lab_name} report code" (the e-mail call passes `linkUrl = LIMS_ORIGIN_PORTAL`, which this template ignores — review fix #29) |
| `reporting.link_reissued` | report_ready | sms, whatsapp, email | lab_name, url | "{lab_name}: here is a new link to your lab report: {url}" |
| `reporting.critical_value_alert` | critical_value_alert | sms, whatsapp | lab_name, lab_phone, short_text (ref) | "{lab_name}: critical result for your patient. Please call {lab_phone} now. Ref {ref}." (`ref` = first 8 chars of the critical_event_id, not PHI). No `url` param: no value and no link (08 A13 D-35 — no released report may exist yet). This text is the one AC-14.1 quotes |
| `frontdesk.registration_confirmation` (CR-C4-011) | registration_confirmation | sms | lab_name, registered_time_hhmm | "{lab_name}: your registration at {registered_time_hhmm} is complete. We will message you when your report is ready." |
| `frontdesk.recollection_request` (CR-C4-011) | recollection_request | sms | lab_name, centre_phone (`phone`) | "{lab_name}: we need a new sample from you. Please call {centre_phone}." |
| `engagement.login_otp` (CR-C16-009) | otp | sms | otp_code, lab_name, minutes | "{lab_name}: your code is {otp_code}. It expires in {minutes} minutes. Do not share it." |
| `engagement.booking_confirmation` (CR-C16-009) | booking_confirmation | sms | lab_name, datetime, short_text (booking_no) | "{lab_name}: booking {booking_no} confirmed for {datetime}." |
| `engagement.booking_cancelled` (CR-C16-009; purpose per 08 R13) | booking_cancelled | sms | lab_name, datetime, short_text (booking_no) | "{lab_name}: booking {booking_no} for {datetime} is cancelled." |
| `engagement.booking_reminder` (CR-C16-009; purpose per 08 R13) | booking_reminder | sms | lab_name, datetime, short_text (booking_no) | "{lab_name}: reminder of your booking {booking_no} at {datetime}." |
| `engagement.follow_up_reminder` (CR-C16-009) | follow_up_reminder | sms | lab_name, datetime | "{lab_name}: it is time for your follow-up test by {datetime}. Visit or book in the app." |
| `analytics.report_ready` (CR-C8-007; code per 08 Addendum A2.6, renamed from `analytics_report_ready`) | scheduled_report_ready | email (staff only) | lab_name, label_text (schedule_name; 08 A4.3), staff_url (url; 08 A13 D-29 — a staff-web route link, e.g. `staff.analytics.report_run`) | Subject "{lab_name}: scheduled report ready"; body "Your scheduled report {schedule_name} is ready. Sign in to view it: {url}" |
| `reporting.dues_due` (08 A21.1) | dues_reminder | sms, whatsapp | short_text (lab_name), short_text (amount_text), url | "{lab_name}: {amount_text} is due for your lab order. Your report will be sent after payment. Pay or see details: {url}" [CONV wording]. No test, result or patient name; `url` param added to A21.1's list so the dues link reaches the patient [CONV] |
| `homecollection.visit_assigned` (08 A13 D-34; C17) | visit_assignment | sms | short_text (route_date), short_text (visit_count) | "You have {visit_count} home-collection visit(s) on {route_date}. Open the phlebotomy app for details." [CONV wording]. Staff recipients stay `suppressed_no_contact` in Phase 1 |
| `homecollection.visit_scheduled` (CR-C17-014, 08 A19 D-129; C17) | booking_confirmation | sms | short_text (window_start_local), short_text (window_end_local) | "Your home sample collection is scheduled between {window_start_local} and {window_end_local}." [CONV wording]. Patient recipient; no lab-name parameter (D-129); no test, result or patient name |

Resolved by 08 Addendum A2.6 (2026-11-06): the code is `analytics.report_ready` (passes `g_message_templates__code__ck`); `schedule_name` uses param kind `label_text` (≤ 80 characters, plain text, no URLs — `://` or `www.` rejected — HTML-escaped; 08 Addendum A4.3, 02-TRD §7.2 step 3); `short_text` keeps its original definition (≤ 40, `^[A-Za-z0-9 .,:/()-]*$`; `ref`, `booking_no`). For purpose `scheduled_report_ready` only, C6 resolves the staff recipient's e-mail through `IdentityPort.getStaffNotificationContact({membershipId, requiredPermission})`, where `requiredPermission` is the permission the scheduled report itself requires (08 A4.2); the Phase-1 staff suppression does not apply (02-TRD §7.2 step 5).

Nepali (`ne`) texts are entered by each tenant and reviewed by the client; C6 ships none [DECISION — no unreviewed translations]. SMS bodies with Devanagari are sent as Unicode (04 R6).
