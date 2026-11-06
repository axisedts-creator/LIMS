# 00 — Scope Baseline (Ground Truth)

This file records **only confirmed inputs** from the client and anchor lab. It contains no recommendations.
Every other document in this project must treat this file as the source of truth for "what the client said".
Anything NOT in this file that appears in later documents is an assumption or a research finding and must be labelled as such.

- Project: multi-tenant cloud LIMS ("LIMS", working name) sold to multiple labs.
- Vendor/owner of codebase: the LIMS provider (Kathmandu). Ownership/revenue terms with anchor client: **NOT settled — open**.
- Anchor client: Metro Labs (Kathmandu diagnostic lab chain; relation: lab of the founder's father's company group).
- Data residency: all patient data and traffic stays on servers in Nepal.
- As-of date of these inputs: 2026-11-04 (questionnaire returned on paper; extra wishlist sheet; two sample report PDFs).

## 1. Facts from the answered questionnaire (section G, handwritten)

| # | Question | Client's answer (verbatim where legible) |
|---|---|---|
| G1 | Only for your lab, or sell to other labs too? | "Selling to Multiple clients" |
| G2 | Patients per day | "1 – 500/day" |
| G3 | Branches and collection centres | "20" |
| G4 | Lab machines (brand/model) | "Autobio, Mindray, Getein, etc." (exact models NOT provided) |
| G5 | Need IRD-approved billing? | "Yes" |
| G6 | Current software | "eLabs" (migration from it will be needed; data export format unknown) |
| G7 | Test list + current report | Current report provided as PDF (Metro Labs, 22 pages). Test list with prices: NOT yet received |
| G8 | Deadline and budget | Left blank (user instruction 2026-11-05: ignore deadline/money for planning) |

Handwritten note on page 1 header: **"Software + Website + APP (Patient APP, Phlebotomy APP) + Smart AI report"** — this is the client's own top-level product formula.

## 2. Features ticked YES in the questionnaire (all of A–F)

Every feature line in sections A–F was ticked Yes; none ticked No or Not sure. Lists reproduced:

### A. Patient registration and billing
1. Register patient, tests and payment on one single page
2. Search patient by name, mobile number or lab code (annotated "All")
3. Mark patient as OPD, IPD, cash or credit
4. Select which collection centre sent the sample
5. Select the referring doctor (and add a new doctor quickly)
6. Search tests by short name (e.g. CBC) or by package
7. Upload the doctor's test request form (photo/scan)
8. Give discount on a test or full bill, with reason and who approved it
9. Payment by cash, card, eSewa/Khalti/Fonepay QR, or part payment
10. Extra charge for urgent tests, with an urgent mark for the lab
11. Send SMS to patient when tests are registered
12. Print bill receipt with lab letterhead

### B. Samples
1. Print barcode sticker for each sample automatically
2. Technician accepts or rejects a sample (clotted, haemolysed)
3. See the status of every patient (collected, in lab, ready, printed)

### C. Test results
1. Results come directly from lab machines (no typing)
2. Show the patient's previous results while entering new ones
3. Short codes for common comments (e.g. RBC morphology)
4. Auto-calculate results that use a formula
5. Two-step approval: technician first, then pathologist
6. After approval, only the pathologist can change a result
7. Show results as a graph for repeat patients

### D. Reports
1. Stop the report until the patient pays the due balance
2. Send report by WhatsApp
3. Send report by email
4. Send report to referring doctor and collection centre
5. Add outside (outsourced) lab reports into one combined report
6. QR code on report to check it is real
7. Print with or without letterhead; add logo, signature, watermark
8. Release many reports at once (bulk release)
9. Radiology report formats (X-ray, USG) with images

### E. Admin and accounts
1. Create staff logins, give roles, lock a user
2. Manage collection centres, doctors and affiliated hospitals
3. Different price lists for each doctor, hospital or collection centre
4. Edit price lists in Excel and upload back
5. Track commission/incentive for referring doctors
6. Bills for companies or hospitals on credit (monthly bill)
7. Daily cash collection report by staff and payment method

### F. Owner reports and dashboard
1. Dashboard: patients, income, tests done, reports pending
2. Income by department (hematology, biochemistry, radiology)
3. Which doctor and collection centre sends the most patients
4. Pending test list and print worksheets for technicians

## 3. Client's extra wishlist (separate sheet, reproduced; reads like a vendor comparison/offer sheet)

