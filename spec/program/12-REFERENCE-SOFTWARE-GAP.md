# 12 — Reference-software gap review (ElabAssist + SLIMS Medicore)

Status: PROPOSAL for lead ruling, 2026-11-13. Nothing in this file changes a chunk spec. Each gap becomes a change request (CR) only after a lead decision (LD), and the owning chunk's lead files it in `08-CR-REGISTER.md`.

## 0. Sources and how far to trust this review

| Source | What it is | Captured |
|---|---|---|
| ElabAssist (corpmain.elabassist.com) | The outsourced software Metro Labs uses today. Read-only UI documentation, structure only. | 10 Nov 2026 |
| SLIMS (Medicore Diagnostics Centre, Kathmandu) | A second Nepal lab system. Read-only screen documentation, structure only. | 13 Nov 2026 |

Both documents were captured without clicking Save, Print, Send or Download, so **row-level behaviour, status chains behind buttons and desktop-width layouts were not seen**. Anything below that depends on those is marked "not seen".

Method: for every screen in both documents I searched the PRD, TRD, app-flow, UI/UX and schema files of all 19 chunks and the interface catalogue for the feature's terms (several spellings each). Meaning of the verdicts:

- **Covered** — a section of our spec describes the feature; the reference is quoted. A hit shows the topic exists, not that it is as rich as the reference.
- **Partial** — part of it exists; the missing part is named.
- **Absent** — none of the search terms appear anywhere in the spec. Absence can mean "forgotten" or "decided against" — section 3 lists the decided ones.
- **Not applicable** — India-only or otherwise outside a Nepal lab.

This is a term search plus reading of the matching lines, not a line-by-line audit of 19 chunks. Each chunk lead must confirm its own rows before a CR is filed.

## 1. Covered (verified)

| Reference feature | Where in our spec |
|---|---|
| Search by name / mobile / patient code (ElabAssist header search, Search screen) | C4 S2 (body search, no PHI in the URL, minimum 3 characters, D-PATIENT-SCOPE) |
| Accession, receive, reject, re-collect (EA 3, 21; SLIMS 6.2–6.5) | C5 S4 receive, S12 recollection; rejection reasons haemolysed / clotted / quantity not sufficient / mislabelled (C5 05-SCHEMA) |
| Dispatch of specimens to a processing lab (EA 5 Inter Lab Transfer, in part) | C5: `centre_staff` dispatch to the processing centre; receive checks the processing centre |
| Outsourced results (EA 4; SLIMS 6.17) — result side only | C6 IS-05 outsourced-PDF intake (upload, malware scan, qpdf sanitise, staff confirmation, merge); `workflow_type = outsourced` in C3 |
| Two-step authorisation: technician then pathologist (EA test-level status; SLIMS Level 1 / Sec Authorised) | C5 two-step approval (00 C5); only the pathologist changes a result after approval (00 C6) |
| Hold report until paid (EA "Allow printing without approve"; SLIMS "Block report print when due") | C2 tenant setting "Hold reports until paid"; C6 release rule `due_outstanding` (AC-06.1) |
| Discount reason, authority, limit (EA 9.28–9.30) | C4 03-APP-FLOW (discount authority step): within limit passes, above limit needs `discount_approval_id` |
| Quotation (EA 20) | C4 (49 mentions; quote fingerprint on registration) |
| Refund, cancel, reversal (EA 10.2; SLIMS 5.3) | C4: credit notes, `payment_reversed`, refund requested/approved by a second person |
| Change payment mode (SLIMS 5.5) | C4 payment reversal then re-record (B9). No in-place edit — deliberate, IRD immutability |
| Bill reprint / copy of original (SLIMS 5.4) | C4 S15: "Copy of Original" / प्रतिलिपि with print count |
| Daily cash report, shift close (EA 18.11; SLIMS 7.1) | C4 S19, US-BL-11 (counted vs expected, variance recorded) |
| Credit party monthly billing, statement, credit lock (EA 18.5–18.8, 10.2) | C4 S18; `billing.credit_party_locked` / `credit_limit_exceeded` |
| Price lists per client / doctor / centre (EA 10.1, 10.3; SLIMS price scheme) | C3 price lists with assignments (`price_list_assignments`) |
| Test master, parameters, units, methods, formulas, reference ranges, critical limits (EA 11.1–11.6; SLIMS 3.1–3.5) | C3 (IS-02 … IS-07; calculated parameters are formulas in master data) |
| Container colour, specimen master (SLIMS 3.8, 3.9) | C3 IS-02 (cap colour as display data) |
| Sex-restricted packages (SLIMS test gender radio) | C3 IS-05 `sex_restriction`; C4 enforces at registration (E24) |
| Microbiology organisms, antibiotics, groups (SLIMS 3.10–3.14, 6.12) | C10 |
| Instrument master, parameter mapping, interface log (EA 9.26, 11.11; SLIMS 3.13–3.20, 4.2, 6.9) | C7 (code maps, interface log, unmatched-result matching); H80E addendum `08-ADDENDUM-TRUTH-H80E.md` |
| Audit trail, activity log (EA 12.2; SLIMS 4.1–4.3) | C2 audit viewer; every change recorded with actor, centre, IP (US-0B-5) |
| TAT: within / near / beyond (SLIMS 4.4, 6.10) | C9 IS-13 warning / breached / escalated alerts (Phase 2); C8 pending list |
| Bulk print / bulk release / zip (EA Search; SLIMS 5.19–5.20) | C6 (bulk release is privileged) |
| WhatsApp / SMS / email logs (EA 9.14; SLIMS 5.21) | C6 delivery log (queued → sent → delivered → read → failed) |
| User lock / unlock, change password, roles (EA 8) | C2 S8 |
| Doctor council number (SLIMS "Medi Coun Num") | C13 admin "Add doctor" (Council ≤20, helper NMC); C3 doctor master |
| Appointments, online booking, enquiries, trips (EA 15; SLIMS 5.10–5.11) | C16 (booking, enquiries), C17 (home collection, pickup, trips), C13 (partner pickups) |
| Phlebotomy / collection boy master (EA 9.8) | C17 |
| Material / reagent stock, purchase request, expiry (SLIMS 8; EA alerts) | C12 (own stores) |
| Keyboard shortcuts (SLIMS Ctrl+Alt+…) | C4 04-UI-UX §3.5 registration shortcuts; `KeyboardShortcutsDialog` in the kit |
| In-app help / user manual (SLIMS User Manual) | C0 `PageHeader.helpKey` required; C2 S24 |
| Immutable invoicing, IRD | C4 S15 (the reference software does not show this; ours is stricter) |

