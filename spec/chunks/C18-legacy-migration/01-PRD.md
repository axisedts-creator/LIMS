# C18 Legacy Data Migration (from eLabs) — 01 PRD

Status: DRAFT, 2026-11-06. Chunk **C18**, phase **blocked (B4)** (01-CHUNK-MAP §2). Owned path: `tools/migration/**` and the Postgres schema `migration_staging` (01 §3; DDL written by C0 from `05-SCHEMA.md`). User-manual pages: `docs/manual/migration/` (01 §3 "owning chunk").

Inputs, in precedence order: `research/00-scope-baseline.md` (00) → `research/04-consolidated-decisions.md` (04) → `program/03-INTERFACE-CATALOG.md` (03-IC) → `program/01-CHUNK-MAP.md` (01), `program/02-CONVENTIONS.md` (02-CV) → the Wave-1 chunk schemas this chunk loads into (C3, C4, C5, C6 `05-SCHEMA.md`).

## 0. Read this first: what is blocked and what is not

| Part | State | Why |
|---|---|---|
| eLabs export format, field list, file types, identifiers, time zone, delta capability, PDF availability | **BLOCKED B4** (04 §13; 00 G6 "data export format unknown"; 00 §6 item 3) | The client has not sent an export sample |
| eLabs → canonical transformer (`tools/migration/src/sources/elabs/`) | **BLOCKED B4** — not written. No eLabs table name, column name, file format or API appears anywhere in this chunk | Writing it now would mean inventing facts |
| Canonical intermediate format, staging schema, validation rules, patient matching, dry-run, reconciliation, load through owner ports, cut-over runbook, rollback, purge | **Specified here** (DECISION) | Every rule depends only on our own target schemas, which are known |
| Treatment of historical invoices and dues | **BLOCKED B6/B7** (auditor/IRD) | 04 L5–L8: our invoices are immutable, chronological, gapless per (tenant, FY); importing another software's invoices touches that sequence |

**Build gate (04 §13 B4 default, mirrored in 07-BLOCKERS B4).** 04 §13 and 07-BLOCKERS B4 state the same default (aligned by CR-C18-010, 08 R15): "No migration build. C18's documents specify the canonical export format, staging, mapping, validation and cut-over runbook (design only); no DDL, ports or tool code before the client delivers the eLabs export sample." This document set is that requirements doc plus target mapping plus the pipeline design the lead asked for. **No code is built until B4 is lifted** (eLabs sample received, 08 F-06); the only task allowed before that is T00, and every other task waits for the gates in 06-IMPLEMENTATION-PLAN §1 (08 A19 D-132). If the founder later changes F-06, 08 §5.1 records it and the gates are revisited. The former wording mismatch between 04 and 07 was raised as CR-C18-010 (ACCEPTED in 08). CR-C18-001…007 are DEFERRED in 08 until B4 lifts (founder timing, 08 §5 F-06).

## 1. Purpose

Move a lab's data out of its previous software (first case: Metro Labs on "eLabs", 00 G6) into the LIMS, so that:
1. returning patients are found under their old lab code (00 A2 "search … by lab code") and are not re-created as duplicates (06-GLOSSARY "Patient": duplicates break previous results and trends);
2. a technologist sees a patient's **previous results** beside new entries and as a **trend graph** from day one (00 C2, C7; research 01 §7 question 11 "needed for previous-results/trends on day one");
3. staff can open the patient's **old report PDFs** (00 §3 wishlist 11 "old report scanning/import/storage" — only the narrow legacy-report part; the generic document vault is DROPPED, 04 §12);
4. the lab's masters (tests, prices, doctors, credit parties) are brought over **through the owners' own import paths** (C3 Excel import, C2 admin screens), not loaded behind their backs;
5. nothing the previous software issued as a **tax invoice** is re-issued, renumbered or mixed into our IRD invoice sequence (04 L5–L8).

C18 is a **one-time-per-tenant, operator-run toolchain**, not a product screen. It runs only on the LIMS provider's Nepal servers (04 S1) and is reusable for the next lab with a different source system (only the source transformer changes).

## 2. Users and roles

C18 has no HTTP API and no web screen (01 §3: owned path is `tools/migration` only). Its "users" are operators of a CLI on the migration host and the lab's representatives who decide and sign off.