1. Online cloud or server based; unlimited users; unlimited collection centres / franchise based
2. Complete lab software with Microbiology, Molecular, Histo, IHC, Speciality segment, Cytogenetics, etc.
3. 7 instruments bi-directional interface including urine analyser and microbiology ID/AST system with graphs; picture and PDF import from results like HbA1c (HPLC), urine, allergy, etc.
4. Email/SMS/WhatsApp module
5. Bi-directional integration with their own developed Patient App & Phlebotomy App: test booking, real-time sample status, report download PDF, smart report analysis/download
6. Complete patient registration, billing; comprehensive B2C business management module; comprehensive B2B business management module (sample to result); Accounting; Financing; Business intelligence & MIS; comprehensive accounting module
7. Complete real-time analyser-connected Inventory module (stock, CPT calculation, real-time consumption, expiry, per test/cal/QC consumption, daily consumption, wastage, PO, analyser-wise consumption), supply management
8. Smart report feature in website and App (as per provided sample)
9. Comprehensive user and management training
10. B2B client portal online by web and mobile app (B2B partner app): sample tracking and monitoring status, report download, referral doctor management
11. B2C patient reminder management, patient appointment management, enquiry management, B2C dashboard management, patient document management (prescription slips, old report scanning/import/storage)
12. Loyalty card, reward point system, discount coupon, membership card, smart report module
13. Queue management, front desk management, appointment slot management, CCRM (customer care & relationship management), kiosk management, patient portal in website for report access
14. X-ray, USG, Endoscopy reporting system
15. TAT management
16. QC module: real-time LJ curve, Westgard rules, of each LIS analyser etc.
17. HR, salary/leave software, employee competency/efficiency & app
18. Marketing communication, sales team management by app, reporting and recording, etc.
19. "Branch lab software – 1 set Free, other brand need to fix price" (vendor-pricing language; confirms the sheet is from a competing vendor's offer)

## 4. Metro Labs current report — format facts (from 22-page sample PDF)

- Brand: METROLABS, "Leading with Quality", ISO 9001:2015 badge, green/lime theme.
- "Sample Collected At": collection-centre code + name (e.g. `C000000002-HOME COLLECTION`) with address block (New Baneshwor, Kathmandu).
- Patient block fields: Name; Age/Gender ("43 Years/MALE"); Reg No (`0001EE000996`); Barcode No (`E1100001677`); Sample Coll Dt; Sample Rcv Dt; Reg Date; Reported Date (all `DD/MM/YYYY HH:MM AM/PM`, A.D. dates); Report Status ("Final"); Referred By ("SELF").
- Results table: columns = Tests | Results | Biological Ref Range | Units. Grouped by package (e.g. "METRO HEALTH PACKAGE (ELITE) (MALE)") then test panel (CBC comprehensive with ESR) then sub-headings (RBC parameters, WBC parameters, Absolute counts, Platelet parameters, Reticulocyte parameters, Special parameters e.g. NLR, PLR, Mentzer Index). Every analyte line carries `METHOD : …` underneath (e.g. Fluorescence Flowcytometry, Derived RBC Parameter, Calculated, Hexokinase, Wintrobe).
- Abnormal flags: bold value + "High"/"Low" tag left of value.
- "Specimen:" line at panel end (e.g. EDTA WHOLE BLOOD; FASTING PLASMA FL.).
- Footer: two signatories (Dr. Sizan Thapa, MD Pathology, NMC No. 7788; Dr. Sonali Mishra, MD (AIIMS-INDIA), Consultant Pathologist, NMC: 20151) with signature images; QR code; "Page N Of 22"; disclaimer lines ("Authorized signatory nominated by Lab Director…", "not subject to use for any medico-legal purpose"); contact strip (email, phones incl. WhatsApp, website, address).
- Departments observed across pages: Hematology (CBC+retic+ESR), Biochemistry (glucose, HbA1c, lipid, LFT, KFT, iron studies, vitamins, electrolytes), Immunology/serology, Clinical pathology (urine), Stool examination, Hormones. One per-page header repetition of full patient block.

## 5. "Smart AI report" sample — Healthians Smart Report 3.0 (62-page PDF) — observed sections

1. Cover (brand, booking ID, NABL/CAP badges, QR "credibility check… with machine data").
2. "Personalized Summary & Vital Parameters": Health Score (NN out of 100, "calculated from test reports"); 10 organ/parameter tiles each with key value + status ("Everything looks good" / "Concern").
3. "Report Summary": narrative patient summary; "Summary of Deranged Parameters" grouped (vitamins, inflammation, sugar/cholesterol, blood counts); "Suggestions for Improvement" (diet, activity, hydration, monitoring).
4. Full department-wise classical results pages (biochem, immunology, allergy ELISA panels with food images, etc.), each with method, interpretation blocks, clinical remarks, pathologist signature (MBBS/DCP, DMC number), SIN/barcode.
5. "Health Advisory": BMI/height/weight tiles; lifestyle data tiles (mostly "No Data"); suggested nutrition do's/don'ts; suggested lifestyle; "Suggested Future Tests" with specific re-test intervals (e.g. HbA1c every 3 months).
6. Wellness pages (activity, balanced diet, stress management).
7. "Supplement Suggestions": maps deranged parameters to the vendor's own herbal supplements with order hotline (commercial upsell pages).
8. App/services promo pages.

## 6. Open items the client still owes

1. Test list with prices and reference ranges (Excel) — promised "Pdf" per questionnaire note.
2. Exact analyser model list (not "etc.").
3. eLabs export/migration sample.
4. Module priority ranking, budget, deadline (user has deferred deadline/budget for now).
5. Ownership/licensing terms between the LIMS provider and anchor client.

## 7. Constraints fixed by the user (the LIMS provider founder)

1. Data and traffic stay in Nepal; transactional email relay is the only allowed foreign touchpoint pattern seen in prior the LIMS provider projects (to confirm per-integration; WhatsApp/SMS gateways inherently route abroad — flag in docs).
2. Work must be split into big chunks that multiple AI coding agents can build **in parallel without colliding** (no shared-file edits across chunks).
3. Seven document types per chunk (PRD, TRD, App Flow, UI/UX brief or API style guide, Backend Schema slice, Implementation Plan, Security requirements), written so a coding agent needs no guessing.
4. No hallucinations, no false claims, no shortcuts: every factual claim sourced or labelled assumption; two verification passes over research; review pass over final docs.
5. Real patient PDFs provided by the client are confidential: never commit them to a repo, never paste into AI coding tools; use synthetic data everywhere.