## 2. Gaps to rule on

Priority is my judgment (H = blocks daily work or compliance, M = real daily value, L = convenience). "Ask" = depends on a business fact only the lab can give; do not build on a guess.

| ID | Reference feature | Our spec today | Proposed handling | Owner | Pri | Ask |
|---|---|---|---|---|---|---|
| RG-01 | Expense entry and expense types (EA 13) | Absent | Small `expenses` slice: type master, amount, paid-to, centre, remark; included in the daily cash report | C4 | M | Do they track expenses in the software today? |
| RG-02 | Sales representative, designation, client list (EA 9.10–9.12); marketing executive and target on referrer (SLIMS 5.13) | Absent. B13 / 04 L19 forbids money per referrer | Only the compatible slice: assign a staff "relationship owner" to a client or referrer; no commission, no target money | C3 / C13 | L | Yes — is a rep-to-client view wanted at all? |
| RG-03 | Cash transfer between users with Accept / Reject (EA 19) | Partial: shift close with variance (C4), handover from phlebotomist (C17). No counter-to-accounts transfer | Add a transfer record (from, to, amount, status pending / accepted / rejected, reason) after shift close | C4 | M | |
| RG-04 | Account entry, view account, pocket ledger, cheque-bounce charge, trade discount, Initiated → Verified → Approved chain (EA 18.1–18.8) | Partial: C4 S18 credit-party bills and statements | Check what C4 ledger entry kinds already exist before ruling; likely add `cheque_bounce_charge`, `other_charge` entries | C4 | M | |
| RG-05 | Patient demographic change with Original / Pending / Approved (EA 12.1) | Partial: C4 F4 `updatePatient` with `patient.update` access-log; no approval step; merge deferred | Decide whether edits after a report is released need approval; if yes add a pending-change record. Edits that change a printed name must trigger a report amendment, not silently diverge | C4 / C6 | M | Who approves? |
| RG-06 | Send-out work order to an external lab: select tests, send, receive report (EA 4; SLIMS 6.17–6.18) | Partial: only result PDF intake (C6 IS-05) | Outsource work order: list of order tests per external lab, sent / received states, external lab master, manifest print | C5 | M | Which external labs, and how do they return results? |
| RG-07 | Franchise material request, accept, catalogue (EA 12.3–12.5) | Absent (C12 is the lab's own stores) | Defer until the franchise model is confirmed | C12 / C13 | L | Does Metro supply franchises with consumables? |
| RG-08 | News, banners, profile images for the web portal (EA 16) | Absent | Out of the clinical core; a simple content block in the patient portal admin if wanted | C16 | L | Is marketing content in scope? |
| RG-09 | Default landing page per user (EA 8.1) | Absent | `default_route` user setting, validated against the user's permitted navigation | C2 / C0 | L | |
| RG-10 | Support ticket, Contact Us admin (EA 9.25, shared popup) | Absent (C16 enquiries are patient to lab) | One "Contact the platform team" form with a ticket id; low | C2 | L | |
| RG-11 | KPI tiles: revenue per sample with thresholds; finance dashboard (EA Dashboard) | Absent; C8 has income by department | One more C8 dashboard tile with tenant-set thresholds | C8 | L | |
| RG-12 | Insurance payer on the order; "Is Insurance Client" (EA 9.7); "Insurance Detail" (SLIMS 5.1); referrer type Insurance (SLIMS 5.21) | Absent — the word "insurance" appears nowhere | Insurer master + policy number on order; claims workflow only if they need it | C3 / C4 | M | Yes — do they bill insurers or social health schemes? |
| RG-13 | Registration category Normal / Others / Appointment / Government / House Visit; Emergency / IP / OP (SLIMS 5.1, 5.23); corporate employee popup: employee name, designation, medical card no., referral no., relation (SLIMS 5.1) | Partial: C4 S4 OPD / IPD, cash / credit, collection mode. Government category and corporate employee fields absent | Add `corporate_member_details` on the order and a rate category if "Government" has its own price | C4 | M | Yes — which categories exist at Metro? |
| RG-14 | Visa / foreign-employment medical: passport number, place of issue, study / subject number (SLIMS 5.15, 6.12) | Absent — passport and visa appear nowhere | Do not build on a guess | C4 / C6 | ? | Yes — does Metro do these medicals? |
| RG-15 | Manual report hold with reason; Printed / Dispatched statuses; hand-delivery / courier dispatch register (SLIMS 5.8–5.9, 5.17, 6.12) | Partial: hold-until-paid only; C6 delivery log covers print, SMS, WhatsApp, email but not hand or courier | Manual hold (reason, who, released by) and a dispatch register for hand / courier delivery | C5 / C6 | M | |
| RG-16 | Test-level flags: home visit allowed, discount allowed, no membership discount, service days, minimum sample volume, specimen expiry, gender restriction on a single test, edit bill, repeat reminder (SLIMS 3.1, EA lab configuration) | Partial: sex restriction on packages, recall reminders (C16 / C14); the rest absent | One CR to C3 for a small flag set; C4, C16 and C17 enforce | C3 | M | Which of these does the lab actually use? |
| RG-17 | Referrer / corporate options: stop report printing, no SMS / email, block report when due per client, ignore credit limit, show trend graph, own header / footer (SLIMS 5.13, EA 9.7) | Partial: tenant-level "hold until paid"; per-client overrides and per-client branding not found in C6 (not verified further) | Per-client override record read by C6 and C4 | C3 / C6 | M | |
| RG-18 | At receipt: temperature, count, comment capture (EA 3); compromised-sample override with reason (SLIMS 6.2); discard register (SLIMS 6.7–6.8) | Partial: rejection reasons and discard state exist (C5 IS-06). Temperature capture and discard register report absent | Add an optional receipt-condition record; a discard report in C5 | C5 | L | |
| RG-19 | Prescription check against billed tests (SLIMS 5.7) | Absent (TRF upload exists in C4) | Low; a "TRF verified" flag on the order | C4 | L | |
| RG-20 | Reference ranges per analyser or per firm (SLIMS 3.21–3.22) | Absent: C3 ranges are versioned by age / sex; C7 maps codes only | Optional range override keyed by instrument; ask the lab manager whether any test needs it | C3 / C7 | L | |
| RG-21 | Re-run register with first … fifth re-run and who did it (SLIMS 9.3) | Partial: C5 return / re-apply with reason `rerun_requested`; no rerun-count report | A C8 / C9 report from existing return events | C9 / C8 | L | |
| RG-22 | Chromatogram and image on the report (SLIMS Result master "attach image", "print graph") | Needs a contract change for the H80E chromatogram | Already filed as CR-C7-015 in the H80E addendum | C7 / C6 | M | |

Not found in either reference and therefore not a gap: a dashboard (SLIMS has none), global search (SLIMS has only a menu search box). Menu search is covered in the design system (`10-DESIGN-SYSTEM.md`).

## 3. Already decided — do not re-open without the client

| Reference feature | Decision |
|---|---|
| Commission percentage, lab commission, sub-admin commission, month-wise commission, price allocation by doctor (EA 9.5, 10.1, 18.9–18.10; SLIMS 5.13) | Excluded by B13 / 04 L19: no money per referrer, the word "commission" never appears in any screen. Referrer volume counts only (C13 IS-11, C4 S21, C8 referral business report behind a tenant flag). **Conflict to flag:** the lab's current software pays commission from the system. Confirm that B13 still holds. |
| Coupons (EA 9.31) | Out: C16 01 "Discount coupons — DECISION" (needs C4 registration changes) |
| CRM (EA menu) | Out: 04 §12 DROP ("CRM (export + external tool)") |
| Tabular / custom report builder (EA 14.2) | Deferred: C8 "Generic BI builder … KEEP-LATER" |
| Separate Inventory and QC apps (EA menu) | One system: C12 and C9 |
| Offline data download (EA 9.18) | C17 offline sync for the phlebotomy app; front desk has no offline mode in v1 (C4 03-APP-FLOW, "Offline front desk" row) |

## 4. Not applicable in Nepal

ABHA creation, Aadhaar, HMO code, Razorpay status, PC-PNDT report and fingerprint verification (EA 6, 9.13, Search); Aadhar / UID fields (SLIMS 5.15, 7.2). The title "Dog Of." in the registration title list suggests veterinary samples; no species field exists there and we do not add one.

## 5. Defects in both references that our screens must not copy

Taken from both documents' usability sections. Each is an acceptance check for the restyle passes (see the anti-AI-look table in `10-DESIGN-SYSTEM.md`).

1. Dead menu entries (EA: Create Activity, Activities, Schedular, Online Payment). Every nav item has a route, a permission and a test.
2. Icon-only menu without labels or tooltips at narrow widths.
3. Typos in labels (Outsourse, Genrate, Persentage, Speciman, Acession, Referrence). Labels come from a reviewed string catalogue.
4. Same data asked twice (age and date of birth; patient in ten boxes). One date-of-birth-or-age control.
5. A bill found by re-entering date, SID and category on every screen (SLIMS 10.6). One order context carried across screens.
6. Buttons that do not say their scope: one Save for seven tabs; Delete next to Edit; a long toolbar of near-identical Print buttons.
7. Labels not attached to inputs; no required-field legend.
8. Role-hidden buttons without an explanation. When an action is not available, say why.
9. Dependent dropdowns that are empty until a parent is chosen, with no message.
10. Reports that never load until View is clicked; unlabelled filters; filters disabled until a report type is chosen, with no hint.
11. Developer leftovers (`_Dev` URLs, a disabled "DevExpress" selector).
12. Wrong or copied button labels ("Add New Antibiotic Group" on a Method screen).

## 6. Questions for the lab (one list, so they are asked once)

1. Insurance or social-health billing: yes / no? (RG-12)
2. Foreign-employment (visa) medicals: yes / no? (RG-14)
3. Which registration categories exist besides normal and house visit, and does "Government" have its own rate? (RG-13)
4. Does B13 (no commission in the system) still hold, given the current software pays commission? (section 3)
5. Which external labs receive send-outs, and how do they return results? (RG-06)
6. Is expense tracking wanted in the system? (RG-01)
7. Which test-level flags does the lab use today? (RG-16)
8. Who approves a patient-name correction after a report is released? (RG-05)

## 7. How a gap becomes work

1. Lead ruling in `lead-decisions.md` (accept / defer / reject, with the answer from section 6 where needed).
2. The owning chunk's lead files a CR in `08-CR-REGISTER.md`; C0 applies any contract or schema change.
3. Tasks are added to the chunk's task file only after the CR is accepted.
4. Until then the restyle passes (`RS-<chunk>` in `10-DESIGN-SYSTEM.md`) change appearance and arrangement only, never behaviour.
