# C6 Reporting & Delivery — 01 Product Requirements (PRD)

Status: DECISION, 2026-11-06. Chunk C6, Phase 1 (04 §12), with Phase-2 extension points (micro/anatomic sections, smart report section, preliminary reports). Module `reporting` (schema, API module, worker jobs, staff web feature), plus the deployables `services/renderer` (PDF renderer + PDF sandbox) and `apps/portal` (patient portal + public QR verify, separate origin).

Precedence: `research/00` > `research/04` > `program/03-INTERFACE-CATALOG.md` (03-IC) > `program/01`/`02` > this file. Where this file needs something those documents do not provide, it says DECISION, [CONV], ASSUMPTION, UNVERIFIED or BLOCKED. Every contract gap is raised as a CR in `02-TRD.md` §16 ("Change requests raised") and is designed here as if accepted, marked **(CR-C6-0nn)**.

Labels: **DECISION** = engineering choice made here (change by CR). **[CONV]** = value chosen here with no external fact behind it. **ASSUMPTION** = planning number to validate. **UNVERIFIED** / **BLOCKED (B#)** as in 04.

All examples are synthetic (00 §7.5; 02-CV §11.2). No name, NMC number or value from the client's sample PDFs appears in this document set.

---

## 1. Purpose

C6 turns approved laboratory work into a signed, verifiable, immutable report and gets it to the people entitled to it.

C6 does six things:
1. **Assembles** each report from approved results and other content: department → package → panel → sub-heading grouping, METHOD lines, flags, "Specimen:" lines, narrative sections, merged outsourced PDFs, and (Phase 2–3) micro, anatomic and smart-report sections.
2. **Renders** the report to PDF in an egress-restricted Chromium pool, using per-tenant templates (letterhead on/off, logo, signatories, watermark, QR). Untrusted PDFs are merged in a separate sandbox with qpdf.
3. **Releases** each version under rules: hold-till-paid through `BillingPort.getReleaseEligibility`, partial release, bulk release, and release to the patient, referring doctor and collection centre. Every release emits `reporting.report.released.v1`.
4. **Versions** reports. An amendment creates a new version, and the old version is marked superseded. A released PDF is never overwritten.
5. **Delivers** through the platform's only outbound messaging gateway, `NotificationPort`: WhatsApp utility template (link only), SMS (fallback and OTP), email (link only) and print. It keeps a delivery log, retries, falls back, and checks consent before every send.
6. **Serves the public surfaces** on a separate origin: the QR verification page and the patient portal (report link token + OTP → download).

C6 owns three ports, `ReportingPort`, `NotificationPort` (03-IC §4.7, §4.8) and `RenderPort` (03-IC §4.16, 08 R12c: PDF rendering for C4/C8 worker tasks, bytes returned to the caller). It produces two events, `reporting.report.released.v1` and `reporting.delivery.status_changed.v1` (03-IC §3.17, §3.18). It owns the report-version state machine (03-IC §10.3).

## 2. Users and roles

Role and permission codes come from 03-IC §11. Codes marked **(CR)** are requested in CR-C6-003 and designed as if accepted.

| Role (default) | What they do in C6 | Permissions used |
|---|---|---|
| `front_desk` | See report status and hold reasons, release single reports, print with or without letterhead, resend a report link, view the delivery log | `reporting.report.read`, `reporting.report.release`, `reporting.report.print`, `reporting.delivery.read`, `reporting.delivery.resend`, `reporting.outsourced.attach` |
| `centre_staff` | See and print released reports of their own centre(s) ("send report to collection centre", 00 D4) | `reporting.report.read`, `reporting.report.print` |
| `lab_technologist` | Attach outsourced lab PDFs, prepare narrative drafts | `reporting.report.read`, `reporting.outsourced.attach`, `reporting.narrative.write` (CR) |
| `pathologist` | Release, bulk release, sign narrative reports, regenerate a version, retry a failed render | `reporting.report.read`, `reporting.report.release`, `reporting.report.bulk_release` (privileged), `reporting.narrative.write` (CR), `reporting.narrative.sign` (CR, privileged), `reporting.report.render` (CR), `reporting.report.regenerate` (CR, privileged) |
| `radiologist` **(new default role, CR-C6-003)** | Write and sign radiology/USG/endoscopy narrative reports (00 D9; wishlist 14) | `reporting.report.read`, `reporting.narrative.write` (CR), `reporting.narrative.sign` (CR, privileged) |
| `lab_manager` | Bulk release, bulk print/download, report templates, reporting settings, retry renders | `reporting.report.bulk_release`, `reporting.report.bulk_download` (CR, privileged), `reporting.template.manage` (privileged), `reporting.settings.manage` (CR, privileged), `reporting.report.render` (CR), `reporting.report.regenerate` (CR) |
| `tenant_admin` | Templates, message templates, channel accounts, settings, centre contacts, revoke QR/link tokens, delivery log | `reporting.template.manage`, `reporting.message_template.manage` (CR), `reporting.channel.manage` (CR), `reporting.settings.manage` (CR), `reporting.token.revoke` (CR), `reporting.delivery.read` |
| `finance`, `tenant_admin` | Record a hold-till-paid override through **C4's** endpoint (`createReleaseOverride`), launched from the C6 report screen | `billing.release.override` (C4 permission; privileged) |
| Portal actor (patient, referrer or centre holding a link) | Request OTP, verify, view and download the released report; on a patient link, request a dues payment (08 A11.1, ships with C15) | fixed portal set: `reporting.portal.view`, `reporting.portal.download`, `reporting.portal.challenge` (CR) |
| Anonymous public | Verify a report by QR | none (`x-public`, rate-limited) |
| System actor (`reporting` worker) | Event consumers, assembly, render, auto-release, delivery send, fallback, purges, OTP destination resolution, link reissue, portal dues-payment intents (08 A11.1) | declared in the `reporting` worker manifest (02-CV §2.3; same list as 02-TRD §9 — review fix #8): `reporting.report.read`, `reporting.report.release`, `reporting.delivery.resend`, `reporting.portal.view`, `identity.signatory.read` (CR-C6-007), plus FrontdeskPort purposes `report_render`, `notification`, `portal_display` |

## 3. Problems this chunk solves

1. A patient must not get the report while dues are outstanding (00 D1), but credit-party and authorised exceptions are routine (01 §1.4).
2. Reports must reach patients by WhatsApp and email (00 D2, D3), and the referring doctor and collection centre (00 D4), without sending health data through foreign services (04 R4, R5, §11; 00 §7.1).
3. Outsourced lab reports must appear inside one combined report (00 D5) without letting an untrusted PDF attack our renderer (04 R7).
4. Anyone holding a printed report must be able to check that it is genuine (00 D6) without the check leaking health data (04 R3).
5. Labs print on plain paper and on pre-printed letterhead. They need logo, signatures and watermark (00 D7), and many reports released at once (00 D8).
6. Radiology, USG and endoscopy need free-text reports with images (00 D9; wishlist 14). Cytogenetics is served by the same engine (01 §2 drop list; 04 §12).
7. Amended results must produce a new report version while the old one stays retrievable and is marked superseded (04 R1).
8. The client's existing report layout (00 §4) must be reproduced, so the lab's patients and doctors see a familiar document.
9. Patients need a web page to open and download their report (wishlist 13 "patient portal in website for report access"; 04 §12 "responsive web patient portal").

## 4. Scope

### 4.1 In scope (mapped to client baseline)

| # | Capability | Baseline item(s) | Notes / contracts |
|---|---|---|---|
| IS-01 | Report shell per order from `frontdesk.order.created.v1`; item readiness model (lab, narrative, outsourced) | 00 D1–D9 | consumes C4 events; `lab.order.ready_for_report.v1` |
| IS-02 | Report assembly: header block, department/package/panel/sub-heading grouping, METHOD line per analyte, bold value + "High"/"Low" tag, biological reference range, units, "Specimen:" line per panel, comments | 00 §4 (all bullets) | data via LabPort (`approved` scope), CatalogPort, FrontdeskPort (`report_render`) |
| IS-03 | Per-tenant report templates (versioned): letterhead on/off, header/footer images, logo, signatory block (two or more signatories with title + NMC no. + signature image), QR, "Page N Of M", disclaimer lines, contact strip, watermark, calendar display | 00 D7; 00 §4 footer | branding assets from C2 (CR-C2-008); signatories via IdentityPort (CR-C6-007) |
| IS-04 | Chromium renderer service (pool, recycle, memory cap, timeout, egress-restricted, bundled fonts incl. Noto Sans Devanagari) | 04 S14; REQ-ARCH-043/044/045 | `services/renderer` |
| IS-05 | Outsourced-PDF intake: upload → malware scan → sandboxed qpdf sanitise → staff confirmation → merge into the combined report | 00 D5; 04 R7, S15 | REQ-SEC-083/084/087 |
| IS-06 | Attachment-type results from instruments (images embedded, PDFs merged via the sandbox) | wishlist 3 (HbA1c HPLC, urine images) | from `LabPort` `ResultView.attachments` |
| IS-07 | Narrative report engine: templates per test/kind (X-ray, USG, endoscopy, cytogenetics, other), sanitised rich text, images with captions, draft → sign (radiologist/pathologist), amendments as versions | 00 D9; wishlist 2, 14; 04 §12 | C5 creates no results for `workflow_type = narrative` (C5 PRD Q1) |
| IS-08 | Report versions: immutable PDFs at `{tenant_id}/{yyyy}/{mm}/{report_id}-v{n}.pdf` with sha256; amended = new version, old superseded; report kinds `final`/`partial`/`preliminary`/`amended`/`addendum` (label "Addendum" for a supplementary anatomic report; a micro final after an approved preliminary is `final`, not "Amended" — 08 R1) | 04 R1, D15 | 03-IC §10.3 (+ `discarded`, CR-C6-005) |
| IS-09 | Release rules: hold-till-paid via `BillingPort.getReleaseEligibility`; override recorded by C4; auto-release when eligible (tenant setting); partial release; manual release | 00 D1; 01 §1.4 | 03-IC §4.4 |
| IS-10 | Bulk release (≤ 200 per request) with per-report outcome | 00 D8; REQ-SEC-100 | privileged |
| IS-11 | Release audiences: patient, referring doctor, collection centre (+ partner flag for C13) | 00 D4 | event `audiences` |
| IS-12 | Print: with letterhead (stored canonical PDF) or without (on-demand plain variant from the frozen snapshot); single and bulk print | 00 D7 (review fix #43: 00 A12 is the bill-receipt print, not a report print) | access log `report.print` |
| IS-13 | QR verification page with the 04 R3 field set; identical response for revoked and unknown tokens; ≥128-bit random token | 00 D6; 04 R3, A11 | rate limits 04 §4 |
| IS-14 | Patient portal (`apps/portal`): link token (04 A10) + OTP (04 A9) → view → download; link re-issue; also used by referrer and centre recipients | wishlist 13; 04 §12 | rate limits 04 §4 |
| IS-15 | `NotificationPort` implementation: WhatsApp utility template link-only, SMS (fallback + OTP), email link-only; consent check; template registry with declared non-PHI params; delivery log + attempts; retries; WhatsApp→SMS fallback | 00 D2, D3, D4; wishlist 4; 04 R4–R6 (00 A11 only for the C4 registration-SMS template — review fix #43) | sole provider gateway (01 §5.1) |
| IS-16 | Message template wording deliverables (WhatsApp utility, SMS, email, OTP) | 00 D2/D3; 04 R4 | Meta template approval is **external** (B9) |
| IS-17 | Provider adapter layer (WhatsApp, SMS, email relay) with a recording adapter for non-production | 04 §11; REQ-SEC-136 | provider APIs UNVERIFIED; no invented endpoints |
| IS-18 | Critical-value alerts to the referrer and on-call staff from `lab.critical_value.detected.v1` (message without value) | 04 L21; 03-IC §3.13, §4.8 | C5 keeps the notification log |
| IS-19 | `ReportingPort` for C13/C16 (`getReleasedReports`, `issuePortalLink`, `openReleasedReportFile` for partner and patient actors, `redeemPortalLinkForApp` for patient actors — 08 R11, CR-C13-005, CR-C16-008) | wishlist 5, 10 | 03-IC §4.7 |
| IS-20 | Published views `v_pub_report_release`, `v_pub_order_report_tat`, `v_pub_delivery_daily` | 00 F1; wishlist 15 | 03-IC §6.4 |
| IS-21 | Micro and anatomic report sections from `micro.v_pub_report_content` / `anatomic.v_pub_report_content` | wishlist 2 | Phase 2 (views ship with C10/C11) |
| IS-22 | Smart-report section rendering from `SmartReportPort.buildSummary` output (C14 owns the section templates) | 00 header formula "Smart AI report"; wishlist 8 | Phase 2–3; C6 renders only approved summaries |
| IS-23 | In-app help and user-manual pages for every C6 screen | 01 §2 training note | `apps/web/src/features/reporting/help/`, `docs/manual/reporting/` |
| IS-24 | Portal serves the app association files (Android Digital Asset Links, iOS associated domains) for the patient app **and the phlebotomy app** (08 A13 D-38) and data-free fallback pages (`portal.app_fallback`, incl. `/app/payments/{payment_request_id}/done`; `portal.report_link_required` for `patient_app.report`) | CR-C16-010; 03-IC §7 `phlebo_app` | app ids / fingerprints from the client (store accounts and signing keys client-owned, founder 2026-11-06) — content inputs from C16 and C17 |
| IS-25 | Portal dues payment: a patient-link portal session shows the order's balance and, once C15 is live, pays it through eSewa/Khalti; the portal only *requests* a payment, the reporting worker creates the intent (08 Addendum A11.1; CR-C15-010 ACCEPT-MODIFIED). Under hold-till-paid, a held version triggers a **dues link** (`portal_links.purpose = 'dues'`, template `reporting.dues_due`) whose page shows only the balance and pay button (08 A21.1) | client decision C-04 (08 A11.1) | ships with C15; `reporting.portal_payment_requests`; route `portal.payment_done` |

### 4.2 Out of scope (owner)

| Item | Owner / reason |
|---|---|
| Result entry, verification, approval, amendment of results, critical-value **notification log** (who was called, read-back) | C5 (03-IC §10.2; C5 PRD) |
| Computing dues, invoices, override records, override reason codes | C4 (`BillingPort`; `createReleaseOverride`) |
| Smart-report content rules, template library, approval, section HTML templates in `services/renderer/templates/smart/` | C14 (01 §3) |
| Micro and anatomic report **content** and its published views | C10, C11 |
| Branding asset upload (logo, letterhead header/footer, signature images), signatory profile fields (title, registration no.) | C2 (CR-C2-008, C2 US-B6) |
| Patient consents capture (incl. WhatsApp opt-in at registration) | C4 (REQ-SEC-005); C6 only reads them |
| Registration SMS **trigger** and recollection SMS **trigger** | C4 calls `NotificationPort` (C6 provides the templates, CR-C4-011 accepted) |
| Patient app screens, push notifications | C16 |
| Partner portal report screens | C13 (uses `ReportingPort`) |
| Infra: nginx limits/log exclusions, container network policy, secret store, scanner service in prod | C1 (CR-C6-013) |
| WhatsApp PDF-as-attachment | Not built. Needs founder approval + patient consent (04 R4; B11) |
| PACS/DICOM, RIS | DROP (04 §12) |
| Dedicated cytogenetics module | DROP; narrative engine is used instead (01 §2; 04 §12) |
| Supplement upsell pages | DROP (04 R8) |
| Typst fallback renderer | Documented interface only (04 S14); not built in v1 |
| Nepali-language UI | v1 English (02-CV §13); message templates support Unicode text per tenant |

## 5. User stories and acceptance criteria

Every criterion is a test (05-DoD §2). IDs: `US-xx`, criteria `AC-xx.n`. Synthetic data: tenant `tenant_a` "Synthetic Lab Alpha", patient "Test Patient 0042", registration no. `0001SY000001`, barcode `E2600000042`, centre `C000000099` "Synthetic Centre Ninety-Nine".

### US-01 Report shell and readiness
As the system, I keep a report shell per order so that I know when the report can be assembled.
1. **AC-01.1** Given `frontdesk.order.created.v1` for an order with a CBC test (workflow `standard`), an X-ray test (workflow `narrative`) and an outsourced test, when the consumer runs, then one `reports` row with family `laboratory` and one with family `narrative` exist (tenant setting `narrative_report_mode = separate`), and three `report_order_items` rows carry `requires_lab`, `requires_narrative`, `requires_outsourced` respectively.
2. **AC-01.2** Given the same event delivered twice, when the consumer runs the second time, then no new rows appear (inbox dedupe).
3. **AC-01.3** Given `frontdesk.order.items_changed.v1` removing the outsourced item, when processed, then that item becomes `removed` and is excluded from readiness.
4. **AC-01.4** Given `narrative_report_mode = combined`, when the order above is created, then only the `laboratory` report exists and it requires all three items.
5. **AC-01.5** Given `lab.order.ready_for_report.v1` arrives before `frontdesk.order.created.v1` was processed, when the consumer runs, then it fetches the order through `FrontdeskPort.getOrderSummary`, creates the shell and records readiness (no failure).

### US-02 Assemble a report version
As a pathologist, I want a correct report to be built automatically once results are approved.
1. **AC-02.1** Given all items of the `laboratory` report are ready (lab items covered by a `complete` readiness event, the outsourced file confirmed), when assembly runs, then a `report_versions` row is created with `status = rendering`, `report_kind = final`, `completeness = complete`, a frozen `content_snapshot`, its `content_sha256`, and a QR token.
2. **AC-02.2** Given three readiness events for the same order inside 30 s, when assembly runs, then exactly one version is created (debounce + fingerprint).
3. **AC-02.3** Given the readiness fingerprint equals the latest version's fingerprint, when assembly runs, then no new version is created.
4. **AC-02.4** Given tenant `partialReleaseAllowed = true` and a `partial` readiness event covering Hematology only, when assembly runs, then a version with `report_kind = partial` that contains only the Hematology items is created.
5. **AC-02.5** Given `partialReleaseAllowed = false` and the narrative item still unsigned, when the lab readiness event is `complete`, then no version is created for the `laboratory` report in combined mode until the narrative item is signed.
6. **AC-02.6** Given `lab.result.amended.v1` followed by a readiness event with `contains_amendment = true` for an order whose version 1 is released, when assembly runs, then version 2 is created with `report_kind = amended` and `supersedes_version_no = 1` is set only at release.
7. **AC-02.7** Given LabPort returns an analyte flagged `H` with `methodName = "Synthetic Method X"`, when the snapshot is built, then the analyte line has `flag_label = "High"`, `value_bold = true` and `method_line = "METHOD : Synthetic Method X"`.
8. **AC-02.8** Given a micro order whose released version 1 has `report_kind = preliminary` and C5 approves an updated preliminary with amendment reason `module_preliminary_update` (08 A17 D-61), when assembly runs, then version 2 has `report_kind = preliminary`, status label "Preliminary" and no "AMENDED REPORT" box; the same reason never yields `amended` (rule 1 exclusion set {`module_phase_progression`, `module_preliminary_update`, `supplementary_report`}).

### US-03 Render the PDF in the Metro Labs layout
As a patient, I want a report that looks like the one my lab already uses.
1. **AC-03.1** Given a snapshot with one package containing CBC (sub-headings "RBC parameters", "WBC parameters"), when rendered, then the PDF text, in order, shows the package heading, the test-panel heading, each sub-heading, each analyte with its result, reference range and unit columns ("Tests | Results | Biological Ref Range | Units"), a "METHOD : …" line under each analyte that has a method, and "Specimen: EDTA WHOLE BLOOD" (synthetic label) at the panel end.
2. **AC-03.2** Given a report longer than one page, when rendered, then every page shows the patient header block fields (Name, Age/Gender, Reg No, Barcode No, Sample Coll Dt, Sample Rcv Dt, Reg Date, Reported Date, Report Status, Referred By, Sample Collected At) and the footer (signatories, QR, "Page N Of M", disclaimer lines, contact strip). Checked by PDF text extraction per page.
3. **AC-03.3** Given a header field date, when tenant `calendarDisplay = AD`, then dates print as `DD/MM/YYYY hh:mm A` in `Asia/Kathmandu`. When `AD_BS`, then the B.S. date from `@lims/shared-ts/bsdate` follows in brackets (`DD/MM/YYYY hh:mm A (YYYY-MM-DD B.S.)`). When `BS` → `YYYY-MM-DD B.S. hh:mm A`; when `BS_AD` → `YYYY-MM-DD B.S. hh:mm A (DD/MM/YYYY)` [CONV] (review fix #32; golden test per mode).
4. **AC-03.4** Given a patient name in Devanagari ("परीक्षण बिरामी" — synthetic), when rendered, then the PDF embeds Noto Sans Devanagari and text extraction returns the same Unicode string (NFC).
5. **AC-03.5** Given the template has watermark text "SYNTHETIC", when rendered, then every page carries the watermark.
6. **AC-03.6** Given two approving pathologists with signatory profiles (title, registration no. `NMC-SYN-0001` / `NMC-SYN-0002`, signature images), when `signatory_mode = approvers`, then the footer shows both names, titles, "NMC No." lines and signature images, read by the render worker through `IdentityPort.readSignatureImage` (08 A21.2; the fake returns a synthetic placeholder image until C2 implements it). A membership with no signature image on file (`common.not_found`) prints name + title without an image.
7. **AC-03.7** Given `signatory_mode = nominated`, when rendered, then the nominated signatories print and the disclaimer line "Authorized signatory nominated by Lab Director" (tenant text) appears. Approvers are still listed in the per-department "Approved by" line.
8. **AC-03.8** Given the renderer receives HTML that references `http://169.254.169.254/` or any non-`data:` URL, when it renders, then the request is blocked, the PDF renders without it, and `lims_renderer_blocked_requests_total` increments (REQ-SEC-086).
9. **AC-03.9** Given the render exceeds the timeout or the browser crashes, when retried up to 5 attempts, then the version ends `render_failed` with `last_render_error_code = reporting.render_unavailable` and appears in the "Render failed" tab.
10. **AC-03.10** Given a version is rendered, then its PDF is stored at `{tenant_id}/{yyyy}/{mm}/{report_id}-v{n}.pdf` in bucket `reports`, the row stores `pdf_sha256` and `page_count`, and the object is never written again.

### US-04 Outsourced report merge
As a lab technologist, I want to add the outside lab's PDF so the patient gets one combined report (00 D5).
1. **AC-04.1** Given an outsourced item, when I upload a 2 MB PDF with external lab name "Synthetic Reference Lab", then the file is stored in quarantine, `state = pending_scan`, and staff cannot preview it.
2. **AC-04.2** Given the scanner reports a hit (EICAR test file), then `state = quarantined`, the upload is rejected with `reporting.outsourced_pdf_rejected`, and an alert metric increments.
3. **AC-04.3** Given a clean scan, when the sandbox sanitises it with qpdf, then `state = ready`, `sanitized_sha256` and `page_count` are stored and the sanitised file is previewable (download, `Content-Disposition: attachment`).
4. **AC-04.4** Given a ready file, when I confirm it (patient match check), then `state = confirmed` and the item becomes ready.
5. **AC-04.5** Given a confirmed outsourced file, when the report is rendered, then the final PDF = our pages + the sanitised outside pages, and every page (including the outside pages) carries "Page N Of M" stamped with the total of the merged document.
6. **AC-04.6** Given an encrypted, malformed or > 15 MB PDF, then it is rejected (`reporting.outsourced_pdf_rejected` or `common.payload_too_large`) and never sent to the Chromium pool.
7. **AC-04.7** Given a PDF the sandbox does not finish within its timeout, then the file is `rejected` with `last_error_code = reporting.outsourced_pdf_rejected`.

### US-05 Narrative reports (radiology, USG, endoscopy, cytogenetics)
As a radiologist, I want to write a report from a template, add images and sign it.
1. **AC-05.1** Given an X-ray order item, when I open it, then a draft exists pre-filled from the test's narrative template (sections "Clinical history", "Technique", "Findings", "Impression" — synthetic seed).
2. **AC-05.2** Given I paste HTML containing `<script>` or `onerror=`, when the draft is saved, then the stored HTML has neither (server-side sanitiser allowlist) and the response shows the sanitised content.
3. **AC-05.3** Given I upload a PNG, then it is scanned, re-encoded and listed with a caption field. An SVG is rejected with `common.unsupported_media_type`.
4. **AC-05.4** Given a required section is empty, when I sign, then `422 reporting.narrative_incomplete` (CR) and nothing changes.
5. **AC-05.5** Given I hold `reporting.narrative.sign` at aal2, when I sign, then the version becomes `signed`, my signatory profile is recorded, the item becomes ready, and further edits return `409 reporting.narrative_locked` (CR).
6. **AC-05.6** Given a signed narrative in a released report, when I start an amendment with reason `transcription_error`, then a new draft version is created; signing it produces a new report version of kind `amended`.
7. **AC-05.7** Given I lack `reporting.narrative.sign`, when I sign, then `403 auth.forbidden`. At aal1 → `403 auth.mfa_required`.

### US-06 Hold-till-paid and release
As front desk, I want the report held while dues are outstanding, and released automatically when they are paid (00 D1).
1. **AC-06.1** Given `releaseRequiresPayment = true`, balance due NPR 500, and a rendered version, when auto-release evaluates, then `BillingPort.getReleaseEligibility` returns `due_outstanding`, the version stays `rendered`, `held_basis = due_outstanding`, and the worklist shows "Held — dues".
2. **AC-06.2** Given `billing.balance.changed.v1` with `release_eligible = true`, when processed, then C6 calls `getReleaseEligibility` again (the event is only a hint) and releases if it returns eligible. One `reporting.report.released.v1` is emitted with `release_basis = paid_in_full`.
3. **AC-06.3** Given the hint says eligible but the port says not eligible, then nothing is released.
4. **AC-06.4** Given an authorised user recorded an override through C4 (`createReleaseOverride`), when I release, then the release succeeds with `release_basis = override`, the version stores `release_override_id`, and `access_log` has `report.release` with the override id.
5. **AC-06.5** Given a credit-party order with dues, when evaluated, then it is released with basis `credit_party`.
6. **AC-06.6** Given I release a version that is not `rendered`, then `409 reporting.release_not_ready`. Given a newer rendered version exists, then `409 reporting.version_not_latest` (CR).
7. **AC-06.7** Given I release with a stale `If-Match`, then `409 common.version_conflict`. Given I repeat the same request with the same `Idempotency-Key`, then the stored response is replayed.
8. **AC-06.8** Given `auto_release = manual`, when a version renders, then it waits for a user release even if eligible.
9. **AC-06.9** Given version 2 is released while version 1 is released, then version 1 becomes `superseded` in the same transaction, the event for v2 carries `supersedes_version_no = 1` and `report_kind = amended`, and the QR of v1 now verifies as "superseded".

### US-07 Bulk release
As a pathologist, I want to release many reports at once (00 D8).
1. **AC-07.1** Given 150 selected rendered versions of which 20 have dues, when I bulk-release, then 130 are released, 20 return `blocked_due`, and 130 events are emitted (one per version).
2. **AC-07.2** Given 201 ids, then `400 common.validation_failed` (spec `maxItems: 200`). Given tenant `bulk_release_max = 100` and 101 ids, then `422 reporting.bulk_release_too_large`.
3. **AC-07.3** Given ids that include another tenant's or another centre's version, then those ids return `not_found` per item and nothing about them is revealed.
4. **AC-07.4** Given I lack aal2, then `403 auth.mfa_required` (privileged permission).

### US-08 Release to patient, doctor and centre
1. **AC-08.1** Given a released version, patient consent `whatsapp = true` with a phone, tenant WhatsApp enabled, then one WhatsApp delivery with purpose `report_ready` is queued whose params are only `lab_name` and the link. No test name, result, patient name or registration number is in any param.
2. **AC-08.2** Given the patient has only SMS consent, then an SMS delivery is queued instead.
3. **AC-08.3** Given the order has a referrer with a phone, patient consent `shareWithReferrer = true` and `referrer_delivery_enabled = true`, then a referrer delivery is queued. With `shareWithReferrer = false`, the audience `referrer` is omitted from the event and no referrer delivery exists.
4. **AC-08.4** Given a centre-scoped user of centre C000000099, when listing reports, then they see released reports of their centre only; reports of another centre are not listed and their ids return 404.
5. **AC-08.5** Given the patient has email consent and an email, then an email delivery with the link (no attachment) is also queued.
6. **AC-08.6** Given no consent on any channel, then the release still succeeds, `audiences` contains `patient`, and deliveries are recorded `suppressed` (no-consent) for audit.

### US-09 Delivery reliability and log
As front desk, I want to know whether the report reached the patient.
1. **AC-09.1** Given the WhatsApp adapter returns a retryable error, then the task retries (max 8 attempts) and each attempt is logged in `delivery_attempts`.
2. **AC-09.2** Given a WhatsApp delivery is `sent` but not `delivered` within `whatsapp_fallback_minutes` (default 30 [CONV]), then an SMS fallback delivery is created with `fallback_of_delivery_id` set, a new SMS-channel link, and a `reporting.delivery.status_changed.v1` event.
3. **AC-09.3** Given a provider status callback with a valid callback token, then the delivery moves `sent → delivered` (or `read` for WhatsApp) and one event is emitted per transition. A duplicate callback causes no second transition.
4. **AC-09.4** Given the patient withdraws WhatsApp consent after the delivery was queued, when the send task runs, then the delivery becomes `suppressed` (consent re-checked at send time).
5. **AC-09.5** Given a non-production environment, when any delivery is sent, then only the recording adapter is used and no network call leaves the stack (REQ-SEC-136).
6. **AC-09.6** Given I open the delivery log, then I see channel, purpose, recipient kind, masked destination (`+97798•••••408`), status timeline and attempts, but never the full phone, email, link URL, OTP or message body.
7. **AC-09.7** Given I press Resend on a failed delivery, then a new delivery is queued with a new link; the old link is revoked.
8. **AC-09.8** Given a queued WhatsApp delivery whose send-task re-check finds the tenant WhatsApp channel switched off (`channel_disabled`) or WhatsApp consent withdrawn (`no_consent`), when the send task runs, then the WhatsApp delivery becomes `suppressed` and one SMS fallback delivery (`fallback_of_delivery_id` set) is created at once if SMS is enabled and consented (review fix #19).

### US-10 QR verification
As anyone holding a printed report, I want to check it is genuine (00 D6).
1. **AC-10.1** Given a released version's QR token, when I open `/v/{token}`, then I see exactly: lab name, masked patient name (initials), test panel name(s), issue date/time, version number and status "Valid". No results, phone, address or date of birth.
2. **AC-10.2** Given the version is superseded, then status shows "Superseded — a newer version of this report exists".
3. **AC-10.3** Given an unknown token, a revoked token, a token of an unreleased or discarded version, or a malformed token, then the response body, status code (404 `reporting.verify_not_found`) and headers are byte-identical across all four cases.
4. **AC-10.4** Given 11 requests to `/v/{token}` in one minute from one IP, then the 11th returns 429 (nginx on the portal origin, 10/min/IP). Given 101 verifications in one day from one client IP, then the 101st returns `429 common.rate_limited` (app, 100/day keyed on `app.client_ip`, which the core takes from the portal's forwarded `X-Forwarded-For` only with a valid portal BFF key — 08 A13 D-32). Two different client IPs behind the same portal server do not share the limit.
5. **AC-10.5** Given the QR token is 22 base64url characters encoding 128 random bits (≥128-bit, 04 A11), then the DB stores only its SHA-256, never the token.

### US-11 Patient portal: link + OTP + download
As a patient, I want to open the link I received, enter a code and download my report.
1. **AC-11.1** Given a valid link, when I open `/r/{token}` and press "Send code", then the API answers `202 {challenge_id, channel}` and the worker queues an OTP (6 digits, CSPRNG) to (a) the destination the link was sent to, or (b) for links with no stored destination (`patient_app`, `print_qr`, C13 access slips) the patient's phone on file (08 A13 D-31). The page says "Code sent to the mobile number registered with the lab" (no mask). The OTP message contains only the code, lab name and validity minutes. With no phone on file, nothing is sent and the page and API responses are the same as for a sent code.
2. **AC-11.2** Given the code, when I enter it within 10 minutes, then a portal session starts and I see the report summary (lab name, report status, issue date, masked patient name) with a Download button.
3. **AC-11.3** Given 5 wrong codes, then the challenge is invalidated (`401 auth.otp_attempts_exhausted`) and the 6th attempt with the right code fails.
4. **AC-11.4** Given a 4th code request on the same link within an hour, then `429 common.rate_limited` (key `otp:l:<link_id>`). Given a 4th OTP send to the same phone within an hour through different links, then that challenge becomes `superseded` and no 4th SMS is sent (per-destination key `otp:p:<hex>`, 04 A9).
5. **AC-11.5** Given an expired, revoked, unknown or malformed link token, then the page and API response are identical (`404 reporting.link_invalid`) for all four cases; every invalid-link page offers "Request a new link", which always shows the same confirmation page, and a new link is sent only for an expired, unrevoked link (P5 → job `reporting.reissue_portal_link`, at most `link_reissue_max_per_day` per day) (review fix #11).
6. **AC-11.6** Given 21 downloads within one hour on one link, then the 21st returns `429 common.rate_limited`.
7. **AC-11.7** Given the linked version was superseded by an amendment, then the portal shows the latest released version with the notice "This report was updated on {date}". The superseded version is not offered for download.
8. **AC-11.8** Given a portal session idle for 15 minutes or older than 60 minutes [CONV], then the next request requires a new OTP.
9. **AC-11.9** Given any `/r/` or `/v/` page, then the response carries `Referrer-Policy: no-referrer`, `Cache-Control: no-store`, the CSP from REQ-SEC-089, and the token never appears in API URLs (portal → API sends it in a header).
10. **AC-11.10** Given a download, then `access_log` has `report.portal_download` (CR-C6-008) with link id and version id, and the PDF is served with `Content-Disposition: attachment`.
11. **AC-11.11** (08 A7.4 / A4.7) Given the session's version has `smart_summary_json` NULL, then the report page has no "Health summary" section (no heading, no placeholder). Given it is set, then a read-only "Health summary" section is rendered from that snapshot only, with C14's fixed notice N1 and the snapshot's `disclaimerText`, no form controls and no links. Given a snapshot that cannot be rendered, then the section shows the error copy and the rest of the page (incl. Download) is unaffected. In every case the request path makes zero `SmartReportPort` calls (review fix #21).
12. **AC-11.12** Given a `link`-stage credential (OTP not yet verified) on `GET /portal/report`, the PDF download or session end, then `401 reporting.otp_required` (review fix #28).

### US-12 Print
1. **AC-12.1** Given a released version, when I print "With letterhead", then the stored canonical PDF is served (print job `ready` at once, no new file), a delivery with `channel = 'print'`, `purpose = 'report_ready'`, no message template, status `sent` and idempotency key `<print_job_id>:print` is recorded, and `access_log` has `report.print` (review fix #5).
2. **AC-12.2** Given I print "Without letterhead", then a plain variant is rendered from the same frozen snapshot and template version (letterhead images omitted, the same top and bottom margins kept for pre-printed paper), served within the print job, and deleted after 24 h [CONV].
3. **AC-12.3** Given an unreleased version, when a user without `reporting.report.release` prints, then `409 reporting.report_not_released`. Staff holding both `reporting.report.print` and `reporting.report.release` may print a draft stamped "NOT RELEASED" (08 A13 D-37; no new role grant).
4. **AC-12.4** Given I select 50 released reports and choose Bulk print, then one merged PDF is produced, `access_log` has `report.bulk_download` with the count, and the action requires `reporting.report.bulk_download` at aal2.

### US-13 Templates and settings
1. **AC-13.1** Given I edit a template draft (margins, watermark, disclaimer lines, signatory mode), when I preview, then a PDF with **synthetic sample data** (never real patients) is produced.
2. **AC-13.2** Given I publish, then a new immutable template version exists. Versions already rendered keep their old template version, and only new versions use the new one.
3. **AC-13.3** Given a template config with a disclaimer line longer than 200 characters or an unknown key, then `422 reporting.template_invalid`.
4. **AC-13.4** Given I edit the WhatsApp template text, then I can record the provider template name and approval status manually, but I cannot add parameters beyond the global declared set.

### US-14 Critical-value alert
1. **AC-14.1** Given `lab.critical_value.detected.v1` with a `referrer_id`, patient consent `shareWithReferrer = true`, and a referrer phone, then one SMS with purpose `critical_value_alert` is queued whose text is exactly the template of 04-UI-UX §7: "{lab_name}: critical result for your patient. Please call {lab_phone} now. Ref {ref}." (synthetic values), with no value, test, patient name or link (08 A13 D-35; review fix #22).
2. **AC-14.2** Given on-call staff memberships configured (`critical_alert_recipient`), then each gets one alert row (Phase 1: `suppressed_no_contact`, shown in the Critical alerts panel). Duplicate events create nothing extra (idempotency key `<critical_event_id>:<recipient_kind>:<recipient_id>`).
3. **AC-14.3** Given a critical event at centre C000000099, when a user of that centre opens the worklist, then the Critical alerts panel (R18 `listCriticalAlerts`, polled every 30 s) lists the event with registration no., alert time and each recipient's delivery status, and no value, analyte or patient name; a user of another centre does not see it (review fix #16).

### US-15 ReportingPort for partner portal and patient app
1. **AC-15.1** Given the 8 contract cases in 03-IC §4.7, then the real implementation passes them all.
2. **AC-15.2** Given `issuePortalLink` for a released report, then the URL is `{portal_origin}/r/{token}` with a ≥128-bit token, `expiresAt = now + reportLinkTtlDays`, and only the token hash (32-byte `bytea`, 08 R24) is stored.
3. **AC-15.3** Given a partner actor calls `openReleasedReportFile` for a report of another partner, or for an unreleased version, then `common.not_found` is returned (indistinguishable); for its own released report it returns `ReleasedReportFile` with an internal signed URL (TTL ≤ 300 s).
4. **AC-15.4** Given a patient actor calls `redeemPortalLinkForApp` with a referrer link, an expired link or a wrong phone, then `reporting.link_invalid` is returned and the link is otherwise unchanged (a wrong phone only increments `redeem_failures`, and the increment is kept although the call fails — `ctx.commitOnError()`, 08 A19 P-42). Given 5 wrong phones on one link, then a 6th call with the correct phone also returns `reporting.link_invalid` (08 A13 D-30; DEFINER `app.reporting_redeem_link_for_app`).

### US-17 RenderPort for C4 and C8 (08 R12c)
1. **AC-17.1** Given a C4 or C8 worker task (system actor) calls `renderPdf` with key `billing.invoice` and schema-valid data, then PDF bytes with `sha256`/`byteSize`/`pageCount` are returned and C6 stores nothing.
2. **AC-17.2** Given a user actor calls `renderPdf`, then `auth.forbidden`; given data violating `contracts/render/<key>.schema.json`, then `reporting.template_invalid`.

### US-16 NotificationPort for other chunks
1. **AC-16.1** Given the 12 contract cases in 03-IC §4.8 (review fix #20), then the real implementation passes them all. Purposes include `scheduled_report_ready` (C8), `booking_cancelled`, `booking_reminder` (C16) — 08 R13.
2. **AC-16.2** Given C4 calls `sendSms` with template `frontdesk.registration_confirmation` and params `{lab_name, registered_time_hhmm}`, then a delivery is queued. A call with a param `test_names` is rejected `422 reporting.notification_params_invalid`.
3. **AC-16.3** Given the caller's transaction rolls back, then no delivery row and no job exist.
4. **AC-16.4** Given C8 calls `sendEmailLink` with template `analytics.report_ready`, a `staff` recipient and `linkUrl = {LIMS_ORIGIN_STAFF_WEB}/analytics/report-runs/<uuid>`, then the link passes the `staff_url` kind and the delivery is queued (if the recipient is eligible); a portal URL, another origin or a path that is not a staff route → `422 reporting.notification_params_invalid` (08 A13 D-29).
5. **AC-16.5** Given C17 calls `sendSms` with template `homecollection.visit_assigned` and params `{route_date, visit_count}` to a staff recipient, then the call succeeds with `suppressed_no_contact` (Phase 1) and no error (08 A13 D-34).
6. **AC-16.6** Given C17 calls `sendSms` with template `homecollection.visit_scheduled`, purpose `booking_confirmation`, a `patient` recipient with SMS consent and a phone on file, and params `{window_start_local: "2026-11-07 07:00", window_end_local: "2026-11-07 09:00"}` (synthetic), then an SMS delivery is queued; a third param (e.g. `lab_name`) or a value that fails `short_text` → `reporting.notification_params_invalid` (CR-C17-014, 08 A19 D-129).

### US-18 Portal dues payment (08 Addendum A11.1; ships with C15)
As a patient holding my report link, I want to pay what I still owe from the same web page.
1. **AC-18.1** Given a patient-link portal session, a balance hint of NPR 500 on the report and `portal_payment_gateways = [esewa, khalti]`, when I open the report page, then I see "Amount due: NPR 500.00" and the buttons "Pay with eSewa" and "Pay with Khalti".
2. **AC-18.2** Given `portal_payment_gateways = []` (default; always the case before C15 is live), then the page shows the amount and "Please pay at the lab counter or in the app" and no payment button. Given a referrer, centre or partner link, then no dues section appears and `POST /portal/payment-requests` → `404 common.not_found`.
3. **AC-18.3** Given I press "Pay with eSewa", then `POST /portal/payment-requests {gateway: esewa}` (with an Idempotency-Key) returns `202` with status `queued`; the worker (reporting system actor) reads `BillingPort.getOrderBalance` and calls `PaymentProviderPort.createIntent` with `idempotencyKey = rpt_<id>` and return/cancel URL `{LIMS_ORIGIN_PORTAL}/r/payments/<id>/done`. A request body containing an amount → `400 common.validation_failed`; the portal request path never calls `BillingPort` or `PaymentProviderPort`.
4. **AC-18.4** Given the same Idempotency-Key is sent again, then the stored response is replayed; given a second request on the same link while one is open, then `200` with the open request; given an open request created through another link of the same order, then `409 common.version_conflict` (detail `payment_in_progress`).
5. **AC-18.5** Given the request is `ready`, then the status page shows "Continue to eSewa" linking to the gateway URL; the URL is returned only to this link's session, only while `ready`, and appears in no log.
6. **AC-18.6** Given the gateway redirects to `/r/payments/<id>/done?outcome=settled` while C15 still reports the intent pending, then the page shows "Checking your payment…" (the `outcome` value is never trusted); when `getIntent` reports `settled`, then the request becomes `completed` and the page shows "Payment received. Thank you."; the ledger entry is written by C15 through `BillingPort.recordGatewayPayment` in its settle transaction, with C4's `payments.intent.settled.v1` consumer as the idempotent safety net (08 A19 D-115); C6 writes no ledger data.
7. **AC-18.7** Given the C15 phase stub is active (`payments.gateway_not_available`), or the balance read by the worker is 0, then the request ends `failed` (`gateway_not_available` / `nothing_due`) and the page shows the counter/app copy without a button.
8. **AC-18.8** (08 A21.1) Given `releaseRequiresPayment = true`, a rendered version held `due_outstanding` with NPR 500 due, patient SMS consent and `dues_link_enabled = true`, when auto-release evaluates, then one `dues_reminder` SMS with template `reporting.dues_due` is queued with params `lab_name`, `amount_text = "NPR 500.00"` and the dues link only; re-evaluation of the same version queues nothing more.
9. **AC-18.9** Given I open the dues link and pass OTP, then I see only the amount, the pay buttons (or "Please pay at the lab counter or in the app" before C15) and "Your report will be sent once payment is complete"; `GET /portal/report` and the PDF download return `404`, and no report version or QR row is readable.
10. **AC-18.10** Given the payment settles (C15 settle transaction with `BillingPort.recordGatewayPayment` — 08 A19 D-115 — → `billing.balance.changed.v1`) and the version is released, then the normal `report_ready` delivery is queued and the dues link is revoked (`dues_settled`).
11. **AC-18.11** Given `dues_link_enabled = false` or no consent, then no dues message is sent (no consent → a `suppressed` delivery row).

## 6. Success metrics

| Metric | Target | Source |
|---|---|---|
| Ready → rendered latency (p95) | ≤ 60 s [CONV] | `lims_reporting_assembly_to_render_seconds` |
| Render duration, ≤ 25-page report (p95) | ≤ 5 s (02-TRD §11 arithmetic) | `lims_renderer_render_duration_seconds` |
| Render failure rate | < 1 % of versions per day [CONV] | `lims_reporting_render_failures_total` |
| Release → first delivery queued (p95) | ≤ 5 s [CONV] | delivery `queued_at - released_at` |
| WhatsApp/SMS delivered rate (where the provider reports it) | tracked, no target until real volumes (B9) | `v_pub_delivery_daily` |
| QR verify latency (p95) | ≤ 100 ms server time [CONV] | HTTP metrics |
| PHI found in any message body, log line or URL in CI scans | 0 | log-scan + template tests |
| Cross-tenant probe failures | 0 | probe suite |
| PDF size per report | measured; 04 §14 assumption 150 KB is UNVERIFIED | `lims_reporting_pdf_bytes` histogram |

## 7. Phase

- **Phase 1:** IS-01 … IS-20, IS-23. **Phase 3** (with C16): IS-24. **With C15** (Phase 1.5–2; 08 A11.1): IS-25 — before C15 is live the portal shows the balance only (AC-18.2).
- **Phase 2:** IS-21 (micro/anatomic sections once C10/C11 ship their views), `report_kind = preliminary` (micro prelim).
- **Phase 2–3:** IS-22 (smart section, once C14 ships `services/renderer/templates/smart/` and approved summaries).

## 8. Dependencies (contracts only)

| Dependency | What C6 uses | Until the owner merges |
|---|---|---|
| C0 core | auth (incl. `portalSession` resolver, CR-C6-001), tx, idempotency, rate limit tiers, events, access log, `ctx.storage` / `ctx.uploads` (CR-C2-011, acknowledged by CR-C6-009) | — (C0 first) |
| `IdentityPort` (C2) | `assertRole`, `getActor`, `getTenantSettings` (`releaseRequiresPayment`, `partialReleaseAllowed`, `reportLinkTtlDays`, `letterheadDefault`, `channels`, `calendarDisplay`, `timezone`, `retentionYears`, `branding` CR-C2-008), `getSignatories` + `readBrandingAsset` (CR-C6-007) | fake |
| `FrontdeskPort` (C4) | `getOrderSummary`, `getPatientDemographics` (`report_render`, `notification`, `portal_display`; contact-presence flags CR-C6-015) | fake |
| `BillingPort` (C4) | `getReleaseEligibility` (authoritative), `getOrderBalance` (also read by the portal-payment worker task, 08 A11.1) | fake |
| `LabPort` (C5) | `getOrderResults(scope: 'approved')` (+ `moduleRef`, specimen `barcode`, CR-C6-006); `lookupSpecimens({barcode})` for R2 barcode search | fake |
| `CatalogPort` (C3) | `getTest`, `getPanel`, `getReferrer` (CR-C3-001), `specimenReportLabel`, `printName` (CR-C3-001) | fake |
| `SmartReportPort` (C14) | `buildSummary` (Phase 2–3) | fake in tests; phase stub in staging/production (`smartreport.feature_disabled`, 02-CV §8.2, 08 R9) |
| `PaymentProviderPort` (C15) | `createIntent`, `getIntent` — reporting worker (system actor) only, for the portal dues payment (08 A11.1; CR-C15-010 ACCEPT-MODIFIED); never from a portal request | fake in tests; phase stub (`payments.gateway_not_available`) until C15 ships (08 R9) |
| Events in | `frontdesk.order.created/items_changed/cancelled.v1`, `billing.balance.changed.v1`, `lab.specimen.status_changed.v1`, `lab.result.approved.v1`, `lab.result.amended.v1`, `lab.order.ready_for_report.v1`, `lab.critical_value.detected.v1`, `catalog.changed.v1` | synthetic events from `packages/test-fixtures` |
| Views read | `micro.v_pub_report_content`, `anatomic.v_pub_report_content` only. Department names come from `CatalogPort.getTest` (`TestDefinition.departmentName`) and the partner id from `FrontdeskPort.getOrderSummary` (`OrderSummary.partnerId`) — CR-C6-012 as modified by 08 R25 | fixture views in integration DB |
| C4 HTTP | `createReleaseOverride`, `listBillingCodes` (`override_reasons`) called from the C6 screen through the BFF | MSW mock |

## 9. Blocked and unverified items (build against the default)

| Item | Blocker / status | Default built now |
|---|---|---|
| Meta business verification, WhatsApp volume, Nepal rate | **B9** (client) | WhatsApp adapter behind config; budget assumes charged utility templates (04 T3); SMS fallback always on |
| WhatsApp PDF attachment | **B11** (founder) | Not built; link-only (04 R4) |
| WhatsApp Cloud API / BSP endpoints, template syntax, webhook signature | UNVERIFIED (no primary doc read in 04) | Adapter interface + recording adapter; concrete adapter task gated on reading the provider's official docs (06 task C6-T27) |
| Sparrow / Aakash SMS API parameters; sender-ID approval authority; provider hosting location | UNVERIFIED (01 §4.4) | SMS adapter interface; treat as cross-border (04 §11); no PHI |
| Email relay vendor | not chosen (04 S20 "Brevo/Postmark/SES-type") | generic SMTP-submission adapter to a configured relay; link-only |
| Legal retention for lab reports | **B15**; 04 L20 UNVERIFIED | 5 years online (per-tenant `retentionYears`), no purge of report PDFs in v1 |
| Self-hosted Storage populating `request.jwt.claims` | 04 D3 UNVERIFIED (C0 spike SP-4) | All PDF reads/writes go through the API with server-side storage credentials (`ctx.storage`); no client-side Storage access |
| Smart-report template owner | **B14** | Smart section shows only C14 summaries with `status = approved` |
| Test list / real methods / ranges | **B3** | Synthetic catalogue |
| Privacy Regulation 2077 content | **B16** | Consent rules as in 02 (REQ-SEC-005/006); OTP and referrer-sharing rules flagged for counsel |
| 150 KB per PDF | 04 §14 UNVERIFIED | Measure (metric); size storage from measurement |
| ISO 15189 basis of amended reports | 04 L22 UNVERIFIED | Built anyway as the client requirement 00 C6 + 04 R1 |