| Actor | Who | How they act | Authority (codes from 03-IC §11 or raised by CR) |
|---|---|---|---|
| Migration operator | The LIMS provider platform engineer with `platform_superadmin` (03-IC §11) and an `ops_admin` host account (C1 04-UI-UX §2) | SSH over WireGuard to the migration host; runs `lims-migrate` | Host access + DB login role `lims_migration` (CR-C18-001). Loads run as the **migration system actor** holding only `frontdesk.patient.import_legacy`, `lab.legacy_result.import`, `reporting.legacy_document.import` (CR-C18-002/003/004) |
| Second operator (four-eyes) | Another the LIMS provider engineer or the founder | Approves a load (`lims-migrate approve`), a void (`void approve`) and an early purge (`purge approve-early`), each from **their own** Unix account on the host (mapped through `LIMS_MIGRATION_OPERATOR_MAP`) | Same host access; must differ from the operator who staged the run or made the request (DECISION, REQ-SEC-055 analogue for bulk privileged actions; 08 A19 D-133) |
| Lab migration lead | Person named by the tenant (e.g. lab IT / quality manager) holding `tenant_admin` (03-IC §11) | Sits with the operator during review (in person or over a the LIMS provider-controlled screen share of the host session); decides patient-match pairs and crosswalk entries; signs the paper/PDF sign-off form | The lab lead does not authenticate to the CLI. Decisions and the sign-off rest on the signed paper sign-off form: the operator records the lead's membership id **and the form reference** on every `match decide` and on `signoff` (US-10; 08 A19 D-133; listed for the security reviewer in 07 §4) |
| Lab finance contact | Lab `finance` role | Receives the dues/invoice reconciliation list (US-15) | none in C18 |
| Lab staff after go-live | `lab_technologist`, `pathologist`, `front_desk` | See migrated data inside C4/C5/C6 screens (owners' scope) | `frontdesk.patient.read`, `lab.result.read`, `reporting.legacy_document.read` (CR-C18-004) |

## 3. Problems this chunk solves

| # | Problem | Source |
|---|---|---|
| P1 | Without history, previous results, delta checks and trend graphs are empty for every returning patient on day one | 00 C2, C7; research 01 §7 q11 |
| P2 | Re-registering every returning patient creates duplicate patient rows | 06-GLOSSARY "Patient"; C4 PRD P2 |
| P3 | Patients and doctors quote old lab codes and old reports | 00 A2, 00 §3 item 11 |
| P4 | Re-keying 20 centres' price lists and the test master by hand is error-prone | 00 E3, E4, G3 |
| P5 | Copying invoices from another software into an IRD-listed billing system can break immutability/sequence rules and expose the lab to VAT Act penalties | 04 L5 (s.29(1)(g2) NPR 500,000 on the lab), L6, L7 |
| P6 | Migration data is the entire patient history of a lab — the largest PHI set the project will ever move in one go | 04 S1; 00 §7.1, §7.5; Privacy Act health = sensitive (04 L17) |

## 4. Scope

### 4.1 In scope

| ID | Item | Client baseline | Notes |
|---|---|---|---|
| IS-1 | **Canonical intermediate format v1** (CSV + JSON manifest + PDF files) that any legacy extract is transformed into first | 00 G6 | Spec in 02-TRD §6 (DECISION) |
| IS-2 | `lims-migrate` CLI in `tools/migration` (verify, stage, crosswalk, validate, match, dry-run, report, approve, load, verify-load, sign-off, void, purge) | 00 G6 | 04-UI-UX |
| IS-3 | `migration_staging` schema (staging tables, run ledger, issues, crosswalks, reports) never exposed to API roles | 01 §3 | 05-SCHEMA |
| IS-4 | Validation rules: structural, referential, domain, duplicates; issue codes | 00 G6 | 02-TRD §8 |
| IS-5 | Conservative patient matching/dedup: never auto-merge; never on name only | 00 A2; 06-GLOSSARY "Patient" | 02-TRD §9 |
| IS-6 | Patients → C4 through `LegacyPatientImportPort` (CR-C18-002); legacy lab code kept as searchable alias | 00 A2 | owner: C4 |
| IS-7 | Historical **approved/final** results → C5 `lab.legacy_results` through `LegacyResultImportPort` (CR-C18-003); shown in previous results and trend | 00 C2, C7 | owner: C5 |
| IS-8 | Historical report PDFs → C6 `reporting.legacy_documents` through `LegacyDocumentImportPort` (CR-C18-004), malware-scanned and sanitised as untrusted files (04 R7) | 00 §3 item 11 (narrow part) | owner: C6; staff view only |
| IS-9 | Masters: generate C3 `catalog_master`, `price_list`, `referrers` and `credit_parties` (CR-C18-008, ACCEPTED; sheet `CreditParties`) workbooks from canonical master files, for the lab to review and upload through C3's import (C3 PRD §4 "C18 may later produce an Excel file in C3's template"); centres/branches entered in C2's admin screens | 00 E2, E3, E4; C3 02-TRD §8.2 | owners: C3, C2 |
| IS-10 | Crosswalk tables legacy code → target id (centres, doctors, credit parties, credit-party kinds, tests/analytes, units, specimen types, sex, flags) | — | 05-SCHEMA |
| IS-11 | Dry-run reconciliation report (counts, totals, checksums, stratified sample checks) and post-load verification | — | 02-TRD §10 |
| IS-12 | Cut-over runbook (rehearsal, freeze window, delta load, go/no-go, sign-off) and rollback plan | — | 03-APP-FLOW §6–§7 |
| IS-13 | Open dues, credit-party balances and historical invoices: **staged and reported only** (reconciliation list for the lab's finance); no load | 00 E6; 04 L5–L8 | BLOCKED B6/B7 for any load |
| IS-14 | Data protection: Nepal host only, no laptop copies, encryption at rest and in transit, audit of every command, PHI-free logs, staging purge after sign-off | 00 §7.1, §7.5; REQ-SEC-007, 125, 136, 139 | 07-SECURITY |
| IS-15 | Synthetic canonical-package generator for tests | 00 §7.5; REQ-SEC-136 | no real data in tests |

### 4.2 Out of scope (explicit)

| Item | Why / where instead |
|---|---|
| eLabs-specific extraction and transformation | BLOCKED B4 — added as `sources/elabs/` once the sample arrives |
| Re-creating historical visits as `frontdesk.orders`, specimens, `lab.results`, `reporting.reports` | Would allocate registration numbers/barcodes, run state machines and emit domain events (SMS, specimen creation, report release) for past visits. History lives in dedicated legacy tables instead (DECISION D-1) |
| Importing eLabs invoices as `billing.invoices`/credit notes; re-syncing them to CBMS; continuing eLabs invoice numbers in our counter | 04 L5–L8; BLOCKED B6/B7. Default: not loaded (US-15) |
| Recording payments of eLabs dues in our ledger | Ledger entries belong to our orders/invoices (04 P1); BLOCKED B6/B7 |
| Re-rendering legacy results into our report template, or giving legacy PDFs a QR verify token | Would present eLabs reports as reports of this system (misleading; 04 R3 verify shows only our released versions) |
| Patient portal / WhatsApp / patient app delivery of legacy PDFs | Not requested; staff-only in v1 (DECISION D-6) |
| Staff users, passwords, roles, sessions | Re-created in C2 (passwords are never migrated — REQ-SEC-060/076) |
| eLabs audit logs, instrument raw messages, QC data, inventory, micro culture work-ups, histology blocks | No consumer; the lab keeps eLabs read-only as an archive (03-APP-FLOW §6 step 12) |
| Structured micro/AST and anatomic history | Imported only as legacy PDFs (IS-8); structured import would need C10/C11 tables (Wave 2) |
| A web review screen for duplicates/crosswalks | `migration_staging` is never exposed to API roles (01 §3); review is in the CLI on the host. A web screen is a later CR |
| Merging patient rows already in our system | C4 merge is deferred (C4 PRD §4.2) |

## 5. Decisions taken in this PRD

| ID | Decision | Rationale |
|---|---|---|
| D-1 | History is stored in **owner-owned legacy tables** (`frontdesk.patient_legacy_refs`, `lab.legacy_results`, `reporting.legacy_documents`), not as orders/results/reports | Avoids state machines, counters, events and IRD exposure for past visits; keeps rollback (void) possible |
| D-2 | C18 writes **only** `migration_staging`; every target write goes through a new owner port called in-process by a migration runtime built from C0's worker core (CR-C18-005) | 01 §5 R1/R2: no SQL into another schema; ports are the synchronous channel |
| D-3 | Patients are **never auto-merged**. Two legacy rows become one patient only by an explicit, recorded human decision, or when the source system itself says they are the same person (its own merge pointer, if the export carries one — BLOCKED B4) | 06-GLOSSARY "Patient"; lead instruction "never auto-merge on name only" |
| D-4 | Only **final/approved** legacy results are imported; preliminary, cancelled or unverified ones are excluded and counted | Previous results/trends use approved values only (C5 AC-11.1) |
| D-5 | Legacy results are shown in history and trend with a visible "Legacy (eLabs)" marker and are **excluded from delta checks by default** (C5 setting proposed in CR-C18-003) | Methods, units and reference intervals of another lab system may differ; a false delta failure blocks verification (C5 AC-12.3) |
| D-6 | Legacy PDFs are staff-viewable only, access-logged, never delivered to patients by this system in v1 | Minimal new exposure surface |
| D-7 | Invoices and dues are staged and reported, never loaded, until the auditor answers B6/B7 | 04 L5–L8 |
| D-8 | Every load needs a passed dry run, a second operator's approval and, at the end, the lab's sign-off; staging PHI is purged after sign-off + 30 days [CONV] | Four-eyes on the largest PHI write of the project; REQ-SEC-139 minimisation |
| D-9 | Migrated patients get a consent row with source `legacy_import` and **all channel flags false**; front desk re-captures consent at the next visit (CR-C18-002) | REQ-SEC-005: we cannot assert consent eLabs may or may not hold; legal basis BLOCKED B16 |

## 6. User stories and acceptance criteria

Notation: `AC-<story>.<n>`. All examples use synthetic tenants `tenant_a` / `tenant_b` (02-CV §11.2). "Package" = a canonical package (02-TRD §6). "Run" = one row of `migration_staging.runs`.

### US-01 Verify a canonical package
As the operator, I want a package checked before anything is staged, so a corrupt or tampered extract never reaches the database.
Every run-addressed command takes `--tenant <code>` (08 A19 D-134); examples below omit it where the tenant is obvious.

- **AC-01.1** Given a package whose `manifest.json` lists `patients.csv` with sha256 X, When `lims-migrate package verify <dir>` runs and the file's sha256 is Y ≠ X, Then the command exits 2, prints `mig.package.checksum_mismatch patients.csv`, and no DB connection is opened.
- **AC-01.2** Given `manifest.format_version` is `"2"`, Then exit 2 with `mig.package.format_unsupported`.
- **AC-01.3** Given a CSV file whose header row differs from 02-TRD §6.4 (missing required column `legacy_patient_key`), Then exit 2 with `mig.file.header_mismatch` naming the file and column.
- **AC-01.4** Given a file containing a byte sequence that is not valid UTF-8, Then exit 2 with `mig.file.encoding_invalid` and the 1-based line number (no cell content printed).
- **AC-01.5** Given a valid synthetic package, Then exit 0 and a summary table of files, row counts and sha256 (first 12 hex chars) is printed.

### US-02 Stage a package
As the operator, I want a verified package loaded into `migration_staging` for one tenant, so validation and review run on the server.
- **AC-02.1** Given a verified package for `tenant_a`, When `lims-migrate run create --tenant tenant_a --kind full --source synthetic` then `lims-migrate stage <run_id> <dir>` run, Then `runs.status = 'staged'`, `run_files` holds one row per file with sha256 and row count, and each `stg_*` table holds exactly the package's row count for that run.
- **AC-02.2** Given the same package is staged again into the same run, Then exit 2 `mig.run.already_staged`; given it is staged into a new run, Then new rows are created under the new run id only.
- **AC-02.3** Given the DB session claims `tenant_a`, When the staging code inserts a row with `tenant_id = tenant_b`, Then the insert fails (RLS WITH CHECK) — proven by a probe test.
- **AC-02.4** Given staging is interrupted after 3 of 7 files, When `stage` is re-run, Then it resumes at file 4 (files already recorded with matching sha256 are skipped) and the final counts equal AC-02.1.
- **AC-02.5** Given the package manifest `tenant_code` differs from `--tenant`, Then exit 2 `mig.package.tenant_mismatch` before any insert; given manifest `source_system` differs from the run's `--source`, Then exit 2 `mig.package.source_mismatch`.

### US-03 Map legacy codes (crosswalk)
As the operator with the lab lead, I want every legacy centre, doctor, credit party, test/analyte, unit, specimen type, sex and flag code mapped to a target, so loaded rows point at real master data.
- **AC-03.1** Given staged results use 140 distinct `(legacy_test_code, legacy_analyte_code)` pairs, When `lims-migrate crosswalk export <run_id> --kind analyte` runs, Then a CSV with 140 rows (codes, display names, occurrence counts, target columns empty or pre-filled from earlier crosswalk entries of this tenant) is written to the run's host directory.
- **AC-03.2** Given an edited crosswalk file mapping a legacy analyte to an analyte id that does not exist in `tenant_a`'s catalog, When `crosswalk import` runs, Then that row is refused with `mig.crosswalk.target_unknown` and nothing from the file is applied (all-or-nothing).
- **AC-03.3** Given a crosswalk row maps legacy unit `mg%` to `mg/dL` with factor `1`, Then results with `unit_raw = 'mg%'` are validated against unit code `mg/dL` and the factor is recorded on each staged row.
- **AC-03.4** Given crosswalk entries exist from a previous run of the same tenant, When a delta run is created, Then they apply without re-entry (`crosswalk_entries` are tenant-level, not run-level).
- **AC-03.5** Given a legacy centre code is unmapped, Then every visit/result/document row using it gets error `mig.ref.centre_unmapped` (no silent default centre).
- **AC-03.6** Given a crosswalk row maps legacy unit `mmol/L` of glucose to `mg/dL` with factor `18`, and a staged result has `value_numeric = 5.5`, `ref_low = 3.9`, `ref_high = 6.1`, Then validation writes `value_numeric_target = 99.0`, `ref_low_target = 70.2`, `ref_high_target = 109.8`, the port row carries those three values with `unitCode = mg/dL` and `unitFactorApplied = 18`, and value and range are never sent in different units (synthetic numbers).

### US-04 Validate staged rows
As the operator, I want every staged row checked against the target rules before any load.
- **AC-04.1** Given a result row whose `legacy_patient_key` is not in `patients.csv` of the run, nor in a run of the run's ancestor chain (via `parent_run_id`) in status `verified` or `signed_off`, nor in any `signed_off` run of the tenant, Then error `mig.ref.patient_unknown` on that row.
- **AC-04.2** Given two `patients.csv` rows with the same `legacy_patient_key`, Then both get error `mig.dup.legacy_key` and neither is loadable.
- **AC-04.3** Given a numeric result with `value_numeric = "12,5"`, Then error `mig.domain.decimal_invalid`; given `"12.5"`, Then accepted as DecimalString.
- **AC-04.4** Given a timestamp `2026-01-02 10:00` with no offset and manifest `source_timezone` absent, Then error `mig.domain.timestamp_no_offset`; with `source_timezone: "Asia/Kathmandu"` it is converted to UTC `2026-01-02T04:15:00.000Z`.
- **AC-04.5** Given a result with `result_status = preliminary`, Then status `excluded` with reason `mig.excluded.not_final` (warning, counted, not an error).
- **AC-04.6** Given validation finished, Then `runs.status = 'validated'` only if error count = 0 for all rows not marked `excluded`; otherwise `validation_failed` and the command exits 3 (04-UI-UX §1 item 4), and `lims-migrate issues <run_id>` lists counts per rule code.
- **AC-04.7** Issue messages contain no cell values of PHI columns (test: plant a synthetic name in an invalid row and assert it never appears in `issues.message` or logs).

### US-05 Review possible duplicate patients
As the lab lead, I want suspected duplicates shown to me and merged only when I decide, so no two people are ever fused by a heuristic.
- **AC-05.1** Given two legacy patients with identical normalised name, identical exact birth date and identical phone, Then a candidate pair of class `strong` is created with `decision = 'pending'`.
- **AC-05.2** Given two legacy patients with identical normalised name only (different or missing birth date and phone), Then **no** candidate pair is created.
- **AC-05.3** Given any candidate pair with `decision = 'pending'`, Then `runs.status` cannot reach `validated` (`mig.match.decisions_pending`).
- **AC-05.4** Given the lead decides `merge` on a pair, Then both legacy keys resolve to one target patient on load, the survivor is the older `first_seen_at`, and both legacy codes are searchable aliases of that patient (C4 port).
- **AC-05.5** Given `lims-migrate match decide --class strong --action keep_separate --by <membership_id> --form-ref <text>`, Then every pending strong pair is decided in one command and each pair records `decided_by_membership_id`, `lab_form_reference` and `decided_at`; without `--form-ref` the command exits 2 `mig.match.form_ref_missing` (08 A19 D-133).
- **AC-05.6** Given a delta run where a legacy patient matches an existing **target** patient by C4's dedupe predicate (normalised name equal, birth year ±1, same phone when given — C4 03-APP-FLOW §2), Then a candidate pair of class `target_possible` is created and must be decided `link` or `create_new`.
- **AC-05.7** Candidate review output masks names and phones (`Te** Pa***** 00**` for the synthetic name "Test Patient 0042", `98xxxxxx42`; rule in 04-UI-UX §4.5) unless `--reveal` is passed; each reveal writes a `run_events` row `patient_reveal` with the pair ids (no PHI).

### US-06 Dry run and reconciliation report
As the operator, I want the full load executed in a rolled-back mode first, so I know every row the owners will accept or reject.
- **AC-06.1** Given a `validated` run, When `lims-migrate dryrun <run_id>` runs, Then every loadable row is sent through the owner ports with `dryRun: true` inside transactions that are rolled back, and no row exists in any owner table afterwards (DB check as owner in the test harness).
- **AC-06.2** Given the dry run finished, Then `reports` holds a `dry_run` report with, per entity: rows in package, staged, excluded (by reason), invalid, would_create, would_link, already_imported, owner_rejected (by reason code).
- **AC-06.3** Given any owner rejection in the dry run, Then `runs.status = 'dry_run_failed'`, `dryrun` exits 3, and `approve` is refused (`mig.run.not_approvable`).
- **AC-06.4** The report contains numeric checksums per mapped analyte (count, sum of `value_numeric_target` as exact decimal — the converted value that is sent to C5) and per document set (count, total bytes, sha256 of the sorted sha256 list); report JSON contains no PHI (schema test with a PHI key denylist).
- **AC-06.5** Given `--sample 50`, Then 50 patients are drawn by stratified random sampling with a recorded seed (strata: years of first visit), and a side-by-side legacy vs would-be-loaded view is printed for review; verdicts `pass`/`fail` are recorded per sample; any `fail` blocks approval.

### US-07 Approve and load through owner ports
As the operator, I want the load to run only after a second operator approves, and to be idempotent and resumable.
- **AC-07.1** Given a `dry_run_passed` run staged by operator A, When operator A runs `approve`, Then exit 2 `mig.approval.same_operator`; When operator B runs it, Then `runs.status = 'approved_for_load'` and an `approvals` row exists.
- **AC-07.2** Given an approved run, When `load` runs, Then rows are sent in batches of ≤ 200 [CONV, = 02-CV §4.1 bulk maximum] in dependency order patients → results → documents, each batch in one transaction that also updates the staging rows' `status`, `target_id`, `batch_id` (atomic with the owner write).
- **AC-07.3** Given the process is killed during batch 57, When `load` is re-run, Then batches 1–56 are skipped (status `committed`), batch 57 is re-sent with the same `batch_id`; if it had committed but the ack was lost, the owner returns `replayed: true` with the stored outcomes (the owner write and the staging update are one transaction, so a batch is never half committed) — final counts equal a run without interruption.
- **AC-07.4** Given a batch re-sent with the same `batch_id` but different content, Then the owner throws `<module>.legacy_batch_conflict` and the load stops with exit 1.
- **AC-07.5** Given the load, Then no domain event of 03-IC §3 is published by any owner and no SMS/WhatsApp/email is enqueued (event spy + NotificationPort fake call count = 0).
- **AC-07.6** Given a load started while `runs.status ≠ 'approved_for_load'`, Then exit 2 `mig.run.not_approved`.

### US-08 Verify the load
- **AC-08.1** Given a loaded run, When `verify-load` runs, Then for every committed batch the owner's `getLegacyBatchSummary` counts and content hash equal the values computed from staging; any difference → `runs.status = 'verify_failed'` and exit 3 (04-UI-UX §1 item 4).
- **AC-08.2** Given documents in the run, Then verification also reports document states (`ready`, `quarantined`, `rejected`, `pending_scan`); `quarantined`/`rejected` are listed by staging row id for the lab to decide; `pending_scan` older than 1 h [CONV] fails verification.

### US-09 Delta load at cut-over
- **AC-09.1** Given a signed-off full run R1 and a later package with 120 new patients, 3 changed patient rows and 4,000 new results, When a delta run R2 (`--kind delta --parent R1`) is staged, validated, dry-run and loaded, Then 120 patients are created, 4,000 results created, and the 3 changed patients are reported as `already_imported` with `changed_fields` listed (demographics in the LIMS are not overwritten — DECISION D-10 in 02-TRD).
- **AC-09.2** Given a legacy result key already loaded with `legacy_version_no = 1` and the delta carries `legacy_version_no = 2` with a different value, Then a new legacy result version is created and version 1 is marked superseded (owner behaviour, CR-C18-003).
- **AC-09.3** Given the delta package is a full re-extract (no delta capability — B4 default), Then rows whose `source_row_sha256` equals the parent run's are classified `unchanged` and not sent; the report states this.
- **AC-09.4** Given R1 is `verified` (not signed off, as in the cut-over runbook, 03-APP-FLOW §6.3) and R2 is created with `--kind delta --parent R1` and carries results for patients loaded by R1, When R2 is validated, Then validation passes for those rows (no `mig.ref.patient_unknown`), the R1 patients' rows are classified via R1's keys (`mig.dup.legacy_key_prior_run`, `unchanged` or `already_imported`, not re-sent as new patients), and the results resolve `patient_id` from R1's `stg_patients.target_patient_id`.

### US-10 Lab sign-off
- **AC-10.1** Given a `verified` run, When `signoff <run_id> --tenant <code> --lab-membership <id> --reference <text>` runs (`--reference` = the signed paper form number, required — 08 A19 D-133), Then `runs.status = 'signed_off'`, a `signoffs` row stores the lab signatory membership id, display name snapshot, reference (e.g. paper form number) and time, and the membership must belong to the run's tenant and hold `tenant_admin` (read through C0 core repository).
- **AC-10.2** Given a run with unresolved quarantined documents or sample fails, Then sign-off is refused (`mig.signoff.blockers_open`) unless each blocker has a recorded lab decision (`accept_exclusion`).

### US-11 Void a run (rollback)
- **AC-11.1** Given a loaded, not signed-off run, When operator A runs `void request <run_id> --reason <code>`, operator B runs `void approve <run_id>` from B's own Unix account (B ≠ A, both mapped in `LIMS_MIGRATION_OPERATOR_MAP`; a `signoffs` row `void_approval` is written) and then `void <run_id>` runs, Then every committed batch is voided through the owner ports in reverse order (documents → results → patients) and `runs.status = 'voided'`.
- **AC-11.2** Given a patient created by the run who has since got a non-legacy order in C4, Then the owner keeps that patient active and reports `not_voidable_in_use`; the void report lists such patients and the run ends `voided_partial`.
- **AC-11.3** Given a signed-off run, Then `void` is refused (`mig.void.after_signoff`); corrections after sign-off are owner-side actions (03-APP-FLOW §7 R2).
- **AC-11.4** Given operator A ran `void request`, When A also runs `void approve`, Then exit 2 `mig.approval.same_operator`; given no `void_approval` row for the latest request, `void <run_id>` exits 2 `mig.void.not_approved`.

### US-12 Purge staging
- **AC-12.1** Given a run signed off 30 days ago [CONV `LIMS_MIGRATION_PURGE_AFTER_DAYS`], When `purge <run_id>` runs, Then all class-E staging rows of the run are deleted, the host run directory is deleted with files overwritten first, and the permanent records (runs, run_events, run_files, batches, reports, signoffs, crosswalk_entries) remain.
- **AC-12.2** Given a run signed off 5 days ago, Then `purge` exits 2 `mig.purge.too_early` unless operator A ran `purge request-early <run_id> --reason <code>` and operator B (≠ A, own Unix account) ran `purge approve-early <run_id>`, which writes a `signoffs` row `early_purge_approval`; `purge` checks for that row (the DB DELETE policy checks it too, 05-SCHEMA §5). There is no free-text approval reference (08 A19 D-133).
- **AC-12.3** Given a run that is the parent of a not-yet-signed-off delta run, Then purge is refused (`mig.purge.child_open`) because the delta comparison needs the parent's row hashes.

### US-13 Masters as owner-import workbooks
- **AC-13.1** Given a package with `masters/tests.csv`, `masters/analytes.csv`, `masters/reference_ranges.csv`, When `lims-migrate masters build <run_id> --kind catalog_master` runs, Then an `.xlsx` with exactly the sheets and column keys of C3 02-TRD §8.2 `catalog_master` and a `_meta` sheet with `template_kind = catalog_master`, `template_version = 1` is written to the run directory.
- **AC-13.2** The tool never calls C3's import endpoint and never writes `catalog.*`; the lab's `lab_manager` uploads the workbook through C3's own import screen (C3 US-17).
- **AC-13.3** Given `masters/doctors.csv`, Then a `referrers` workbook (sheet `Doctors`) is produced; legacy doctor codes that violate `^[A-Z0-9_\-]{1,20}$` (C3 05-SCHEMA `doctors__code__ck`) are left blank (C3 auto-codes them) and listed in the crosswalk file for the doctor mapping.
- **AC-13.4** Given `masters/credit_parties.csv`, When `masters build <run_id> --kind credit_parties` runs, Then a workbook with sheet `CreditParties` and the columns of C3 02-TRD §8.2 (`party_code`, `name`, `kind`, `allows_credit`, `pan`, `contact_phone_e164`, `contact_email`, `billing_address`) is produced: `kind_raw` → crosswalk `credit_party_kind` → `kind` (unmapped → row refused, `mig.ref.credit_party_kind_unmapped`); `contact_phone_raw` → §9.2 phone normalisation → `contact_phone_e164` matching `^\+[1-9][0-9]{7,14}$` (08 A13 P-11; otherwise blank and counted); `allows_credit` = `Y` by default; a `legacy_code` that violates `^[A-Z0-9_\-]{1,20}$` (C3 `party_code` rule) is left blank (C3 auto-codes it) and listed in the `credit_party` crosswalk file for manual mapping.
- **AC-13.5** Given `--kind price_list` without `--price-list-id <uuid>` and `--price-list-code <code>` (copied by the lab from C3's empty template of that list), Then exit 2 `mig.masters.price_list_id_missing`; with them, Then `_meta.price_list_id`/`price_list_code` are those values, `base_version_no = 0`, and every `unit_price_paisa` is written as `unit_price_npr` (NPR, 2 decimals) through `@lims/shared-ts/money`.

### US-14 Migrated data is usable in the owners' screens (integration ACs — owners implement via CRs)
- **AC-14.1** Given a migrated patient with legacy code `EL-0042` (synthetic), When front desk searches by that code, Then the patient is found (C4, CR-C18-002).
- **AC-14.2** Given lab setting `legacy_in_history = true` (proposed default **false**, turned on by the lab after cut-over — 08 A19 D-135) and 3 legacy Hb values and 1 new approved Hb, When the technologist focuses Hb, Then history shows 4 values newest first, the 3 legacy ones labelled "Legacy (eLabs)" (C5 routes #25/#26 call `LabPort.getAnalyteHistory` with `includeLegacy = legacy_in_history`; legacy points have `source: 'legacy'`, `resultId` = `lab.legacy_results.id`, `approvedAt` = `reported_at` — CR-C18-003). With the setting `false` (default), only the 1 new value is shown.
- **AC-14.3** Given a legacy value and a new value 2 days apart that would fail a delta rule, Then `delta_status` is computed against the previous **non-legacy** approved result only (default `legacy_in_delta = false`).
- **AC-14.4** Given a migrated patient with 2 legacy PDFs, When a user holding `reporting.legacy_document.read` opens the patient's legacy documents, Then both are listed and downloading writes an access-log row; a user without the permission gets `403 auth.forbidden`; a `tenant_b` user gets `404 common.not_found` for the document id.

### US-15 Invoices and dues are reported, not loaded (BLOCKED B6/B7)
- **AC-15.1** Given `financial/patient_dues.csv` and `financial/invoice_refs.csv` in the package, Then they are staged, validated (amounts as integer paisa ≥ 0, invoice dates parseable) and summarised in the reconciliation report (counts, total paisa, per fiscal year B.S.), and **no** port call is made for them.
- **AC-15.2** `lims-migrate finance list <run_id>` writes the dues list for the lab's finance contact to the run directory (host only); the report states "Not loaded — treatment pending auditor (B6/B7)".
- **AC-15.3** No code path in `tools/migration` references `billing` (CI grep), and no CR to C4 billing is filed until B6/B7 are answered (draft CR-C18-009 is marked DO NOT FILE).

### US-16 Source transformer slot (BLOCKED B4)
- **AC-16.1** `lims-migrate transform --source elabs …` exits 2 with `mig.source.not_implemented` and the text "eLabs export format unknown (B4)".
- **AC-16.2** The `SourceTransformer` interface (02-TRD §5.4) exists with a `synthetic` implementation used by tests; adding `elabs` touches only `src/sources/elabs/**`.

### US-17 Data protection
- **AC-17.1** Given the CLI is started on a host whose name is not in `LIMS_MIGRATION_ALLOWED_HOSTS` or whose run directory is not on the LUKS-backed migration volume (marker file written by C1 provisioning), Then exit 2 `mig.host.not_allowed` before reading any package.
- **AC-17.2** Log output of a full synthetic run (all commands) contains none of the planted synthetic names, phones, legacy codes or result values (DoD §1.8 log scan).
- **AC-17.3** Every command that opens a DB connection for a tenant writes one `run_events` row with operator, command, argument digest, outcome and counts. `package verify`, `transform`, `--help`/`--version` and `status --metrics` open no tenant transaction and write none (they only log).

## 7. Success metrics

| Metric | Target | Measured by |
|---|---|---|
| Rows unaccounted for | 0 — every package row ends as loaded, already_imported, unchanged, excluded (with reason) or rejected (with reason) | reconciliation report invariant (02-TRD §10.2) |
| Sample check pass rate | 100 % of the 50 [CONV] sampled patients | `samples` verdicts |
| Duplicate patients created by migration | 0 pairs left `pending`; post-go-live "possible duplicates" (C4 worklist) attributable to migrated rows < 1 % of migrated patients [CONV] (same yardstick as C4 PRD §7) | C4 worklist query on `patient_legacy_refs` |
| Freeze window (eLabs stopped → LIMS used) | ≤ 4 h [CONV] for the delta load | cut-over log |
| PHI incidents | 0 (no PHI in logs; no copy off the migration host) | log scan; host audit (C1) |
| Staging purge | within 30 days [CONV] of sign-off | `runs.purged_at` |

## 8. Phase and dependencies (contracts only)

Phase: **blocked (B4)**. When unblocked it runs before the anchor lab's go-live, after Wave 1 owners (C2, C3, C4, C5, C6) have merged the CR'd ports.

| Contract | Owner | Status | Fake until merged |
|---|---|---|---|
| `LegacyPatientImportPort` + `frontdesk.patient_legacy_refs` + consent source `legacy_import` + search by legacy code | C4 | CR-C18-002 (DEFERRED, B4) | C0 fake, created when the CR is accepted after B4 (08 R9: deferred Legacy ports get no stub before) |
| `LegacyResultImportPort` + `lab.legacy_results` + history/trend inclusion (`getAnalyteHistory.includeLegacy`, reserved) | C5 | CR-C18-003 (DEFERRED, B4) | C0 fake, created when the CR is accepted after B4 |
| `LegacyDocumentImportPort` + `reporting.legacy_documents` + bucket `reporting-legacy` (08 R26) + staff list/download endpoints | C6 | CR-C18-004 (DEFERRED, B4) | C0 fake, created when the CR is accepted after B4 |
| Tool runtime (port registry + tenant tx with the `migration` system actor) for `tools/` | C0-0D | CR-C18-005 | none needed for unit tests |
| Role `lims_migration`, `migration_staging` DDL + RLS, system actor `migration` | C0-0B | CR-C18-001 | — |
| Migration host volume, secrets, inbox transfer, role enable/disable runbook, alerts | C1 | CR-C18-006 | — |
| System-actor permission grant and audit for `migration` | C2 | CR-C18-007 | IdentityPort fake |
| `catalog_master` / `price_list` / `referrers` workbook formats | C3 | existing (C3 02-TRD §8.2) | — |
| `credit_parties` import kind (sheet `CreditParties`) | C3 | CR-C18-008 — ACCEPTED in 08; in C3 02-TRD §8.2 | — (C18 produces the workbook, AC-13.4) |

## 9. Blocked items and what is built meanwhile

| # | Blocked | Default meanwhile |
|---|---|---|
| B4 | eLabs export format, sample, delta capability, timestamps' zone, B.S. vs A.D. storage, identifier stability, merge pointers, PDF availability | Design only: canonical format and synthetic generator are specified, not built; no DDL, ports or tool code; only T00 runs (06 §1, 08 F-06, A19 D-132) |
| B6 / B7 | Treatment of historical invoices, dues, credit-party opening balances; cut-over fiscal-year handling | Staged + reported only (US-15); recommendation in 03-APP-FLOW §6.1 to prefer a cut-over at a fiscal-year start (Shrawan 1, 04 L16) as one option for the auditor — not a requirement |
| B15 | Legal retention periods | Migrated legacy rows follow the tenant's `retentionYears` (default 5) like other clinical records; staging is purged regardless |
| B16 | Privacy Regulation 2077 content (legal basis for processing migrated data, notice to patients) | Channel consents false for migrated patients (D-9); founder to obtain counsel view before go-live |
| B12 | Nepal DC/VM provider | Migration host is a role on C1's app-1 VM (CR-C18-006) |
