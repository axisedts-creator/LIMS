# LIMS Product Research: Features, Workflows, Interfacing, Nepal Compliance

**Project:** the LIMS provider — cloud multi-tenant LIMS for Nepali diagnostic labs
**Anchor client:** Metro Labs (Kathmandu; ≤500 patients/day; ~20 branches/collection centres; Autobio, Mindray, Getein analysers; currently on "eLabs"; needs IRD-approved billing)
**Date:** 2026-11-05
**Status of claims:** Every nontrivial claim carries an inline source link to a page actually opened during research, or is marked **UNVERIFIED — needs confirmation**.

---

## Table of Contents

1. [Feature decisions — module by module](#1-feature-decisions--module-by-module)
   - 1.1 Registration & billing
   - 1.2 Samples & barcoding
   - 1.3 Results entry & validation
   - 1.4 Report delivery
   - 1.5 Admin / accounts / commissions
   - 1.6 Dashboard / MIS
   - 1.7 Wishlist modules (micro/molecular/histo, apps, B2B portal, inventory, QC, TAT, queue/CRM/kiosk, loyalty, HR, marketing, smart report, website)
2. [Domain workflows in implementable detail](#2-domain-workflows)
   - 2.1 Specimen lifecycle (rejection, recollection, aliquots)
   - 2.2 Order → worklist → result → validation (auto-verification, delta checks, critical values)
   - 2.3 Microbiology culture & sensitivity
   - 2.4 Histopathology / cytology
   - 2.5 QC workflow (Levey-Jennings + Westgard rules, exact definitions)
   - 2.6 Inventory consumption models
   - 2.7 TAT measurement definitions
3. [Instrument interfacing reality check](#3-instrument-interfacing)
4. [Nepal specifics (2026)](#4-nepal-specifics)
   - 4.1 IRD e-billing / CBMS
   - 4.2 VAT on health services
   - 4.3 Payment rails (eSewa, Khalti, Fonepay)
   - 4.4 SMS gateways
   - 4.5 WhatsApp Business API
   - 4.6 Doctor commission & NMC ethics
   - 4.7 Privacy Act 2075 / Regulation 2077
   - 4.8 Bikram Sambat date handling
5. [Smart Report specification](#5-smart-report)
6. [Consolidated keep/later/integrate/drop table](#6-consolidated-decision-table)
7. [Open questions for the client](#7-open-questions-for-the-client)

---

## 1. Feature decisions — module by module

Legend: **KEEP** = core, build in Phase 1. **KEEP-LATER** = build, but in a later phase. **INTEGRATE** = don't build; wire to an external product/API. **DROP** = recommend against.

### 1.1 Registration & billing — **KEEP (core, Phase 1)**

**What it is / how it works operationally.** The front-desk operator works from one screen: search existing patient (name/mobile/lab code) to avoid duplicate MRNs → confirm demographics → pick visit type (OPD/IPD), payment mode (cash/credit/credit-party), originating collection centre, referring doctor (with quick-add for new doctors, pending back-office verification) → add tests by short code or package → apply discount (reason + approver captured) → take payment (cash/card/wallet/QR/part-payment, with urgent surcharge if STAT) → print letterhead receipt + barcode labels → SMS confirmation fires. This is the standard flow in Indian/Nepali pathology software. [CrelioHealth (ex-LiveHealth)](https://creliohealth.com/us/lis/lis-system/laboratory-information-system) lists front-desk registration ("ID-scan-based registration"), B2B/patient billing and sample barcoding (verified, Pass 1). For [Drlogy](https://www.techjockey.com/compare/drlogy-lab-vs-labsmart), the comparison page shows only "Billing & Invoicing" and "QR Coded Lab Reports"; it does not show a registration-centric front desk or barcoding for Drlogy (**Drlogy front-desk parity UNVERIFIED — needs confirmation**). *(Pass 1: the statement that the client "has already seen it in the eLabAssist/Medizensys demos" is not in 00-scope-baseline.md. It is an assumption, UNVERIFIED — needs confirmation.)*

**Decisions within this module:**
- Patient search + dedupe, quick-add doctor, test short codes, packages, TRF file upload, discount-with-approver, part payment, urgent charge, SMS on registration, letterhead receipt — **KEEP all**. These are table stakes; every competitor has them.
- Payment-method capture (cash/card/eSewa/Khalti/Fonepay QR) — **KEEP**, but build as *payment-method ledger entries* first (operator records how the patient paid), and treat live wallet/QR API integration as a thin Phase-1.5 add-on (see §4.3). Most Nepali labs today just record "paid via Fonepay QR" against the bank's static QR; a live dynamic-QR integration is better but not blocking.
- **Critical constraint:** the receipt/invoice side must be designed for IRD e-billing approval from day one (immutable invoices, no deletion, CBMS sync — see §4.1). Retrofitting this is painful.

### 1.2 Samples: barcode, accept/reject, live status — **KEEP (core)**

Auto-generated barcode per container at registration; phlebotomist collects; accession/receive step at the lab marks sample "received"; technologist can **reject** with a coded reason (haemolysed, clotted, QNS, unlabeled, wrong tube), which triggers recollection (see §2.1). Live status (registered → collected → received → in-process → resulted → verified → reported) is the backbone of the patient app, B2B portal and TAT module later, so model it as an explicit state machine now. Open-source [SENAITE LIMS](https://linuxlinks.com/senaite-enterprise-open-source-laboratory-system) (GPL v2.0) has worksheets (with QC and instrument mapping) and a "verifier" role with status-tied permissions, and is a good free reference implementation to study. *(Pass 1: the cited page confirms the worksheets, the verifier role and the licence. It does not describe the full registration → verification state lifecycle, which is UNVERIFIED — needs confirmation against SENAITE's own docs.)*

### 1.3 Results: analyzer import, previous results, short-codes, formulas, two-step approval, lock, graphs — **KEEP (core)**

All standard LIS behaviour (details in §2.2): analyzer auto-import via ASTM/HL7 (§3); cumulative/previous results displayed beside the entry grid (this is also what powers delta checks); canned-comment short codes; derived/calculated analytes (e.g. LDL by Friedewald, eGFR, A/G ratio) computed by stored formulas; two-step release (technologist enters/first-verifies → pathologist/consultant approves); approved results locked, changes only via a versioned *amended report* path (never in-place edit — medicolegal good practice; **the claim that ISO 15189 requires it is UNVERIFIED — needs confirmation**. Pass 1 found that the previously cited Biochemia Medica paper is about critical-result notification and does not address amended reports); trend graphs from the cumulative history. **KEEP everything here; this plus §1.2 is the heart of the product.**

### 1.4 Reports: hold-until-paid, WhatsApp/email/SMS, doctor+centre copies, merge outsourced PDFs, QR verify, letterhead toggle, bulk release, radiology formats — **KEEP (core), with two notes**

- Hold-until-dues-paid: implement as a *release gate* configurable per lab and overridable per report by an authorised role (labs routinely release to credit parties with dues outstanding).
- QR verification: QR on the PDF encodes a lookup URL carrying a **random ≥128-bit server-stored token** (not a signed/HMAC URL — *Pass 2: aligned with 03 D11 / REQ-ARCH-049 and 02 REQ-SEC-093*) to a public verify endpoint showing report authenticity + issue timestamp with the minimal field set fixed in 04-consolidated-decisions.md — cheap to build, high perceived value, and also your anti-forgery story.
- Merging outsourced PDFs: store the outsourced lab's PDF against the order and concatenate at render time; also support "attachment-type tests" whose result *is* a PDF/image (reused for HbA1c chromatograms, §3.5).
- Radiology formats (X-ray/USG/endoscopy): these are *narrative* reports with embedded images — reuse the histopathology rich-text template engine (§2.4) rather than building a RIS. **KEEP** as template-driven narrative reporting; **do not** attempt PACS/DICOM in Phase 1 (that is a different product; mark DICOM as KEEP-LATER/INTEGRATE).

### 1.5 Admin/accounts — **KEEP (core)**

Roles + account lock; collection centre & doctor master with affiliations; **per-doctor/per-centre price lists with Excel import/export** (this is the single most-used B2B feature in Indian-style lab chains; CrelioHealth's [LIMS feature page](https://creliohealth.com/lims/lims-system/lims-solutions) lists B2B invoice auto-generation, an "organization-wise price list based on their practice type", and locking accounts when credit days are exceeded (verified, Pass 1). The "single most-used B2B feature" ranking is author judgement, not sourced; credit-party billing with monthly statements; daily cash collection report by staff and by payment method (the end-of-day cash tally is how owners catch leakage — non-negotiable).

**Doctor commission tracking:** technically trivial (rate × billed amount per referral, monthly statement), commercially expected in this market — but legally/ethically fraught. See §4.6. **Recommendation: KEEP the *data model* (referral attribution + configurable incentive report), ship it as a neutral "referral business report," do not print the word "commission" on any system document, and put the compliance risk decision in writing with the client.**

### 1.6 Dashboard / MIS — **KEEP (core, thin)**

Income by department, top referrers, pending-test worklist counts, worksheets. Build the 6–8 reports the client named; resist a generic BI builder. KEEP-LATER: export-to-Excel on every report plus a read-replica/SQL access path so a real BI tool (Metabase/Superset) can be bolted on instead of hand-building dashboards forever.

### 1.7 Wishlist modules

| Module | Verdict | Reasoning |
|---|---|---|
| **Microbiology (culture/AST)** | **KEEP-LATER (Phase 2, high priority)** | Fundamentally different data model (isolates, organisms, antibiotic panels, preliminary/final reports — §2.3). Metro Labs runs it, so it's needed for full replacement of eLabs, but shipping core chemistry/haematology first is the right sequencing. Real products (SENAITE, CrelioHealth, Orchard) treat micro as a distinct module. |
| **Molecular (PCR)** | **KEEP-LATER (Phase 2)** | Mostly ordinary quantitative/qualitative results + batch/run concept; low incremental cost once worksheets exist. |
| **Histopathology / cytology / IHC** | **KEEP-LATER (Phase 2)** | Narrative reporting + block/slide tracking (§2.4). The narrative template engine is shared with radiology formats, so build the engine in Phase 1 and the histo-specific accessioning in Phase 2. |
| **Cytogenetics (karyotyping)** | **KEEP-LATER (Phase 3) / probably DROP** | Tiny volume in Nepal; it is a narrative report with images — serve it with the generic narrative module rather than a dedicated cytogenetics module. Confirm actual monthly volume with client. |
| **Bi-directional interfacing (7 instruments)** | **KEEP (phased per instrument)** | See §3. Chemistry/immunoassay bi-directional (host query/worklist) is realistic; haematology is usually uni-directional or query mode; micro ID/AST (VITEK-class) is upload-oriented. Quote per-driver effort; don't promise "all 7 bi-directional" blindly. |
| **Picture/PDF import (HbA1c HPLC, urine, allergy)** | **KEEP (cheap)** | Attachment-type result + optional parsed numeric fields (§3.5). |
| **Patient app + phlebotomy app** | **KEEP-LATER (Phase 2–3)** | High retention value, but the web patient portal (report download + status, mobile-responsive) delivers 80% of the value in Phase 1 for 10% of the cost. Native phlebo app (home-collection routing, sample handover) is Phase 3 unless Metro Labs runs significant home collection — ask. CrelioHealth and Indian competitors do ship patient apps, so it matters for parity eventually. |
| **B2B partner portal (web+app)** | **KEEP-LATER (Phase 2, high priority)** | For a 20-centre chain this is arguably more valuable than the patient app: centres log orders, print barcodes, track samples, download reports, see their rate list and ledger. Web-first; skip the native app initially. |
| **Analyzer-connected real-time inventory** | **KEEP-LATER (Phase 2–3), simplified** | Full real-time reagent telemetry from analysers is vendor-middleware territory and mostly not exposed over ASTM. Build *consumption-model* inventory instead (per-test/per-QC/per-cal deduction driven by LIS result counts — §2.6) plus stock/expiry/PO/wastage. That achieves the business goal (reagent accountability) without fictional integration. |
| **QC module (LJ + Westgard)** | **KEEP-LATER (Phase 2) — but capture QC results from day one** | Parse and store QC-flagged analyzer records from Phase 1 (they arrive on the same interface); ship charts/rules in Phase 2 (§2.5). A lab seeking NABL/ISO 15189 style accreditation will demand this. |
| **TAT management** | **KEEP (thin in Phase 1)** | The state machine (§1.2) already timestamps every transition; Phase 1 ships a pending-list + simple TAT report; Phase 2 adds targets/alerts (§2.7). |
| **Queue / front desk / appointment slots / kiosk** | Queue token: **KEEP-LATER (cheap)**. Appointments: **KEEP-LATER (Phase 3)**. Kiosk: **DROP for now** | A token display is trivial; full appointment/kiosk is a different product surface with low utilisation in walk-in-dominated Nepali labs. Re-evaluate on demand. |
| **CRM** | **REPLACE-WITH-INTEGRATION / DROP** | Keep a campaign-safe export (consented contact list + visit metadata) and let the lab use a real CRM/marketing tool. Building CRM inside a LIMS is scope cancer; *(Pass 1 correction: the cited [CrelioHealth page](https://creliohealth.com/solutions/smart-report/) does **not** present patient engagement as a standalone product. It lists "Patient Experience" as a separate use-case solution in navigation, and Smart Reports itself includes a "Promote Lab Services" section. The premise "vendors sell engagement as separate products" is UNVERIFIED — needs confirmation. The recommendation stands on scope grounds.)* |
| **Loyalty / reward points / coupons / membership** | **KEEP-LATER (Phase 3), minimal** | A simple membership-discount scheme (price-list variant + prepaid wallet) covers most of the ask. Full points engines: DROP unless client insists post-launch. |
| **B2C reminders / document storage** | Reminders: **KEEP-LATER** (follow-up test reminder = cron over "Follow Ups" data, cheap). Generic health-document vault: **DROP** (Swasthall-style product, not LIMS). |
| **HR / salary / leave** | **DROP (integrate)** | Payroll has its own compliance surface (SSF, CIT, TDS in Nepal). No serious LIS ships payroll; point the client to a dedicated HR tool. Keep only *user/staff master + attendance-agnostic activity log* in the LIMS. |
| **Marketing & sales-team management** | **DROP (integrate)** | Field-sales tracking of B2B centres is a CRM job. At most, expose per-centre revenue/MoM reports (already in MIS) that a sales tool can consume. |
| **"Smart AI report"** | **KEEP-LATER (Phase 2–3), rules-based, pathologist-approved** | See §5. Flag: the Healthians-style *supplement upsell* section is commercially/ethically dubious for a diagnostic lab — recommend excluding it. |
| **Website with patient portal** | Portal: **KEEP** (it's the report-delivery surface). Marketing website/CMS: **DROP** — any web agency/WordPress does it; just expose the portal and booking endpoints. |

---

## 2. Domain workflows

### 2.1 Specimen lifecycle (incl. rejection, recollection, aliquots)

Entities: **Order** (visit-level) → **OrderItem/Test** → **Specimen** (physical container, barcode) → **Aliquot** (child specimen derived from a parent). One specimen can serve many tests (serum tube → ~20 chemistry tests); one test can need multiple specimens (e.g. GTT timed draws).

State machine (every transition timestamped + user-stamped):

```
ORDERED → COLLECTED → IN_TRANSIT (from collection centre) → RECEIVED/ACCESSIONED
        → (optional) ALIQUOTED → IN_PROCESS → RESULTED → VERIFIED(1) → APPROVED(2) → REPORTED
Any pre-APPROVED state → REJECTED(reason code) → RECOLLECTION_ORDERED (new specimen row,
        linked to original; tests re-point to new specimen; rejection logged for QC indicators)
Terminal extras: STORED (retention location), DISCARDED (with retention-policy date)
```

Rules a coding agent must honour:
- Rejection requires a coded reason (haemolysis, clot, QNS, mislabel, wrong container, delayed transport) + free text; it must notify the originating centre/phlebotomist and appear in the rejection-rate MIS. Rejection rate as a standard pre-analytical quality indicator is **UNVERIFIED — needs confirmation** (Pass 1: the previously cited Biochemia Medica 2019 paper does not discuss sample rejection, and the IFCC post-analytical QI paper defers pre-analytical QIs to a separate publication that was not opened).
- Recollection creates a **new** barcode; never reuse the rejected one.
- Aliquots inherit patient/order linkage and carry their own barcode; tests are assignable at aliquot level (needed for send-outs and for separating chemistry vs immunoassay runs from one primary tube).
- Collection-centre transit: scan-out at centre, scan-in at hub; the delta is transport TAT and feeds sample-tracking in the B2B portal.

### 2.2 Order → worklist → result → validation

1. **Order entry** (registration or B2B portal) creates OrderItems with test master metadata (specimen type, department, method, price, TAT target).
2. **Worklist**: per-department queue of received, unresulted specimens. For bi-directional instruments, the LIS *is* the worklist source: the analyser queries the LIS by barcode (host query) or the LIS downloads the pending list (§3).
3. **Result capture**: analyzer import (flag auto vs manual origin), manual entry, calculated analytes (formula engine over sibling results: e.g. LDL = TC − HDL − TG/5 when TG < 400 mg/dL — store formulas in the test master, not code).
4. **Validation layer**, evaluated at result arrival:
   - **Range flags**: L/H vs age/sex-specific reference ranges; critical flags vs a separate critical-range table.
   - **Delta check**: compare with the patient's previous value of the same analyte within a configured window (e.g. 7 days for electrolytes, 30 for lipids); flag if |Δ| or %Δ exceeds the analyte's delta threshold. Thresholds are per-analyte configuration, set by the lab director. *(Standard practice widely described in laboratory auto-verification literature; exact thresholds are lab policy — mark defaults as suggestions, UNVERIFIED as universal values.)*
   - **Auto-verification**: a result auto-passes first verification only if: instrument sent no error/abnormal flags, result within auto-verify limits (narrower than reportable range), no critical flag, no delta failure, QC for that analyte in-control on that run (ties to §2.5). Anything else drops to manual review. This mirrors CLSI AUTO-series practice — **the exact CLSI AUTO10/AUTO15 text is paywalled; treat our rule list as industry-standard practice, UNVERIFIED against the standard's letter.**
   - **Critical value workflow**: critical result → immediate task for technologist → phone/SMS the referring clinician → record who was notified, by whom, when, and read-back confirmation. ISO 15189:2012 requires labs to establish a critical-result notification protocol and evaluate it periodically ([Delgado Rodríguez et al., Biochem Med 2019;29(3):030703](https://biochemia-medica.com/en/journal/29/3/10.11613/BM.2019.030703), verified Pass 1; that paper also uses CLSI GP47 notification-TAT bands: <15 min timely, 15–60 min acceptable, >60 min inappropriate). The previously cited [Thieme PDF](https://www.thieme-connect.de/products/ejournals/pdf/10.1055/s-0043-1775573.pdf) could not be opened (bot wall), so it is UNVERIFIED. The LIS must store the notification log on the order.
5. **Two-step release**: technologist verify → pathologist approve. Approved = locked; corrections create an **amended report** (new version, old version retained and marked superseded; the printed amendment states what changed).

### 2.3 Microbiology culture & sensitivity — why it's a different module

Data model: Specimen → **Culture** (media, incubation) → 0..n **Isolates** → each isolate gets an **Organism** (coded; use a SNOMED-CT-derived organism list or a curated local list) → each organism gets an **AST panel** (antibiotic list chosen by organism group + specimen site) → per-antibiotic result = raw measurement (zone diameter mm for disk diffusion, or MIC µg/mL) + **interpretation**. *(Pass 1 correction: CLSI categories are not only S/I/R. They also include **SDD** (susceptible-dose dependent) and **NS** (nonsusceptible), and **WT/NWT** applies when an ECV is used, with no S/I/R category assigned. EUCAST redefines "I" as "susceptible, increased exposure". *Pass 3 (CLSI primary):* CLSI also uses **I^** (agents concentrated in urine, since 2020) and an I/R-only scheme for colistin/polymyxin B; CLSI's "I" is not "susceptible, increased exposure" (that is EUCAST's meaning). Code set: CLSI S/SDD/I/I^/R/NS; EUCAST S/I/R; ECOFF WT/NWT. The data model stores category code + interpretive standard (CLSI/EUCAST) + version with each interpretation (04 D14). The interpretation field must therefore be an extensible coded set, not a 3-value enum. Source: [Mayo Clinic Labs interpretive category definitions](https://www.mayocliniclabs.com/it-mmfiles/Susceptibility-Interpretative-Category-Definitions.pdf).)*

Workflow:
```
Day 0: specimen received → plated (media per specimen-type SOP), Gram stain resulted same day
Day 1: growth check → "No growth at 24h" preliminary OR colonies → presumptive ID started
Day 1–2: ID (biochemical / VITEK-class automated ID) + AST set up
Day 2–3: AST read → interpret vs breakpoints → FINAL report
Negative cultures: "No growth after 48h/72h/5d" final per specimen SOP (blood cultures longer)
```

Implementation requirements:
- **Preliminary vs final reports**: micro reports are issued multiple times for one order (Gram stain prelim → growth prelim → final with AST). The report engine must support versioned, cumulative micro reports clearly labelled PRELIMINARY/FINAL.
- **Breakpoints**: interpretation comes from CLSI M100 tables (organism × antibiotic → zone/MIC breakpoints). The current edition is **M100-Ed36, published 26 Jan 2026**, which replaced Ed35 (2025) ([CLSI M100 page](https://clsi.org/shop/standards/M100), verified Pass 1). The annual cadence is inferred from consecutive editions; the CLSI page does not state it. *(The **specimen-site** dimension, e.g. meningitis vs non-meningitis breakpoints, is not stated on the CLSI page and is UNVERIFIED — needs confirmation from the M100 tables. Design the lookup key to allow it anyway.)* Automated systems (e.g. bioMérieux VITEK 2) produce MICs, and its **Advanced Expert System** does interpretive reading of resistance phenotypes and mechanisms ([Livermore et al., J Antimicrob Chemother 2002;49(2):289–300](https://ueaeprints.uea.ac.uk/33500), verified Pass 1). Results go to the LIS over the **BCI (bidirectional computer interface)**. A document titled "Bidirectional Computer Interface Specification for VITEK" circulates on Scribd ([copy 1](https://www.scribd.com/document/491726048/Protocol-Bci), [copy 2](https://www.scribd.com/document/491725890/Dokumen-tips-Vitek-Bci)), but its contents could not be read in Pass 1. **What the BCI uploads and downloads is UNVERIFIED — obtain the official bioMérieux BCI spec under the client's service contract.** Design decision: store raw value + interpretation *as received from the instrument*, and keep a manual breakpoint table only for disk-diffusion manual entry; do **not** attempt to re-implement full CLSI expert rules in v1 (licensing + annual maintenance burden). Mark "LIS applies CLSI breakpoints automatically for manual AST" as **KEEP-LATER** with a maintained lookup table the lab's microbiologist owns.
- **Cascade/selective reporting** (suppress broad-spectrum agents when narrow ones are susceptible) is a desirable Phase-3 rule engine; antimicrobial-stewardship practice, lab-configurable.
- MIS must support cumulative antibiogram export (organism × antibiotic %S per year).

### 2.4 Histopathology / cytology workflow

```
Accession (histo number series separate from lab number) → Grossing (macro description,
measurements, # of pieces) → Cassettes/BLOCKS (each barcoded, e.g. S26-1234-A1) →
Processing/Embedding → SLIDES per block (stains: H&E default; special stains, IHC as
added orders on existing blocks) → Microscopy → Narrative report (gross + microscopy +
impression/diagnosis ± synoptic fields) → Pathologist sign-out → (optional) amended report
Cytology: similar but specimen → smears/cell block; Pap reporting uses Bethesda categories.
```
Implementation notes:
- Block/slide registry with counts is what distinguishes a histo module from "a big text box": the lab must be able to answer "where is block A3 of S26-1234" (storage/retrieval, send-out for IHC/second opinion).
- Reports are rich-text templates with placeholders (gross, micro, impression), per-specimen-type template library, and diagnosis coding: full SNOMED CT licensing is overkill for Phase 2 — use a local coded diagnosis list with optional SNOMED-style topography/morphology fields, and mark formal SNOMED CT adoption **UNVERIFIED/deferred** (SNOMED licensing status for Nepal needs checking — Nepal is not obviously a SNOMED member; confirm before promising).
- IHC is ordered *on an existing block*, creating new slides and an addendum report section.

### 2.5 QC workflow — Levey-Jennings and Westgard rules (verified definitions)

Setup: per analyte × instrument × control level (usually 2–3 levels), establish mean and SD from ≥20 baseline runs (the "≥20" minimum is common practice but was not found in the Pass 1 sources — UNVERIFIED); plot each QC result on a **Levey-Jennings chart**: x-axis time/run, y-axis value, horizontal lines at mean, ±1SD, ±2SD, ±3SD ([rule and chart definitions verified here](https://open-exam-prep.com/study-guides/amt-mlt/ch7/quality-control-westgard)).

Westgard multirule definitions. Pass 1 re-verified them against the primary source [Westgard QC — multirule page](https://www.westgard.com/mltirule.htm) and [westgard.com Westgard Rules](https://westgard.com/westgard-rules.html); the "error indicated" column comes from the secondary [open-exam-prep guide](https://open-exam-prep.com/study-guides/amt-mlt/ch7/quality-control-westgard), because the westgard.com pages opened do not map individual rules to error types:

| Rule | Exact definition | Type | Error indicated |
|---|---|---|---|
| **1-2s** | One control observation exceeds mean ± 2SD | **Warning**: "used as a warning rule to trigger careful inspection of the control data by the following rejection rules"; alone does not reject | — |
| **1-3s** | One control observation exceeds mean + 3SD or mean − 3SD | Rejection | Random error |
| **2-2s** | Two consecutive control observations exceed the **same** +2SD or same −2SD limit. (Applying it both across levels within one run and for the same level across runs is common practice; westgard.com's text does not spell this out — UNVERIFIED as to the letter of the rule.) | Rejection | Systematic shift |
| **R-4s** | **Pass 1 correction:** one control measurement in a group exceeds mean **+2SD** and another exceeds mean **−2SD**. Westgard: "this rule should only be interpreted within-run, not between-run." Do **not** implement it as "range > 4SD" generically (e.g. +3.5SD and −0.6SD has a range > 4SD but is not an R-4s violation by Westgard's definition; it is caught by 1-3s). | Rejection | Random error / imprecision |
| **4-1s** | Four consecutive observations exceed the same +1SD or same −1SD limit; often applied **across runs** (and across materials) | Rejection | Systematic shift/trend |
| **10x** | Ten consecutive observations fall on the same side of the mean; "usually has to be applied across runs and often across materials" | Rejection | Systematic shift |

*Pass 1 implementation note (westgard.com):* in the **classic** multirule, 4-1s and 10x are evaluated only after a 1-2s warning has fired. In the **modern** version they are evaluated independently. Make this a per-lab configuration flag and default it explicitly.

Workflow in the LIS: QC results arrive on the analyzer interface flagged as QC (ASTM: control sample ID / Q-type records; depends on driver) → evaluate rules **in real time** per point → in-control: release run; violation: mark run out-of-control, **hold auto-verification of patient results for that analyte since the last in-control QC**, require technologist corrective-action record (recalibrate, new control vial, maintenance) + rerun QC before release. Store the corrective-action log — accreditation assessors ask for it. Real-time LJ per analyser is exactly what the client asked for and is standard in serious LIS products.

### 2.6 Inventory consumption models

Three deduction models, configured per item–instrument–test mapping:
1. **Per-test (per reportable)**: each verified result of test T on instrument I deducts the mapped reagent quantity (e.g. 1 glucose result = 1 "test" of glucose reagent). Driven by LIS result counts — no analyser telemetry needed.
2. **Per-calibration**: each calibration event (manually logged or inferred from calibrator-flagged interface records) deducts calibrator + N reagent tests.
3. **Per-QC**: each QC run deducts control material + reagent per level.
Plus: lot/expiry tracking (FEFO issue), stock locations per branch, reorder level → draft purchase order, **wastage** = physical count − book stock at cycle count (variance report per item/branch). "Real-time analyser-connected inventory" in vendor marketing is almost always this consumption-count model, not live reagent-level telemetry; true onboard-reagent telemetry requires vendor middleware and is **not** generally available over the ASTM/HL7 result stream — set that expectation with the client. *(Telemetry claim: UNVERIFIED per specific Autobio/Mindray models — confirm with local distributors what their middleware exposes.)*

### 2.7 TAT measurement definitions

Define TAT segments explicitly. The literature distinguishes multiple start/stop anchors. *Pass 1 correction:* the previously cited Biochemia Medica 2019 paper covers critical-result notification TAT only. The replacement source, the IFCC post-analytical QI paper ["Performance criteria and quality indicators for the post-analytical phase", Clin Chem Lab Med 2016;54(7):1169–1176](https://www.research.unipd.it/retrieve/e14fb26e-d558-3de1-e053-1705fe0ac030/10.1515_cclm-2015-0897.pdf), states that QI use in the post-analytical phase "is required by ... ISO 15189:2012". Its TAT indicators are **% of reports delivered outside the specified time** and **90th-percentile TAT for STAT potassium (plus INR, WBC, troponin)**. The claim that "received→reported is the most common accreditation indicator" is UNVERIFIED — needs confirmation.
- **Pre-analytical TAT**: order/collection → received at lab (captures collection-centre transport).
- **Within-lab (analytical) TAT**: received → first verified result.
- **Total/report TAT**: registration (or collection) → report released to patient.
Per test master: target TAT (routine) + STAT target. Report: median and 90th-percentile TAT per test/department/branch, % within target, outlier list. Pending-beyond-target alert list for the floor supervisor. All derivable from the §2.1 state-machine timestamps — no extra data capture needed.

---

## 3. Instrument interfacing

### 3.1 What the protocols actually give you

- **ASTM E1394 / CLSI LIS2-A2** (message content) over **ASTM E1381 / LIS1-A** (low-level serial/TCP framing): record types H (header), P (patient), O (order), R (result), C (comment), Q (request information/query), L (terminator), plus **S (scientific)** and **M (manufacturer information)**. The [CLSI LIS2-A2 preview](https://webstore.ansi.org/preview-pages/CLSI/preview_LIS2-A2.pdf) (verified Pass 1) lists these record sections and states "LIS2 is a revision of the former ASTM E1394-97", with low-level transfer delegated to LIS1. The claim that ASTM is "still the dominant protocol on benchtop analysers" is author judgement and UNVERIFIED. **Pass 1 correction:** the two Mindray documents previously cited as ASTM examples are **HL7 v2.3.1** manuals, not ASTM. The [Mindray BC-5380 LIS doc (Scribd copy)](https://www.scribd.com/document/562151986/LIS-BC5380) specifies HL7 2.3.1 over **TCP/IP with MLLP framing**. The [Mindray BS-120/BS-200 doc (Scribd copy)](https://www.scribd.com/document/467496962/Comunicacion-BS120-BS200-pdf) specifies the Mindray HL7 interface (Ver. 2.3.1), with <VT>…<FS><CR> MLLP-style framing. (**Scribd copies are secondary; get official "Host Interface Manual" PDFs from the Mindray/Autobio distributors. "They hand them out routinely" is UNVERIFIED.**) The driver layer must therefore support **both ASTM and HL7/MLLP** from the first sprint.
- **HL7 v2.x** (commonly 2.3.1–2.5.1) on newer analysers and middleware: **ORU^R01** (unsolicited result), **ORM^O01 / OML^O21** (order/worklist download), **QBP/QRY** (host query). *(Pass 1 correction: the cited example contradicts "HL7-only".)* The [Cepheid GeneXpert LIS guidance](https://www.cepheid.com/content/dam/www-cepheid-com/documents/documents/302-training-materials/303-3391%20Rev.%20A%20LIS%20Guidance%20Xpert%20Xpress%20GBS%20US-IVD.pdf) gives **both** ASTM example messages (H/O/R/L) and HL7 v2.5 examples (ORU^R32^ORU_R30), so molecular instruments may offer either protocol. Message types vary by vendor: Mindray's host query uses ORM^O01 → ORR^O02 (BC-5380) or QRY^Q02 → QCK^Q02/DSR^Q03 (BS-120/200), not QBP, per the Scribd copies above.
- **"Bi-directional"** means the analyser receives test orders from the LIS, two styles:
  1. **Host query mode**: instrument reads the tube barcode, sends a Q record / QBP to the LIS, LIS replies with the pending test list for that sample within ~seconds. This is the operationally best mode (no manual programming at the instrument).
  2. **Worklist/batch download**: LIS pushes pending orders (O records / ORM) ahead of time.
  Uni-directional = results upload only; the operator programs tests at the instrument keypad.

### 3.2 Per-instrument reality (Metro Labs fleet)

| Instrument class | Typical connectivity | Notes |
|---|---|---|
| Mindray BC-series haematology (e.g. BC-5380) | **Pass 1 correction:** the BC-5380 LIS doc specifies **HL7 v2.3.1 over TCP/IP + MLLP**, with bidirectional host inquiry (ORM^O01 query → LIS replies ORR^O02). ASTM support on other BC models is UNVERIFIED. | Verify per exact model via the official Mindray LIS manual ([secondary copy of BC-5380 LIS doc](https://www.scribd.com/document/562151986/LIS-BC5380)) (UNVERIFIED from primary — unofficial Scribd copy only; 05 T11). Haematology also sends histogram/scattergram data; decide whether to store it (useful for report graphics, large payloads). Whether this payload is in the BC-5380 HL7 feed is UNVERIFIED. |
| Mindray BS-series chemistry (BS-240 etc.) | **Pass 1 correction:** the BS-120/200 doc describes an **HL7 v2.3.1** interface (not ASTM). It is bi-directional: results via ORU^R01, and sample info downloaded "in real-time or batch mode" via QRY^Q02 → QCK^Q02 + DSR^Q03 ([secondary copy](https://www.scribd.com/document/467496962/Comunicacion-BS120-BS200-pdf)) (UNVERIFIED from primary — unofficial Scribd copy only; 05 T11). BS-240 specifically is UNVERIFIED. | Best candidate for full host-query automation (based on BS-120/200 doc; confirm for the actual model). |
| Autobio chemistry/immunoassay (A-series, AutoLumo) | ASTM-style host interface; bi-directional support claimed by vendor. **UNVERIFIED — no public official LIS manual located.** Pass 1 found that a document titled "AutoLumo LIS Communication Protocol V1.4" is listed on Scribd, but its contents could not be read. **Request the "LIS/Host Interface Manual" from Autobio's Nepal distributor before quoting bi-directional.** | Plan serial-to-TCP capture box or middleware PC per bench. |
| Getein immunofluorescence POCT (Getein 1100/1600) | Typically **uni-directional** result upload (serial/USB/LAN, ASTM-ish or proprietary line protocol). **UNVERIFIED — confirm model + protocol doc with distributor.** | POCT devices rarely do host query; plan upload-only + barcode match. |
| Urine analyser | Uni-directional ASTM upload is the norm; semi-quant results (nitrite 1+/2+ etc.) need ordinal result support in the data model | Confirm model. |
| Microbiology ID/AST (VITEK-class) | bioMérieux **BCI** bidirectional interface. The claimed payload (upload of ID + AST: organism, per-antibiotic MIC + interpretation; optional demographics download) is **UNVERIFIED**: the [Scribd copy](https://www.scribd.com/document/491726048/Protocol-Bci) was unreadable in Pass 1 | Ask which ID/AST system Metro Labs actually has — "VITEK-style" was assumed; Autobio also sells an ID/AST line. |

### 3.3 Architecture recommendation

Cloud LIMS + **on-prem interface agent** per lab site: a small service (*Pass 2:* Windows 10/11 or Server 2016+ PC — the Go agent chosen in 03 D12 cannot run on older Windows, per [Go 1.21 release notes](https://go.dev/doc/go1.21); a Linux build is deferred until Linux equivalents of the 02 §6 controls are specified) that speaks serial/TCP to instruments, implements per-driver ASTM/HL7 parsing, buffers store-and-forward (labs lose internet; results must not be lost), and syncs to the cloud over HTTPS with idempotent upserts at two levels (*Pass 2, aligned with 03 §6.4*): message-level dedupe on (instrument, MSH-10) for HL7 or (instrument, sha256(raw)) for ASTM, and result-level uniqueness on (instrument, sample ID, analyte, instrument result timestamp). Write drivers as config-driven mappings (analyte code ↔ LIS test code, unit conversion, flag mapping). Budget realistically: **first driver ~2–4 weeks, subsequent ASTM drivers days-to-a-week each**, dominated by on-site testing time with the actual instrument. (Effort figures are engineering judgement, not sourced.)

### 3.4 What to tell the client about "7 instruments bi-directional"

Commit to: results upload for all interfaced instruments; host-query bi-directional **where the instrument supports it** (Mindray BS and BC likely, given the HL7 host-query support in the unofficial BS-120/200 and BC-5380 copies — UNVERIFIED from primary until the official Mindray manuals are obtained; others pending official manuals). Put "pending vendor interface documentation" in the contract per instrument.

### 3.5 Picture/PDF import (HbA1c HPLC chromatograms, urine microscopy images, allergy panels)

Pragmatic pattern used industry-wide: define **attachment-bearing tests** — numeric fields entered/interfaced as usual, plus 1..n image/PDF attachments rendered inline in the report. Sources: HPLC analysers export chromatogram PDFs/images to a shared folder or print-to-PDF; the interface agent watches a folder per instrument, matches by sample ID in filename or by operator pick-list. Don't promise automatic parsing of chromatogram PDFs; the numeric HbA1c value comes over the normal result channel or manual entry, the picture is evidentiary.

---

## 4. Nepal specifics

### 4.1 IRD e-billing / CBMS — **the hardest compliance gate; design for it from day one**

Legal basis: VAT Act 2052 s.14A + IRD's e-invoice procedure. *Pass 1:* the date **2074.09.16** appeared only as the filename of an IRD PDF linked in the Frappe thread ("computer billing directive_2074.09.16"); the [Pioneer Law summary](https://pioneerlaw.com/?p=551) does not mention a 2074 instrument. *Pass 3 (IRD primary):* the current instrument is the **Electronic Invoice Procedure (विद्युतीय बीजक सम्बन्धी कार्यविधि), 2074**, in force 2074/09/16 (4th amendment 2076/09/09), made under VAT Act s.14A ([IRD PDF](https://www.ird.gov.np/public/pdf/175356524.pdf)); see 05 T3 and 04 L1–L6, L26. The 2072 Procedure is superseded in practice (express repeal UNVERIFIED). Requirements under the 2074 Procedure and the VAT Act:
- *(Pass 3)* software must be **listed with IRD** on the basis of the manufacturer's self-certification (Annex 1, cl.3(ख)); the LIMS provider gives each user an Annex 2 approval letter (cl.3(ग)); IRD may inspect/test at any time (cl.9). *(The historical 2072 Procedure, per Pioneer Law, described this as a one-time developer certification.)*
- **each taxpayer (lab) applies to its tax office (Annex 3) for permission** to use the software (cl.4);
- *(Pass 3, VAT Act s.29(1)(g2)/(c), IRD English text):* **NPR 500,000 fine on the taxpayer (the lab)**, approved or not, found using software that can delete or correct data; NPR 10,000 for not issuing an invoice (NPR 1,000 per time is the buyer's fine for not taking one).

The LIMS provider, as developer, therefore needs its software listed with IRD (self-certification). This is in addition to each lab's permission from its tax office. Requirements as implemented by software vendors who have actually obtained IRD approval (verified from a vendor compliance thread that quotes the directive; [Frappe/ERPNext Nepal compliance thread](https://discuss.frappe.io/t/compliance-requirement-that-must-be-fulfilled-to-get-approval-from-tax-authority-in-nepal/34532), corroborated by an [ERPNext team that completed IRD approval](https://discuss.frappe.io/t/finally-got-approval-for-e-billing-from-ird-nepal-erpnext-v13-28-saas/93072) and by the existence of an [Odoo Nepal CBMS e-billing module](https://apps.odoo.com/apps/modules/18.0/l10n_np_cbms_ebilling)):

- **No deletion of invoices** once recorded — cancellation only; cancelled invoices remain viewable/printable.
- **Reprints marked** "copy/duplicate" and must show the print count of the original.
- **Full per-user audit trail / activity log.**
- **Chronological invoice numbering** (the thread's wording is "chronological order"); invoice data available as a printable register. *(Pass 2: "gapless" is **not** in the source — it is a design choice adopted as the safe superset (03 D9), **UNVERIFIED as a legal requirement**. Separately, the Pioneer Law summary of the 2072 Procedure — NPR 500,000 fine for software that permits modifying or deleting invoice data — supports **no edit and no delete** of issued invoices; corrections only by cancellation/credit note. *Pass 3:* now confirmed from primary text — VAT Act s.29(1)(g2) and Procedure 2074 cl.6(ख)/(ट); the Procedure requires serial numbering per fiscal year (cl.6(ङ)) and is silent on gaps.)*
- **Real-time sync of every invoice to IRD's CBMS** (Central Billing Management System) via IRD's API. *(Pass 3: real-time CBMS sending is mandatory for taxpayers IRD designates by notice (Procedure 2074 cl.4(ङ), 8(ग)); all software must be capable of it by web service/Web API (cl.6(ण)).)*
- *(Pass 3, Procedure 2074 cl.6)* also required: SQL-capable DBMS; activity log + backup/recovery; every record carries timestamp, active-status flag and user; export to Excel/XML/PDF; Nepali or English user manual + in-app help; corrections only by ending the old record's validity and creating a new record (no deletion).
- **Sales register / purchase register** reports with prescribed columns (SN, date, invoice no., customer name + PAN, total, exempt sales, taxable sales, tax).
- Support for **normal tax invoice** and **abbreviated tax invoice** (tax-inclusive, not usable above NPR 5,000). *(Pass 1: the NPR 5,000 limit comes from the 2018 Frappe thread. It may be **OUTDATED** and its current value is UNVERIFIED — needs confirmation.)*
- **Pass 1 addition (OUTDATED-risk):** the **46th amendment to the VAT Rules (2081)** revised Schedules 5, 5A and 6 (standard, simplified and summary tax invoice formats). Invoices must now show at least the first 4 digits of the HS code and the item's customs-declared model/brand, and registered computer-billing vendors must update their software ([BizSewa, Jul 2024](https://bizsewa.com/?p=4605)). For lab services the HS-code field may be inapplicable or blank — UNVERIFIED, so confirm with the auditor.
- **Dual calendar:** both Nepali (B.S.) and English dates shown in the software, plus statutory books (sales, purchase, credit note and debit note books; VAT return/Maskebari; Annexure-13). Source: requirements listed by an [ERPNext team that obtained IRD approval (Aug 2022)](https://discuss.frappe.io/t/finally-got-approval-for-e-billing-from-ird-nepal-erpnext-v13-28-saas/93072). This is a vendor post, not IRD text.
- Approval process: the *taxpayer* (lab) applies to IRD for permission to use the software; the software is listed/verified by IRD — exact current submission checklist (forms, demo, source escrow?) **UNVERIFIED — obtain the current directive text and CBMS API doc directly from IRD (ird.gov.np) before the billing sprint**; an IRD PDF exists at [ird.gov.np](https://www.ird.gov.np/public/pdf/175356524.pdf) (not readable in Pass 1; read in Pass 3 — it is the Electronic Invoice Procedure 2074) and background explainers at [TechSathi](https://techsathi.com/what-is-an-e-billing-system-software-businesses). *Pass 1:* TechSathi (published 13 Jun 2022) lists the vendor submission package as: request form + pen drive with setup file, 20 bill samples, specifications, backup system, user manual, **CBMS test-server report** and server agreement. It also says IRD had listed 450+ e-billing products. This is 2022 secondary information, so it may be OUTDATED.
- Mandatory-use thresholds have been announced by turnover tiers over the years. *Pass 1 (secondary only; no IRD notice found in Pass 3 — UNVERIFIED):* the reported current threshold is **annual turnover above Rs 200 million (20 crore)**, lowered from Rs 250 million by an IRD directive in April 2026 (Chaitra 27 decision / Baisakh 4 directive), with banks and financial institutions exempt ([ICT Frame, 19 Apr 2026](https://ictframe.com/?p=114453); [Ratopati, 19 Apr 2026](https://english.ratopati.com/story/59617)). Earlier tiers (e.g. Rs 10 crore from Shrawan 2079 per TechSathi) are superseded or inconsistent across sources. *(Pass 3, IRD primary notices: 2079/02/20 → mandatory from 2079/04/01 above Rs 10 crore (hotels/restaurants/ISPs Rs 5 crore); 2079/08/07 adds alcohol/tobacco makers; an undated CBMS notice makes registration mandatory above Rs 35 crore. Obtain the current notice from IRD.)* Metro Labs may or may not be over the current threshold, but the client *requires* IRD-approved billing regardless.

**Engineering implications:** immutable invoice table (append-only, cancellation rows), print-count counter, CBMS sync queue with retry + offline tolerance, fiscal-year (B.S.) invoice series (see §4.8), and per-tenant IRD registration data. Multi-tenant note: IRD approval has two parts (*Pass 3, Procedure 2074*). The software is listed with IRD on the manufacturer's self-certification (cl.3), and each taxpayer applies to its tax office for permission (cl.4, Annex 3). Each lab customer will therefore need its own permission; make onboarding collateral for that (Annex 2 letter + Annex 3 application). *Pass 3:* SaaS is expressly provided for in Procedure 2074 cl.7(ख): server operator registered in Nepal, server in Nepal, IRD notified + given access, multi-tenancy with each taxpayer's data stored separately, and an Annex 7 tripartite contract (the LIMS provider / DC operator / each lab) filed with IRD. Ask IRD how "access" and "stored separately" are interpreted (04 D16/B17: until then, billing/invoice tables must be isolatable per tenant).

### 4.2 VAT treatment of health services

Nepal's standard VAT rate is 13%. Pass 1 confirmed this in primary text: VAT Act 2052, s.7(1) says "the flat rate of thirteen percent" ([IRD English text](https://www.ird.gov.np/public/pdf/1140227555.pdf)); s.5(3) exempts Schedule 1 items. Health services are listed among exemptions by secondary guides: [BizSewa VAT rates FY 2082/83](https://bizsewa.com/?p=807) ("Social welfare services including medicine, medical services…") and [Samriddhi Foundation VAT overview](https://repository.samriddhi.org/paying-taxes/federal-taxes/value-added-tax/) ("Medicine, Medicinal and similar health services"). **Pass 1 found an important caveat:** an English copy of Schedule 1, Group 5 ("Medicine, Medical and Similar Health services") hosted by [ICNL](https://www.icnl.org/wp-content/uploads/Nepal_Value.pdf) reads **"Health services (other than health services provided by the institutions registered with the value added tax)"**. That copy may not be current, and Schedule 1 is amendable by Gazette under s.42. The schedule has no entry specifically for pathology or diagnostic labs. **Current Schedule 1 wording remains UNVERIFIED — needs confirmation. Whether a VAT-registered lab's services are exempt is genuinely in question.** Practical consequence if confirmed: lab test invoices are *exempt* (no 13% VAT line), but the billing engine must still support VAT for any taxable sales (e.g. selling consumables, non-health services) and must report exempt vs taxable columns in the sales register (§4.1). **Action: have the client's auditor confirm the exact Schedule 1 entry for diagnostic lab services before invoice formats are frozen.** *Pass 3:* IRD's revenue-heading list has a separate **Health Service Tax** (स्वास्थ्य सेवा कर, code 11442) on health services by non-government/non-community institutions. Its applicability to labs and its rate are UNVERIFIED → client's auditor (04 L25); the billing engine must support an additional per-line tax type besides VAT. Finance Bill 2081 also removed some Group-5 goods (incl. diagnostic kits HS 3002.90.10) from Schedule 1, so kit/reagent sales may be taxable.

### 4.3 Payment rails

- **eSewa ePay v2** (verified from [official developer docs](https://developer.esewa.com.np/pages/Epay-V2)): browser form-POST to `https://epay.esewa.com.np/api/epay/main/v2/form` with fields signed by **HMAC-SHA256 over `total_amount,transaction_uuid,product_code`** (comma-separated `field=value` string, Base64 output) using the merchant secret; unique `transaction_uuid` (alphanumeric **and hyphen** allowed, per docs); `success_url`/`failure_url`; success redirect carries a Base64 payload whose signature you must recompute; **server-side status check** at `…/api/epay/transaction/status/?product_code=&total_amount=&transaction_uuid=` returning PENDING/COMPLETE/FULL_REFUND/PARTIAL_REFUND/AMBIGUOUS/NOT_FOUND/CANCELED (the docs table misspells "AMBIGIOUS"; match both). The status check can also fail with `code: 0` / "Service is currently unavailable", so treat that as retry, not failure. UAT status endpoint: `https://uat.esewa.com.np/api/epay/transaction/status/`. A UAT sandbox with a published test key exists. (All re-verified Pass 1; the docs do not state the UAT *form* URL, which is UNVERIFIED.)
- **Khalti KPG-2** (verified from [official docs](https://docs.khalti.com/khalti-epayment)): server-side `POST https://khalti.com/api/v2/epayment/initiate/` (sandbox `dev.khalti.com`) with `Authorization: Key <secret>` (the docs' code samples use lowercase `key`); amount in **paisa** (minimum Rs 10 = 1000 paisa); returns `pidx` + `payment_url` + `expires_at`/`expires_in` (sample shows 1800 s; docs say the production link expires in 60 minutes by default — always read expires_at); after redirect-back you must `POST /epayment/lookup/` with `pidx` and **treat only `Completed` as success** — docs explicitly say the callback is not final validation. Treat `User canceled` and `Expired` (HTTP 400) as failed; the docs' prose also names "Canceled"/"Failed", so match those strings too. Hold `Pending`, `Initiated`, `Refunded`, `Partially Refunded` (all HTTP 200) and any unlisted status and escalate them; do not auto-fail them and never use HTTP status as the success signal (re-verified Pass 1; *Pass 2: exact status strings aligned with 02 §2, re-checked on docs.khalti.com 2026-11-05*). That lookup-after-callback pattern plus unique `purchase_order_id` is your idempotency story.
- **Fonepay**: *(Pass 1 correction: the earlier "NCHL/Fonepay" wording conflated two separate rails.)* Fonepay offers a **Dynamic QR** (per-sale QR with amount + merchant details and real-time confirmation). Per [Fonepay's own blog](https://fonepay.com/blogs/fonepay-dynamic-qr-code), merchants open an account with a Fonepay partner bank and "request to enable the Fonepay Dynamic QR feature via your bank". NCHL's **NepalPay** dynamic QR is a separate rail ([community discussion](https://github.com/yarsa/nepal-compliance/discussions/98)). **No public Fonepay API/webhook doc was found — webhook existence and API details are UNVERIFIED; obtain Fonepay's merchant API spec via the lab's bank.** Interim: record static-QR payments as a manual payment method (reconciled from bank statement).
- Design: `payments` table with idempotency key = (gateway, gateway_txn_id); all gateways verified server-side before receipt marked paid; part-payments as multiple payment rows against one invoice.

### 4.4 SMS gateways

- **Sparrow SMS**: REST API with token auth; official site confirms REST API + sender-ID control, full parameter docs at docs.sparrowsms.com ([Sparrow SMS gateway/API page](https://sparrowsms.com/services/sms-gateway-api/)). A community wrapper ([multi-gateway PHP package](https://packagist.org/packages/rupeshdahal/nepali-sms-gateway); supports Sparrow, Aakash and FastSMS) configures `SPARROW_SMS_TOKEN` and `SPARROW_SMS_FROM` and passes the number and message as arguments. The `token/from/to/text` wire parameter names are plausible but UNVERIFIED against [Sparrow's Push SMS doc](https://docs.sparrowsms.com/sms/outgoing_sendsms/), which was not opened in Pass 1. *(Pass 1 correction: the cited [Sparrow article on sender IDs](https://sparrowsms.com/?p=95072) does not use the term "identity" and does not mention telcos or NTA.)* It says only that business verification may be required "by local regulations" and that alphanumeric sender IDs may be restricted in some places. **Who approves sender IDs in Nepal (gateway/telcos/NTA) is UNVERIFIED.** Sparrow's docs describe the "Bulk SMS API (Version 2.0)" as "a RESTful API" ([docs.sparrowsms.com](https://docs.sparrowsms.com/)).
- **Aakash SMS**: HTTP SMS API. Its [SMS gateway API service page](https://aakashsms.com/?p=2951) confirms an API with documentation, but it does **not** state token auth (Pass 1). A [Laravel wrapper](https://packagist.org/packages/sachinkiranti/aakash-sms) configures an "auth token" and passes recipients + message; the exact wire parameter names are UNVERIFIED — use Aakash's official API doc.
- *Pass 2 residency flag:* 00-scope §7.1 states that WhatsApp/SMS gateways inherently route abroad and must be flagged. Whether Sparrow/Aakash host their API servers in Nepal is **UNVERIFIED**; treat each SMS provider as a cross-border touchpoint until confirmed, keep PHI out of SMS bodies (02 REQ-SEC-070), and list it in the 02 REQ-SEC-141 register.
- Design: pluggable SMS provider interface, per-tenant credentials and sender ID, template registry (registration, report-ready, dues reminder), delivery-status log, and Nepali-language (Unicode) message support (Unicode SMS cost more segments — budget per-message cost into pricing).

### 4.5 WhatsApp Business API (report delivery)

Sources: [baat.ai on per-message pricing](https://baat.ai/blog/whatsapp-pricing-per-message), cross-checked in Pass 1 with two more BSP pages: [Zoho](https://help.zoho.com/portal/en/community/topic/whatsapp-service-messages-pricing-update) and [respond.io](https://respond.io/blog/whatsapp-pricing-change-2026.md). The [Salesforce WhatsApp rate card (eff. 1 Aug 2025)](https://www.salesforce.com/en-us/wp-content/uploads/sites/4/assets/pdf/WhatsApp_Business-Messaging-Rate-Card-Aug-1-2025.pdf) lists per-country **multipliers** by category (Marketing/Utility/Authentication/Service), not currency prices. **Pass 1 warning:** Meta's own [pricing page](https://developers.facebook.com/docs/whatsapp/pricing), as fetched on 2026-11-05, still said "All non-template messages are free" and "Utility templates delivered within an open customer service window are free", with no 1,000 allowance. The [updates page](https://developers.facebook.com/docs/whatsapp/pricing/updates-to-pricing) failed to load. *Pass 2:* Meta's current documentation path ([developers.facebook.com/documentation/business-messaging/whatsapp/pricing](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing), the page respond.io itself links to), fetched 2026-11-05, shows rate cards "effective April 1, 2026" and still says "All non-template messages are free" and "Utility templates delivered within an open customer service window are free", with no 1,000 allowance. *(Pass 3 correction: the `.md` variant of the same Meta page does list a 1 Oct 2026 rate-card update — Nepal gets its own lower utility/authentication rates — but not in-window utility charging; see 05 T1.)* So the "stale copy" explanation is not supported. **The Oct-2026 changes below are reported by BSPs, not confirmed on Meta's pricing page — UNVERIFIED.** For cost modelling, budget the BSP-reported (worse) case; for product behaviour, nothing depends on it.
- Since **1 July 2025** Meta charges **per message**, not per 24-h conversation.
- Template categories: **marketing** (most expensive), **utility**, **authentication**; rates vary by recipient country.
- Inbound messages free. **Reported by BSPs, not confirmed on Meta's pricing page — UNVERIFIED:** from **1 Oct 2026**, **1,000 free service (non-template) messages per business phone number per month**, resetting monthly, no rollover, not pooled across numbers; beyond that, service messages billed at the recipient country's utility rate. Also reported by BSPs, not confirmed on Meta's pricing page — UNVERIFIED: from the same date, **utility templates sent inside an open 24-h window become chargeable from the first message**, with no allowance (respond.io, baat.ai). Meta's own page (both paths, fetched 2026-11-05) still says in-window utility templates are free. Free Entry Point window: all messages free for 72 h (Meta pricing page, Pass 3). *Pass 3:* Meta's pricing page lists a rate-card update effective 1 Oct 2026 that gives Nepal (with Bangladesh, Iraq, Sri Lanka) its own lower utility/authentication rates, out of "Rest of Asia Pacific", plus a new authentication-international rate; the NPR/USD figure is UNVERIFIED (download the current rate card). In-window utility charging remains BSP-reported/UNVERIFIED (04 T3/T5).
- Outside a customer-opened 24-h window you can only send **pre-approved template messages**. "Your report is ready" = a **utility template**. *(Pass 2 correction for consistency with 02 REQ-SEC-007/070 and 03 REQ-ARCH-083 and the baseline residency rule (00-scope §7.1): the template carries **only a link + no PHI**; the report itself is fetched from the Nepal-hosted portal behind the OTP gate. Sending the PDF as a WhatsApp document header would move PHI through Meta's servers abroad, so it is **not** the default; it may be offered only as a tenant opt-in after explicit founder approval and recorded patient consent. The "document header" pattern being standard among labs is UNVERIFIED.)*
- Access via **Meta Cloud API directly** (free platform, pay per message) or a **BSP** (Twilio, local BSPs; adds per-message margin but simpler onboarding). *(Pass 1 correction:)* Meta business verification is **not strictly required to start**. Unverified businesses are limited to 2 phone numbers and 250 business-initiated template messages per 24 h, and verification removes these limits ([Clickatell guide](https://help.clickatell.com/whatsapp/getting-started/get-business-verified); BSP source, not Meta primary). At 20 centres × report volume, verification of each lab's legal entity is required **in practice**. Opt-in consent from patients must be collected (capture a WhatsApp-consent checkbox at registration).
- Cost control: send a **link to the portal** (template with URL button) — this is now the default for residency reasons (above), with the same template cost and no media hosting; SMS remains the fallback channel (03 REQ-ARCH-085).

### 4.6 Doctor referral commission — NMC ethics

Fee-splitting/commission for referrals is a classic medical-ethics prohibition internationally. The [overview](https://en.wikipedia.org/wiki/Fee_splitting) says "in most parts of the world, the practice is considered unethical and unacceptable", and notes that the US position is less clear-cut. For Nepal specifically, the NMC enforces a Code of Ethics with sanctions: a violating doctor is "warned or suspended or barred from practice". The revised code "bars medics from financially exploiting the patients **while prescribing medicines**" ([myRepublica](https://myrepublica.nagariknetwork.com/news/revised-code-of-ethics-for-doctors); the article shows no year). *(Pass 1 narrowing: the article ties financial exploitation to prescribing and does not mention referrals or commissions.)* **Pass 1 correction:** the previously cited [KUMJ article](https://nepjol.info/index.php/KUMJ/article/view/2723/2415) (Dixit, "Nepal Medical Council: The past and the future", KUMJ 2009;7(3):196–203) does **not** discuss lab commission practice; it covers NMC history, advertising and Code-of-Ethics enforcement generally. Laboratory staff (BMLT, lab technicians, lab assistants) are regulated by the **Nepal Health Professional Council**, whose profession-specific codes of ethics are mandatory ([NHPC ethics page](https://nhpc.gov.np/ethics.php)). Whether those codes address commissions is UNVERIFIED, because the code texts were not opened. **an explicit clause-level prohibition of lab-referral commissions in the current NMC code is UNVERIFIED this pass — obtain the current NMC Code of Ethics text (nmc.org.np) and have the client take a documented position.** Product stance (§1.5): ship referral-attribution analytics and configurable incentive *reports*; keep payout execution outside the system or behind a tenant-level feature flag; never label it on printed documents. Also note TDS applies to any such payouts (rate/section UNVERIFIED — needs confirmation) — the lab's accountant problem, but the report should show gross amounts per PAN-identified doctor.

### 4.7 Privacy: Individual Privacy Act 2075 (2018) + Regulation

Sources: the law-firm summary ([Pioneer Law on the Privacy Act 2075](https://pioneerlaw.com/individual-privacy-act-2018-2075)), re-verified in Pass 1 against an English text of the Act ([ADB Law and Policy Reform copy](https://lpr.adb.org/sites/default/files/resource/%5Bnid%5D/nepal-the-privacy-act-2075-2018-english.pdf)):
- Applies to public bodies **and Nepali-incorporated corporate entities** (i.e. both the lab and the LIMS provider); *Pass 3:* s.12(4) and s.29 are addressed to **any person**, so individual staff are personally liable (Law Commission English text). Pioneer Law notes uncertainty about reach over offshore entities.
- Sensitive information (s.27(2)) includes "physical or mental health or condition". Section 3(1) makes privacy of physical and mental condition inviolable. **s.12(4)(a)** bars providing or publishing a person's health examination details without consent. s.27(3)(a) permits health processing by a licensed doctor, or a health worker under a doctor's direction. s.26(1) bars use or disclosure by a public body or body corporate without consent, with exceptions (original purpose; written requests in criminal investigation/adjudication; court orders in sub-judice cases; etc.). s.12(3) limits use to the collection purpose.
- *(Pass 1 correction:)* the explicit duty to make "appropriate arrangement against unauthorized access" (**s.25(2)**) is addressed to **public bodies**. The Act does not state an equivalent explicit security duty for corporate bodies, and Pioneer Law likewise describes none. Implement security controls anyway, as good practice, the client's requirement, and protection against s.26 disclosure liability. Do not cite the Act as imposing them on corporates.
- Violations are **criminal** (s.29(2)): imprisonment up to 3 years and/or a fine up to NPR 30,000, plus compensation claims.
- *(Pass 1 update:)* the **Personal Privacy Regulation, 2077** (वैयक्तिक गोपनीयता सम्बन्धी नियमावली, २०७७) **exists**: the [Nepal Law Commission listing](https://lawcommission.gov.np/content/12982/12982-personal-privacy-regulation-2/) is dated 8 Bhadra 2077 (~24 Aug 2020). Its **content is UNVERIFIED** because the page shows only the title. Pioneer Law's statement that implementing rules "have not been issued" is therefore **OUTDATED**. Pull the Regulation text before finalising the DPA. The Act itself is on [Nepal Law Commission](https://lawcommission.gov.np/content/12261/the-privacy-act-2075/), dated 2 Asoj 2075.

Product consequences: consent capture at registration (SMS/WhatsApp/data-use consent flags), role-based access with audit log (dual-purpose with IRD §4.1), encryption at rest + TLS, **Nepal-resident hosting** (client requirement; also simplifies the cross-border-transfer question the Act leaves murky), per-tenant data isolation, data-sharing only to the referring doctor/centre on the order, breach-response runbook, and a DPA between the LIMS provider (processor) and each lab (controller).

### 4.8 Bikram Sambat dates

- All user-facing dates and the **fiscal year (Shrawan 1 – Ashadh end, ≈ mid-July to mid-July)** run on B.S. (Pass 1: confirmed by ["FY 2082/83 has officially commenced from … the 1st of Shrawan", 17 Jul 2025](https://nepsetrading.com/news/new-fiscal-year-begins-budget-provisions-effective-from-today?lang=en)). *(The baseline report shows A.D. dates on Metro Labs reports (00-scope §4), so the "all user-facing dates on B.S." premise needs a dual-calendar display setting, not B.S.-only.)* store timestamps in UTC/AD internally and convert at the edges.
- Conversion is table-driven (B.S. month lengths are irregular, published per year). Libraries exist across ecosystems — e.g. Python [`npdatetime`](https://pypi.org/project/npdatetime/0.1.2.post2/) (Nepali datetime with B.S. support) and the [`nepali-datetime`](https://pypi.org/project/nepali-datetime/) package (Pass 1: exists, MIT, B.S. date/datetime + NPT, v1.0.8.5 released 7 May 2026; "widely used" is unmeasured). Neither PyPI page documents a supported B.S. year range, which is UNVERIFIED. For JS, [`bikram-sambat`](https://www.npmjs.com/package/bikram-sambat) exists on npm (*Pass 2 correction:* latest is **1.8.1, 9 Jun 2026**, Apache-2.0, per the npm registry API — matching 03 §3.6; the earlier "v1.7.0" was outdated; README/functionality still UNVERIFIED). The unscoped `nepali-date-converter` remains UNVERIFIED, but the scoped packages [`@remotemerge/nepali-date-converter`](https://www.npmjs.com/package/@remotemerge/nepali-date-converter) (1.2.7) and `@sbmdkl/nepali-date-converter` (2.0.5) are verified in 03 §3.6. Pick per your stack. Whatever library: pin it and add tests around fiscal-year boundaries, because invoice series reset at Shrawan 1 and the valid B.S. table range is finite (check the library's supported year range extends well past 2090 B.S.). *Pass 3:* ranges from source/README: bikram-sambat 1970–2090 B.S.; @remotemerge 1975–2099; @sbmdkl 1978–2099 (A.D. ≤2040); nepali_utils 1969–2100. bikram-sambat is insufficient as the primary JS library. Proposed (04 D13): JS = `@remotemerge/nepali-date-converter` 1.2.7, Dart = `nepali_utils` 3.0.8 (via `nepali_date_picker` 8.0.0), one shared golden-test table run on both sides covering 2000–2099 B.S.
- Invoice numbering per fiscal year (e.g. `081/82-000123`) is the Nepali convention and ties into §4.1 chronological-numbering rules.

---

## 5. Smart Report

### 5.1 What the Indian players actually ship

- [Dr Lal PathLabs' Smart Report](https://lalpathlabs.com/about-smart-report) (verified): health summary infographics, parameters at a glance, per-parameter explanations with reference ranges, colour-coded organ/profile groups, consolidated lifestyle guidance, diet dos/don'ts, follow-up test intervals, additional recommended tests (re-verified Pass 1; parameters at a glance include cholesterol, blood pressure, heart rate, body weight). (*Pass 1:* the [Metropolis link](https://www.metropolisindia.com/about-smart-report) showed no Smart Report content when fetched, so the Metropolis equivalent is **UNVERIFIED — needs confirmation**.)
- [CrelioHealth sells "Smart Reports" as a LIS add-on layer](https://creliohealth.com/solutions/smart-report/) (verified): sample shows a **health score out of 100** (sample: "72 of 100", labelled "Fair"; *Pass 1: no "Good" label is shown and the score bands and formula are not published*), health areas "in range / attention" ("4 of 7 health areas in range. 3 need attention"), per-result legend In range / Borderline / Out of range (the sample results themselves use High/Low), a **trends page** (*Pass 1 correction:* only HbA1c spans 4 visits; glucose, LDL and Vitamin D show 2 values each), recommendations ("What you can do next", labelled "General guidance only"), and — notably — "Promote Lab Services" / follow-up booking pages. So yes: this is a shipped LIMS-adjacent product category, not vapour.
- Healthians "Smart Report 3.0" specifically: marketing claims (health score, organ-wise summary, diet/lifestyle advice, suggested future tests, supplement recommendations) could **not be verified from an official Healthians page this pass — UNVERIFIED as to exact section list**; sample Healthians reports circulating publicly and the Lal/Crelio equivalents above cover the same section set, which is what we spec against.

### 5.2 Rules-based (non-LLM) generation spec

All sections derive from structured data the LIS already has: results + units + age/sex reference ranges + flags + history. Every text fragment comes from a **pathologist-approved template library**; the engine only selects and fills templates — no free generation.

| Section | Rule-based generation |
|---|---|
| **Per-result status** | 3–5 bands per analyte: in-range / borderline (configurable % into or near limit) / out-of-range / critical. Pure range arithmetic. |
| **Organ/profile grouping** | Static mapping analyte→panel (lipid, liver, kidney, thyroid, sugar, CBC, vitamins…). Panel status = worst member status (critical > out > borderline > in). |
| **Health score (0–100)** | Transparent formula, e.g. weighted sum: each measured panel contributes weight×subscore, subscore = 100·(in-range members/members) with penalties for out/critical. Publish the formula in the report footer; only score panels actually measured (CrelioHealth's "4 of 7 areas in range" is this shape). Label bands Good/Fair/Needs attention. |
| **Deranged-parameter summary** | List all non-in-range analytes, each with a template sentence keyed by (analyte, direction, severity): "Your fasting glucose is above the reference range, which may indicate impaired glucose control." Written once by the pathologist, reused forever. |
| **Trends** | Last N values per analyte from cumulative history; sparkline + "improved/worsened/stable" via threshold on slope vs analytical variation. |
| **Diet/lifestyle advice** | Template blocks keyed by *panel finding*, not free-form: high-LDL block, high-uric-acid block, low-Hb block, etc.; de-duplicate and cap length; every block reviewed/signed by the lab's pathologist/dietician. Add a fixed disclaimer: general wellness information, not a prescription, consult your doctor. |
| **Suggested follow-up tests** | Rule table: finding → suggested test + interval (HbA1c high → repeat in 3 months; TSH borderline → repeat 6–8 weeks; Hb low → iron studies). Lab medical director owns the table — this is the conflict-of-interest hot zone (lab recommending its own billable tests), so make rules visible and conservative. |
| **Supplement upsell** | **Recommend excluding.** A diagnostic lab recommending purchasable supplements off its own abnormal flags is a direct conflict of interest, sits badly with the NMC financial-exploitation concerns (§4.6), and creates Privacy-Act-adjacent "use of health data for commercial purpose" exposure. If the client insists, require explicit patient opt-in and pathologist sign-off per rule. |

### 5.3 Optional LLM layer (bounded)

Where an LLM adds value: *fluency*, not *content* — rephrasing the selected template blocks into one coherent summary paragraph, or Nepali-language rendering. Constraints: input = only the selected approved blocks + flags (no raw free generation about diagnoses); output must pass a validator (no analyte/number not present in input, no medication/supplement names); pathologist approves the final text before release (fits the human-review posture CrelioHealth itself describes: "Clinicians review & approve AI-assisted results", and labs "own and control their AI outputs" — [source](https://creliohealth.com/solutions/smart-report/), verified Pass 1); and to honour the data-in-Nepal requirement, run a self-hosted open-weights model in the Nepal data centre. *(Pass 2: sending even de-identified block IDs to an external/foreign API is a new foreign touchpoint beyond the transactional-email-relay pattern allowed by 00-scope §7.1, so it requires explicit founder approval and a 02 REQ-SEC-141 register entry; default = self-hosted only.)* Phase 3 at the earliest; the rules engine alone matches the competitors' visible output.

---

## 6. Consolidated decision table

| # | Module | Verdict | Phase |
|---|---|---|---|
| 1 | One-page registration & billing | KEEP | 1 |
| 2 | Discounts w/ reason+approver, part-pay, urgent charge | KEEP | 1 |
| 3 | IRD-compliant invoicing + CBMS sync | KEEP (foundational) | 1 |
| 4 | Payment-method ledger (cash/card/wallet/QR recorded) | KEEP | 1 |
| 5 | Live eSewa/Khalti/Fonepay API integration | KEEP-LATER | 1.5–2 |
| 6 | Sample barcode, accept/reject, status state machine | KEEP | 1 |
| 7 | Analyzer result import (uni-dir all, bi-dir where supported) | KEEP | 1 (phased per driver) |
| 8 | Results entry, formulas, short-code comments, previous results | KEEP | 1 |
| 9 | Two-step verification, lock, amended reports | KEEP | 1 |
| 10 | Delta checks + critical-value notification log | KEEP | 1 |
| 11 | Auto-verification rule engine | KEEP-LATER | 2 |
| 12 | Report delivery: print/PDF, SMS, email, hold-till-paid, bulk release, QR verify, letterhead toggle, outsourced-PDF merge | KEEP | 1 |
| 13 | WhatsApp report delivery (Cloud API/BSP, utility templates) | KEEP | 1–1.5 |
| 14 | Narrative report engine (radiology/USG/endoscopy formats, images) | KEEP | 1 |
| 15 | User roles, audit log, masters (doctors/centres/affiliations) | KEEP | 1 |
| 16 | Per-doctor/centre price lists + Excel import/export, credit-party billing | KEEP | 1 |
| 17 | Referral "commission" → referral-incentive reporting only | KEEP (reframed) | 1 |
| 18 | Daily cash collection by staff/method; MIS dashboards (named reports) | KEEP | 1 |
| 19 | TAT: timestamps + pending list (P1); targets/alerts (P2) | KEEP thin | 1→2 |
| 20 | QC: capture QC data (P1); LJ charts + Westgard engine (P2) | KEEP-LATER | 1→2 |
| 21 | Microbiology module (isolates, AST, prelim/final) | KEEP-LATER | 2 |
| 22 | Molecular module | KEEP-LATER | 2 |
| 23 | Histopath/cytology/IHC (blocks, slides, narrative, coding) | KEEP-LATER | 2 |
| 24 | Cytogenetics as dedicated module | DROP (serve via narrative engine) | — |
| 25 | Inventory: consumption models, lots/expiry, PO, wastage | KEEP-LATER | 2 |
| 26 | "Real-time analyser-connected" reagent telemetry | DROP (replace with consumption model; revisit per-vendor middleware) | — |
| 27 | B2B partner portal (web) | KEEP-LATER | 2 |
| 28 | Patient portal (web, responsive) | KEEP | 1 |
| 29 | Patient native app + phlebotomy app | KEEP-LATER | 3 |
| 30 | Smart report (rules-based) | KEEP-LATER | 2–3 |
| 31 | Smart report supplement upsell | DROP (ethics/COI) | — |
| 32 | Queue token display | KEEP-LATER (cheap) | 2 |
| 33 | Appointment slots / kiosk | KEEP-LATER / DROP kiosk | 3 / — |
| 34 | CRM | REPLACE-WITH-INTEGRATION (export + external CRM) | — |
| 35 | Loyalty/points/coupons/membership | KEEP-LATER minimal (membership price-list) | 3 |
| 36 | B2C reminders (follow-up test nudges) | KEEP-LATER | 2 |
| 37 | Generic patient document storage vault | DROP | — |
| 38 | HR/salary/leave | DROP (integrate dedicated HR/payroll) | — |
| 39 | Marketing & sales-team management | DROP (CRM territory; MIS exports suffice) | — |
| 40 | Marketing website/CMS | DROP (portal only) | — |
| 41 | PACS/DICOM | DROP for now / INTEGRATE later | — |

*Pass 2 phasing notes (binding for 02/03, recorded in 04-consolidated-decisions.md):* (a) rows 5, 27, 29 are **recommendations that conflict with the client's own top-level formula** ("Software + Website + APP (Patient APP, Phlebotomy APP)", 00-scope §1) and the wishlist; the client still owes a module priority ranking (00-scope §6 item 4), so the phase of the Flutter apps and the B2B portal is **BLOCKED pending client priority**. 02 §5 and 03 §7 requirements apply whenever those apps are built. (b) Row 11: in Phase 1 every result goes to manual first verification; 03 REQ-ARCH-063's auto-verify rules are Phase 2. (c) Row 5: 02 §2 payment-gateway requirements (REQ-SEC-046..056, 058, 059) and 03 REQ-ARCH-087/089/090 apply from the phase that ships live gateways; REQ-SEC-057 (append-only ledger) applies from Phase 1. (d) Row 13: WhatsApp delivery is link-only (§4.5).

---

## 7. Open questions for the client

1. **Exact analyser models + counts** (Autobio which models? Mindray BC-? BS-? Getein 1100 or 1600? urine analyser brand? which ID/AST system — VITEK 2, Autobio, other?) and whether official **Host/LIS Interface Manuals** can be obtained from each distributor.
2. Which instruments *must* be bi-directional at go-live vs acceptable as upload-only initially?
3. Is Metro Labs' current IRD status: already using IRD-listed billing software? Turnover above the current e-billing mandate threshold? Who files the IRD application — lab or the LIMS provider jointly?
4. Auditor confirmation: are Metro Labs' diagnostic services VAT-exempt under Schedule 1, and are there any taxable revenue lines (home-collection fee? consumable sales)?
5. Fonepay: which acquiring bank, and can they provide the dynamic-QR + webhook merchant API docs?
6. Monthly volumes per department (chemistry/haem/micro/histo/molecular/cytogenetics) — to validate the Phase-2 ordering and the cytogenetics DROP.
7. Home collection volume today (decides phlebotomy-app priority).
8. Who legally owns patient data and consent language across the 20 centres (franchise vs owned)? Needed for the Privacy Act DPA structure.
9. Referral incentive: does Metro Labs currently pay referrers, and will management sign off on the compliance posture in §4.6?
10. Report languages: English only, or Nepali patient-facing summaries required?
11. Data migration from eLabs: can historical results be exported (needed for previous-results/trends on day one)? What format?
12. Critical-value list and notification policy: does the lab have an SOP we can encode, or do we draft one with the pathologist?
13. WhatsApp: is the lab willing to complete Meta business verification per legal entity, and what monthly report-delivery volume (for per-message cost modelling)?
14. Smart report: confirm exclusion of supplement upsell; who (named pathologist) will own the template/rules library?
15. QC: which control materials/levels are run today, and is NABL/ISO 15189-style accreditation on the roadmap (changes QC/audit priority)?

---

### Source quality note

Primary/official sources opened: eSewa developer docs, Khalti docs, Pioneer Law (Privacy Act), Lal PathLabs smart report, CrelioHealth smart report, Sparrow SMS, baat.ai/Meta pricing trail, Frappe IRD compliance threads, open-exam-prep Westgard definitions. Instrument interface manuals located only as secondary (Scribd) copies — flagged above; obtain official vendor PDFs before implementation. Items explicitly marked **UNVERIFIED**: Autobio/Getein interface capabilities, Fonepay API details, NMC clause-level commission prohibition, Privacy Regulation 2077 content, VAT Schedule 1 exact entry, Healthians Smart Report 3.0 official section list, current IRD submission checklist, SNOMED licensing for Nepal, specific delta-check thresholds, nepali-datetime library choice. **Pass 1 added:** VITEK BCI payload; Meta-primary confirmation of the Oct-2026 WhatsApp change; abbreviated-invoice NPR 5,000 limit currency; ISO 15189 amended-report and rejection-rate QI claims; CLSI specimen-site breakpoint dimension; Metropolis smart report; Drlogy front desk; Aakash wire parameters; NHPC code commission clauses; B.S. library year ranges; multi-tenant IRD certification scope. See the verification log below.

---

## Verification log — Pass 1 (2026-11-05)

Adversarial fact-check of every falsifiable claim in this report. Verdicts: **CONFIRMED** (source opened and agrees), **WRONG** (corrected in text), **OUTDATED** (corrected in text), **UNVERIFIED** (no primary source could be opened; marked in text). Internal recommendations and effort estimates are opinion and were not scored.

| # | Claim | Verdict | Correction made | Source |
|---|---|---|---|---|
| 1 | CrelioHealth LIS has front-desk registration, billing, barcoding | CONFIRMED | Wording tightened to what the page lists | https://creliohealth.com/us/lis/lis-system/laboratory-information-system |
| 2 | Drlogy ships the same registration-centric front desk | UNVERIFIED | Only "Billing & Invoicing" and QR reports shown; marked UNVERIFIED | https://www.techjockey.com/compare/drlogy-lab-vs-labsmart |
| 3 | Client saw eLabAssist/Medizensys demos | UNVERIFIED | Not in 00-scope baseline; labelled assumption | 00-scope-baseline.md |
| 4 | SENAITE models registration, worksheets, verification states | CONFIRMED (partial) / UNVERIFIED (lifecycle) | Worksheets, verifier role and GPL v2 confirmed; full lifecycle marked UNVERIFIED | https://linuxlinks.com/senaite-enterprise-open-source-laboratory-system |
| 5 | ISO 15189 expects amended-report path (cited Biochemia Medica) | WRONG citation → UNVERIFIED | Citation removed; claim marked UNVERIFIED | https://biochemia-medica.com/en/journal/29/3/10.11613/BM.2019.030703 |
| 6 | CrelioHealth B2B billing / per-client price lists / credit control | CONFIRMED | Quoted "organization-wise price list"; ranking claim marked as judgement | https://creliohealth.com/lims/lims-system/lims-solutions |
| 7 | CrelioHealth packages patient engagement as a separate product | WRONG | Corrected: "Patient Experience" is a use-case nav entry; engagement is inside Smart Reports | https://creliohealth.com/solutions/smart-report/ |
| 8 | Sample rejection rate is a standard ISO 15189 pre-analytical QI (cited Biochemia Medica) | WRONG citation → UNVERIFIED | Citation removed; marked UNVERIFIED | Biochemia Medica 2019 (above); https://www.research.unipd.it/retrieve/e14fb26e-d558-3de1-e053-1705fe0ac030/10.1515_cclm-2015-0897.pdf |
| 9 | Friedewald LDL = TC − HDL − TG/5, valid only for TG < 400 mg/dL | CONFIRMED | None | https://www.msdmanuals.com/iframe/manual/medical-calculators/friedewald.htm |
| 10 | CLSI AUTO10/AUTO15 text paywalled; rules = industry practice | UNVERIFIED (as marked) | Left marked | — |
| 11 | ISO 15189 requires a documented critical-result notification protocol | CONFIRMED | Re-pointed to Biochemia Medica 2019 (which is actually about this); added GP47 bands; Thieme PDF marked unreadable | https://biochemia-medica.com/en/journal/29/3/10.11613/BM.2019.030703 |
| 12 | AST interpretation = S/I/R | WRONG (incomplete) | Added SDD, NS, WT/NWT (ECV) and the EUCAST "I" redefinition; model must be extensible | https://www.mayocliniclabs.com/it-mmfiles/Susceptibility-Interpretative-Category-Definitions.pdf |
| 13 | CLSI M100 breakpoints, updated annually | CONFIRMED (Ed36, 26 Jan 2026, replaces Ed35 2025) | Edition/date added; annual cadence noted as inferred | https://clsi.org/shop/standards/M100 |
| 14 | M100 breakpoints keyed by specimen site | UNVERIFIED | Marked UNVERIFIED; design keeps the dimension | https://clsi.org/shop/standards/M100 |
| 15 | VITEK 2 Advanced Expert System does interpretive reading | CONFIRMED | Citation added | https://ueaeprints.uea.ac.uk/33500 |
| 16 | VITEK BCI uploads ID + MIC + S/I/R, optional demographics download | UNVERIFIED | Scribd copies unreadable; marked UNVERIFIED in §2.3 and §3.2 | https://www.scribd.com/document/491726048/Protocol-Bci |
| 17 | Cytology Pap reporting uses Bethesda categories | CONFIRMED | None | https://en.wikipedia.org/wiki/Bethesda_system |
| 18 | SNOMED CT licensing status for Nepal | UNVERIFIED (as marked) | SNOMED members page failed to load; left marked | — |
| 19 | LJ chart lines at mean, ±1/2/3SD | CONFIRMED | None | https://open-exam-prep.com/study-guides/amt-mlt/ch7/quality-control-westgard |
| 20 | ≥20 baseline runs for mean/SD | UNVERIFIED | Marked | — |
| 21 | 1-2s = warning, not rejection | CONFIRMED | Westgard quote added | https://www.westgard.com/mltirule.htm |
| 22 | 1-3s = reject, single obs beyond ±3SD | CONFIRMED | None | https://www.westgard.com/mltirule.htm |
| 23 | 2-2s = two consecutive beyond same ±2SD | CONFIRMED (definition) / UNVERIFIED (across-level and across-run scope) | Scope note marked UNVERIFIED | https://westgard.com/westgard-rules.html |
| 24 | R-4s = range between two controls > 4SD | WRONG (imprecise) | Corrected to Westgard's definition (one > +2SD and another < −2SD), within-run only | https://www.westgard.com/mltirule.htm |
| 25 | 4-1s definition | CONFIRMED | Added across-runs/materials note | https://www.westgard.com/mltirule.htm |
| 26 | 10x definition | CONFIRMED | Added across-runs note; classic vs modern multirule flag | https://www.westgard.com/mltirule.htm |
| 27 | Rule → error-type mapping (random/systematic) | CONFIRMED (secondary only) | Labelled as secondary source | https://open-exam-prep.com/study-guides/amt-mlt/ch7/quality-control-westgard |
| 28 | Onboard reagent telemetry not exposed over ASTM/HL7 | UNVERIFIED (as marked) | Left marked | — |
| 29 | Within-lab TAT is the most common accreditation indicator (cited Biochemia Medica) | WRONG citation → UNVERIFIED | Replaced with the IFCC post-analytical QI paper (TAT QIs = % late reports, 90th-percentile STAT K+ etc.); "most common" marked UNVERIFIED | https://www.research.unipd.it/retrieve/e14fb26e-d558-3de1-e053-1705fe0ac030/10.1515_cclm-2015-0897.pdf |
| 30 | ASTM record types H,P,O,R,Q,C,L; LIS2-A2 = E1394, LIS1 = low level | CONFIRMED (added S, M) | Added S and M; noted LIS2 is a revision of E1394-97 | https://webstore.ansi.org/preview-pages/CLSI/preview_LIS2-A2.pdf |
| 31 | Mindray BC-5380 / BS-120/200 manuals are ASTM-structured | **WRONG** | Both are HL7 v2.3.1 (BC-5380 over TCP + MLLP); driver layer must do HL7/MLLP from sprint 1 (UNVERIFIED from primary — unofficial Scribd copy only; 05 T11) | https://www.scribd.com/document/562151986/LIS-BC5380 ; https://www.scribd.com/document/467496962/Comunicacion-BS120-BS200-pdf |
| 32 | Mindray BC host query supported | CONFIRMED (BC-5380, via HL7 ORM^O01/ORR^O02) (UNVERIFIED from primary — unofficial Scribd copy only; 05 T11) | Table row rewritten | BC-5380 Scribd copy |
| 33 | Mindray BS bi-directional host query | CONFIRMED (BS-120/200, HL7 QRY^Q02/QCK/DSR) (UNVERIFIED from primary — unofficial Scribd copy only; 05 T11) | Table row rewritten; BS-240 marked UNVERIFIED | BS-120/200 Scribd copy |
| 34 | Molecular instruments ship HL7-only guides (Cepheid example) | WRONG | Cepheid doc shows both ASTM and HL7 v2.5 examples | Cepheid 303-3391 PDF (link in §3.1) |
| 35 | Autobio bi-directional ASTM host interface | UNVERIFIED (as marked) | Noted "AutoLumo LIS Communication Protocol V1.4" title on Scribd (unreadable) | Scribd search listing |
| 36 | Getein POCT upload-only | UNVERIFIED (as marked) | Left marked | — |
| 37 | IRD directive dated 2074.09.16 supersedes 2072 Procedure | UNVERIFIED → *Pass 3: CONFIRMED in substance* | Date exists only as a PDF filename; supersession marked UNVERIFIED. *Pass 3 (IRD primary): 2074/09/16 is the commencement date of the Electronic Invoice Procedure 2074, the current instrument; express repeal of 2072 not checked* | https://discuss.frappe.io/t/compliance-requirement-that-must-be-fulfilled-to-get-approval-from-tax-authority-in-nepal/34532 ; https://pioneerlaw.com/?p=551 |
| 38 | 2072 Procedure: developer certification + taxpayer use approval; fines | CONFIRMED (new detail) → *Pass 3: OUTDATED/partly WRONG* | Added developer certification, NPR 1,000 / 500,000 fines; multi-tenant note fixed. *Pass 3: 2072 Procedure is historical; current = Procedure 2074 (listing by self-certification + per-taxpayer permission); NPR 500,000 falls on the taxpayer (VAT Act s.29(1)(g2)); NPR 1,000 is the buyer's fine, non-issuance NPR 10,000* | https://pioneerlaw.com/?p=551 |
| 39 | No deletion; cancel only; cancelled viewable | CONFIRMED | None | Frappe thread 34532 |
| 40 | Reprints marked "copy of original" + print count | CONFIRMED | None | Frappe thread 34532 |
| 41 | Per-user audit trail | CONFIRMED | None | Frappe thread 34532 |
| 42 | Chronological invoice numbering + printable register | CONFIRMED | None | Frappe thread 34532 |
| 43 | Real-time CBMS sync via IRD API | CONFIRMED | None | Frappe 34532; https://discuss.frappe.io/t/finally-got-approval-for-e-billing-from-ird-nepal-erpnext-v13-28-saas/93072 ; https://apps.odoo.com/apps/modules/18.0/l10n_np_cbms_ebilling |
| 44 | Sales/purchase register columns | CONFIRMED | None | Frappe thread 34532 |
| 45 | Abbreviated tax invoice ≤ NPR 5,000 | CONFIRMED (2018) / possibly OUTDATED | Marked UNVERIFIED as to current value | Frappe thread 34532 |
| 46 | (Missing) VAT Rules 46th amendment 2081 invoice formats (HS code, model/brand) | OUTDATED (omission) | Added | https://bizsewa.com/?p=4605 |
| 47 | ERPNext team obtained IRD approval | CONFIRMED (Aug 2022); added dual-calendar + statutory books | Added | Frappe thread 93072 |
| 48 | Odoo CBMS e-billing module exists | CONFIRMED | None | https://apps.odoo.com/apps/modules/18.0/l10n_np_cbms_ebilling |
| 49 | Current IRD submission checklist | UNVERIFIED (as marked) | Added TechSathi 2022 package list as possibly outdated | https://techsathi.com/what-is-an-e-billing-system-software-businesses |
| 50 | E-billing mandatory above Rs 200M turnover | CONFIRMED (Apr 2026, lowered from 250M; BFIs exempt) → *Pass 3: UNVERIFIED from primary (news only; IRD notices found show Rs 10 crore from 2079/04/01 and an undated Rs 35 crore CBMS notice)* | Added date, prior threshold, second source | https://ictframe.com/?p=114453 ; https://english.ratopati.com/story/59617 |
| 51 | Multi-tenant SaaS: one certification covers all tenants | UNVERIFIED → *Pass 3: answered in part (Procedure 2074 cl.7(ख))* | Marked. *Pass 3: Nepal server + Nepal-registered operator, IRD notified + access, each taxpayer's data stored separately, Annex 7 tripartite contract; "stored separately" interpretation open (04 D16/B17)* | https://www.ird.gov.np/public/pdf/175356524.pdf |
| 52 | VAT standard rate 13% | CONFIRMED (primary: VAT Act s.7(1)) | Citation added | https://www.ird.gov.np/public/pdf/1140227555.pdf |
| 53 | Health services VAT-exempt under Schedule 1 | UNVERIFIED (as marked) + caveat found | Added the Schedule 1 Group 5 wording that excludes VAT-registered institutions (ICNL copy, possibly not current) | https://www.icnl.org/wp-content/uploads/Nepal_Value.pdf ; https://bizsewa.com/?p=807 ; https://repository.samriddhi.org/paying-taxes/federal-taxes/value-added-tax/ |
| 54 | eSewa v2 form URL | CONFIRMED | None | https://developer.esewa.com.np/pages/Epay-V2 |
| 55 | eSewa HMAC-SHA256 over total_amount,transaction_uuid,product_code, Base64 | CONFIRMED | None | eSewa docs |
| 56 | eSewa transaction_uuid alphanumeric | WRONG (incomplete) | Hyphens also allowed | eSewa docs |
| 57 | eSewa Base64 success payload; recompute signature | CONFIRMED | None | eSewa docs |
| 58 | eSewa status endpoint + 7 statuses | CONFIRMED | Added "AMBIGIOUS" misspelling, code:0 failure, UAT URL | eSewa docs |
| 59 | Khalti initiate URL, sandbox dev.khalti.com, `Key` auth | CONFIRMED | Noted lowercase `key` in samples | https://docs.khalti.com/khalti-epayment |
| 60 | Khalti amount in paisa; returns pidx + payment_url | CONFIRMED | Added min Rs 10, expires_in | Khalti docs |
| 61 | Khalti lookup; only Completed = success; callback not final | CONFIRMED | Added failed and hold statuses | Khalti docs |
| 62 | "NCHL/Fonepay" dynamic QR + webhook APIs | WRONG (conflation) / UNVERIFIED (webhook) | Separated Fonepay vs NCHL NepalPay; bank-enablement confirmed; webhook UNVERIFIED | https://fonepay.com/blogs/fonepay-dynamic-qr-code ; https://github.com/yarsa/nepal-compliance/discussions/98 |
| 63 | Sparrow SMS REST API, token auth, sender-ID control | CONFIRMED | Added docs.sparrowsms.com v2.0 quote | https://sparrowsms.com/services/sms-gateway-api/ ; https://docs.sparrowsms.com/ |
| 64 | Wrappers show token/from/to/text shape | UNVERIFIED (wire names) | Corrected to what the wrapper shows | https://packagist.org/packages/rupeshdahal/nepali-sms-gateway |
| 65 | Sparrow sells sender IDs as "identity" products; via telcos | WRONG | Article doesn't say "identity" or mention telcos/NTA; corrected | https://sparrowsms.com/?p=95072 |
| 66 | Aakash SMS token-based API | UNVERIFIED (service page) / CONFIRMED (wrapper uses auth token) | Corrected | https://aakashsms.com/?p=2951 ; https://packagist.org/packages/sachinkiranti/aakash-sms |
| 67 | WhatsApp per-message pricing since 1 Jul 2025 | CONFIRMED | None | https://baat.ai/blog/whatsapp-pricing-per-message ; Salesforce rate card |
| 68 | Categories marketing/utility/authentication; rates by country | CONFIRMED | Noted rate card uses multipliers and includes Service | Salesforce rate card PDF |
| 69 | 1,000 free service messages per number/month; billed at utility rate from 1 Oct 2026 | CONFIRMED by 3 BSPs / UNVERIFIED vs Meta primary | Added Meta-page-contradiction warning; per-number, no rollover | Zoho, respond.io, baat.ai (links in §4.5); https://developers.facebook.com/docs/whatsapp/pricing |
| 70 | (Missing) in-window utility templates chargeable from 1 Oct 2026 | OUTDATED (omission) | Added | https://respond.io/blog/whatsapp-pricing-change-2026.md |
| 71 | Outside 24-h window only templates allowed | CONFIRMED (implied by Meta pricing page) | None | https://developers.facebook.com/docs/whatsapp/pricing |
| 72 | Business verification required | WRONG (overstated) | Not required to start; unverified limit 2 numbers / 250 templates per 24 h | https://help.clickatell.com/whatsapp/getting-started/get-business-verified |
| 73 | Fee splitting widely considered unethical | CONFIRMED | Quote added | https://en.wikipedia.org/wiki/Fee_splitting |
| 74 | NMC sanctions warn/suspend/bar | CONFIRMED | None | https://myrepublica.nagariknetwork.com/news/revised-code-of-ethics-for-doctors |
| 75 | Revised NMC code bars financially exploiting patients | CONFIRMED (narrower: "while prescribing medicines") | Narrowed | same |
| 76 | KUMJ article discusses commission practice critically | WRONG | It doesn't; corrected description | https://nepjol.info/index.php/KUMJ/article/view/2723/2415 |
| 77 | NMC clause-level prohibition of lab commissions | UNVERIFIED (as marked) | Added NHPC (lab staff regulator) note; NHPC code text unverified | https://nhpc.gov.np/ethics.php |
| 78 | TDS applies to referral payouts | UNVERIFIED | Marked | — |
| 79 | Privacy Act applies to public bodies + Nepali corporate bodies | CONFIRMED | None | https://pioneerlaw.com/individual-privacy-act-2018-2075 |
| 80 | Physical/mental condition = sensitive info; consent; exceptions | CONFIRMED | Section numbers added (s.3, 12(3), 12(4)(a), 26(1), 27(2), 27(3)(a)) | ADB English text (link in §4.7) |
| 81 | Entities must implement security measures | WRONG (overstated) | s.25(2) security duty is addressed to public bodies only | ADB English text; Pioneer Law |
| 82 | Penalty ≤ 3 yrs and/or ≤ NPR 30,000 + compensation | CONFIRMED (s.29(2)) | Section added | ADB English text |
| 83 | Privacy Regulation 2077 existence | CONFIRMED (Law Commission listing, 8 Bhadra 2077) / content UNVERIFIED | Updated; Pioneer "rules not issued" flagged OUTDATED | https://lawcommission.gov.np/content/12982/12982-personal-privacy-regulation-2/ |
| 84 | Privacy Act text on Law Commission | CONFIRMED (dated 2 Asoj 2075) | None | https://lawcommission.gov.np/content/12261/the-privacy-act-2075/ |
| 85 | Fiscal year starts Shrawan 1 | CONFIRMED | Source added; dual-calendar note (baseline shows A.D. on reports) | https://nepsetrading.com/news/new-fiscal-year-begins-budget-provisions-effective-from-today?lang=en |
| 86 | npdatetime supports B.S. | CONFIRMED (year range undocumented) | Noted | https://pypi.org/project/npdatetime/0.1.2.post2/ |
| 87 | nepali-datetime package exists | CONFIRMED (v1.0.8.5, May 2026) | Updated | https://pypi.org/project/nepali-datetime/ |
| 88 | JS bikram-sambat / nepali-date-converter | bikram-sambat exists but undocumented; nepali-date-converter UNVERIFIED | Updated | https://www.npmjs.com/package/bikram-sambat |
| 89 | Dr Lal PathLabs Smart Report sections | CONFIRMED | None | https://lalpathlabs.com/about-smart-report |
| 90 | Metropolis has an equivalent smart report | UNVERIFIED | Page showed no Smart Report content | https://www.metropolisindia.com/about-smart-report |
| 91 | CrelioHealth smart report: score /100 with Fair/Good | CONFIRMED (score, "Fair") / WRONG ("Good" not shown) | Corrected | https://creliohealth.com/solutions/smart-report/ |
| 92 | CrelioHealth "4 of 7" areas; In range/Borderline/Out of range | CONFIRMED | Noted results use High/Low | same |
| 93 | CrelioHealth trend page across last 4 visits | WRONG (partial) | Only HbA1c spans 4 visits; others 2 | same |
| 94 | CrelioHealth "Promote Lab Services" pages | CONFIRMED | None | same |
| 95 | CrelioHealth human review of AI content | CONFIRMED | Quote added | same |
| 96 | Healthians Smart Report 3.0 official section list | UNVERIFIED (as marked) | Left marked (client sample in 00-scope §5 remains the spec basis) | — |
| 97 | Delta-check thresholds as universal values | UNVERIFIED (as marked) | Left marked | — |

**Pass 1 totals:** 97 claims checked, counted by first-listed verdict: 58 CONFIRMED (several only partly), 15 WRONG (corrected; 3 of them were wrong citations, now UNVERIFIED), 2 OUTDATED (omissions added; #45 and #83 also carry OUTDATED risk), 22 UNVERIFIED (marked in text).

---

## Verification log — Pass 2 (consistency, 2026-11-05)

Scope: cross-file consistency of 01/02/03 against each other and against 00-scope-baseline.md. The authoritative resolved values are now in `04-consolidated-decisions.md`. No REQ IDs renumbered.

| Topic | Files involved | Conflict | Resolution | Source |
|---|---|---|---|---|
| WhatsApp 1 Oct 2026 pricing changes | 01 §4.5, 03 §9.1 / REQ-ARCH-082 | 01 stated the in-window utility charge and the 1,000 service-message allowance as fact (BSP-confirmed). 03 said Meta lists no Oct-2026 change and that in-window sends are free | Both files now say "reported by BSPs, not confirmed on Meta's pricing page — UNVERIFIED". Meta's current docs path also shows no change (rate cards effective 1 Apr 2026). Cost model budgets the worse (BSP) case | https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing ; https://developers.facebook.com/docs/whatsapp/pricing ; https://respond.io/blog/whatsapp-pricing-change-2026.md |
| WhatsApp PDF attachment | 01 §4.5, 02 REQ-SEC-007/070, 03 REQ-ARCH-083, 00-scope §7.1 | 01 called the "PDF document header" template the standard pattern. 03/02 require link-only, with no PHI through Meta | Link-only (OTP-gated portal) is the default. PDF attachment only as a tenant opt-in with founder approval + patient consent. "Standard pattern" marked UNVERIFIED | 00-scope §7.1; internal |
| Report QR token | 01 §1.4, 02 REQ-SEC-093, 03 D11 / §5.4 / REQ-ARCH-049 | 01 said "signed URL"; 03 decided on a random-token lookup. The 02 and 03 field lists differed | Random ≥128-bit CSPRNG server-stored token. One field list: lab name, masked name/initials, panel names, issue date/time + version, valid/superseded. Revoked = not-found response | internal (03 D11 rationale) |
| IRD invoice numbering / immutability | 01 §4.1, 03 §3.7 / D9 | 01 listed "chronological, gapless" as verified. 03 Pass 1 found the source says only "chronological order" | 01 now says chronological (verified, community source) and gapless (design choice, UNVERIFIED as law). Both files: no edit, no delete — backed by the NPR 500,000 penalty (Pioneer Law summary of the 2072 Procedure) | https://discuss.frappe.io/t/compliance-requirement-that-must-be-fulfilled-to-get-approval-from-tax-authority-in-nepal/34532 ; https://pioneerlaw.com/?p=551 |
| Ingest idempotency key | 01 §3.3, 03 §6.4 / REQ-ARCH-058 | 01 keyed on (instrument, sample, analyte, run time). 03 keyed on (instrument, MSH-10) or (instrument, sha256(raw)) | Both levels kept: message-level dedupe (03) + result-level uniqueness (01) | internal |
| Bridge agent OS | 01 §3.3, 02 §6, 03 §6.3 / D12 | 01 said "Windows/Linux box". 03 said "ancient lab PCs". Go ≥1.21 requires Windows 10 / Server 2016 | Windows 10/11 or Server 2016+ only. Linux deferred until 02 §6 controls have Linux equivalents | https://go.dev/doc/go1.21 |
| JS B.S. library version | 01 §4.8, 03 §3.6 | 01: bikram-sambat v1.7.0; 03: 1.8.1 | 1.8.1 (9 Jun 2026, Apache-2.0) per the npm registry. 01 now points to 03's verified scoped converters. The B.S. year range is UNVERIFIED per library in both files. *Pass 3: ranges determined — bikram-sambat ends at 2090 B.S. (insufficient); see §4.8 and 04 D13* | https://registry.npmjs.org/bikram-sambat |
| Khalti lookup status strings | 01 §4.3, 02 §2 | 01 used "Canceled/Failed"; 02 used "User canceled" and HTTP codes | Exact strings from the docs table: success = Completed; failed = User canceled, Expired (also match the prose's "Canceled"/"Failed"); hold = Pending, Initiated, Refunded, Partially Refunded, unknown | https://docs.khalti.com/khalti-epayment/ |
| Smart-report LLM external API | 01 §5.3, 00-scope §7.1 | 01 allowed de-identified calls to "any external API" | A foreign API needs founder approval (only the email relay is pre-allowed). Default: self-hosted model in Nepal | 00-scope §7.1 |
| SMS gateway residency | 01 §4.4, 03 §9.1, 00-scope §7.1 | The baseline says SMS/WhatsApp route abroad; 03 called Sparrow/Aakash "local" | Hosting location UNVERIFIED. Treat as cross-border until confirmed; no PHI in SMS | 00-scope §7.1 |
| Phasing vs client formula | 01 §6, 02 header, 03 §7, 00-scope §1 / §6.4 | 01 puts the native apps in Phase 3 (B2B portal and live gateways later too), while 02/03 assume these components without phase tags and the client formula names the apps | Note added under the 01 §6 table. App phasing is BLOCKED pending the client priority ranking. Auto-verify is Phase 2 (03 REQ-ARCH-063 tagged). Gateway reqs apply from Phase 1.5–2; the append-only ledger from Phase 1 | 00-scope §1, §6 |

**Pass 2 totals for this file:** 11 cross-file conflicts touched 01 and were fixed here. Full cross-set list: 27 (see 04).

---

## Verification log — Pass 2b (primary-source corrections, 2026-11-05)

Source of every change: `05-pass2-critical-recheck.md` (05). Precedence: 04 overrides this file.

| Item | Old | New | Source (from 05) |
|---|---|---|---|
| §4.1 legal basis | 2072 Procedure "sets these requirements"; 2074.09.16 supersession UNVERIFIED | VAT Act s.14A + Electronic Invoice Procedure 2074 (in force 2074/09/16, 4th amdt 2076/09/09); 2072 historical | 05 T3, item 29 |
| §4.1 bullets 1–2 | One-time IRD certification (developer) + per-taxpayer use approval | Listing by self-certification (cl.3), Annex 2 letter, lab permission from tax office (cl.4, Annex 3), inspection (cl.9) | 05 T3 (L3 row) |
| §4.1 fines bullet | NPR 1,000 per instance; NPR 500,000 for software permitting modification/deletion | NPR 500,000 on the taxpayer (s.29(1)(g2)); NPR 10,000 non-issuance; NPR 1,000 buyer's fine | 05 T3, item 30 |
| §4.1 "The LIMS provider … certification" | needs software certification | needs software listed with IRD (self-certification) | 05 T3 (L3 row) |
| §4.1 CBMS bullet | real-time sync of every invoice | real-time only for IRD-designated taxpayers; capability required; + cl.6 requirement bullet (SQL DBMS, activity log/backup, timestamp/active flag/user, Excel/XML/PDF export, manual/help) | 05 T3 (L6 row) |
| §4.1 chronological bullet note | Pioneer Law support for no-edit/no-delete | + primary confirmation (s.29(1)(g2), cl.6(ख)/(ट), cl.6(ङ) serial per FY) | 05 T3 (L5/L7 rows) |
| §4.1 IRD PDF note | "not readable in this pass" | read in Pass 3; = Procedure 2074 | 05 T3 |
| §4.1 threshold | *Pass 1:* current threshold Rs 200 million | Pass 1 secondary only, UNVERIFIED; + IRD primary notices (Rs 10 crore from 2079/04/01; Rs 35 crore CBMS, undated) | 05 T3, item 32 |
| §4.1 multi-tenant note | multi-tenant SaaS UNVERIFIED — ask IRD | cl.7(ख) requirements; interpretation open; billing isolatable per tenant (04 D16/B17) | 05 T3, item 31 |
| §4.2 | — | + Health Service Tax (code 11442) UNVERIFIED → auditor; Finance Bill 2081 kit removal | 05 T3/T4, item 33 |
| §4.3 Khalti | (example 1800 s) | sample 1800 s; production link 60 min default; read expires_at | 05 T5, item 34 |
| §4.5 | Free Entry Point messages stay free (respond.io); Pass 2 "no 1 Oct 2026 change" | 72 h free (Meta); 1 Oct 2026 Nepal-specific utility/auth rates (Meta); in-window charging BSP-reported/UNVERIFIED | 05 T1, item 35 |
| §4.7 | Applies to public bodies and Nepali corporates | + s.12(4), s.29 bind any person → staff personally liable | 05 T12, item 36 |
| §2.3 AST | EUCAST "I" sentence only | + CLSI I^, colistin I/R; CLSI "I" ≠ EUCAST; store category + standard + version | 05 T10, item 37 |
| §3.2 Mindray rows; §3.4; log #31–33 | Scribd copies treated as confirmation | + "UNVERIFIED from primary — unofficial Scribd copy only; 05 T11" | 05 T11, item 38 |
| §4.8 | check range past 2090 B.S. | + ranges per library; bikram-sambat insufficient; proposed JS/Dart pair + shared golden table | 05 T13, item 39 |
| Log #37, #38, #50, #51; Pass 2 table (JS B.S.) | Pass 1 verdicts | Pass 3 verdicts appended (2074 current; 2072 historical; fines corrected; Rs 200M UNVERIFIED; cl.7(ख); ranges determined) | 05 T3, T13 (leftover-grep fixes) |
