# C18 Legacy Data Migration — 06 IMPLEMENTATION PLAN

Status: DRAFT, 2026-11-06. One task ≈ one PR (02-CV §12). Paths are under `tools/migration/` unless stated. "AC" = acceptance criteria in `01-PRD.md`.

## 1. Gate before any code

04 §13 and 07-BLOCKERS B4 default (same text since CR-C18-010, 08 R15): "No migration build. C18's documents specify the canonical export format, staging, mapping, validation and cut-over runbook (design only); no DDL, ports or tool code before the client delivers the eLabs export sample." CR-C18-001…007 and 009 are DEFERRED in 08. Therefore (08 A19 D-132; 08 F-06 and 07 B4 are binding and are not re-decided here):

| Gate | Condition | Unlocks |
|---|---|---|
| G-0 | always | T00 only (confirm CR status; no code) |
| G-4 | **B4 lifted** (eLabs export sample + documentation received), 08 F-06 | T01, T02, T14; precondition of every later gate |
| G-2 | G-4 + CR-C18-001 and CR-C18-005 accepted after B4 and merged by C0 (C0 creates the Legacy port fakes when the CRs are accepted) | T03–T08, T12, T15–T17 (against port fakes) |
| G-3 | G-2 + CR-C18-002/003/004/007 merged by C4/C5/C6/C2 | T09–T11 (real owner ports) |
| G-5 | G-3 + CR-C18-006 done by C1 | T13 (host integration), rehearsal T19 |

Gate order: G-4 → G-2 → G-3 → G-5. Every task except T00 requires "B4 lifted (eLabs sample received), 08 F-06". Until then the chunk stays at M0 (documents only). If the founder later changes F-06, 08 §5.1 records it and these gates are revisited.

## 2. Task list

| ID | Goal | Files / paths | Depends on | Done when | Tests | ACs |
|---|---|---|---|---|---|---|
| T00 | Confirm 08 §3 status of CR-C18-001…010 (already registered: 008 and 010 ACCEPTED, 001–007 and 009 DEFERRED); no filing needed | none (no repo paths) | G-0 | status table in 02-TRD §19 matches 08 §3 | — | — |
| T01 | Package scaffold; CSV parser; manifest schema; `package verify`; `transform` (only `synthetic`; `elabs` → `mig.source.not_implemented` until T14); host guard; message catalogue; exit codes | `package.json`, `src/cli/*`, `src/canonical/*`, `src/runtime/host-guard.ts`, `src/runtime/config.ts`, `src/commands/package-verify.ts`, `src/commands/transform.ts` | G-4 | AC-01.1–01.5, AC-16.1, AC-17.1 pass on synthetic packages | unit: RFC 4180 cases, BOM, invalid UTF-8, header mismatch, unknown column, row too large, traversal paths; golden output snapshot | US-01, AC-16.1, AC-17.1 |
| T02 | Pure domain: canonical row types, validation rule functions, normalisation (name, phone, sex), match classifier, union-find, digests, run state machine, sampler; synthetic generator with planted edge cases | `src/domain/**`, `src/sources/{transformer.ts,synthetic/**}` | G-4 | every rule in 02-TRD §8 has a positive and negative unit test; state machine T1–T22 + forbidden examples tested; digest golden vectors fixed | unit | AC-04.x (logic), AC-05.1, 05.2, AC-16.2 |
| T03 | Staging repository + `run create`, `stage` (resumable), `run_events` writer | `src/staging/{db,runs,files,rows,events}.repo.ts`, `src/commands/{run-create,stage}.ts`, `src/runtime/boot.ts` | G-2, T01 | AC-02.1–02.5 on compose PG 17 with `tenant_a`/`tenant_b` | integration; probes (§4) | US-02 |
| T04 | Crosswalk export/import (all kinds), target validation via `ctx.core` and `CatalogPort` (fake) | `src/staging/crosswalk.repo.ts`, `src/commands/crosswalk-*.ts` | T03 | AC-03.1–03.5 | integration with CatalogPort fake | US-03 (incl. AC-03.6) |
| T05 | `validate` set-based SQL rules + `issues` command | `src/staging/issues.repo.ts`, `src/commands/{validate,issues}.ts` | T04, T02 | AC-04.1–04.7; 10× synthetic (≈100 k results) validates within target scaled from 02-TRD §15 | integration; PHI-in-message test | US-04 |
| T06 | Matching: candidate pairs, `match list/decide`, masking, `--reveal` audit | `src/staging/match.repo.ts`, `src/commands/match-*.ts`, `src/cli/output.ts` | T05 | AC-05.1–05.7 | unit + integration | US-05 |
| T07 | Dry run (rolled back), report JSON, sample selection/review | `src/load/{planner,*.adapter}.ts`, `src/report/**`, `src/commands/{dryrun,sample,report}.ts` | T06 | AC-06.1–06.5 against Legacy*ImportPort fakes | integration; report schema PHI-denylist test | US-06 |
| T08 | Approve, load (batches, concurrency, rate caps, resume, retries), verify-load, void (`void request` / `void approve` / `void`), delta runs | `src/load/{loader,verifier,voider}.ts`, `src/staging/batches.repo.ts`, `src/commands/{approve,load,verify-load,void}.ts` | T07 | AC-07.1–07.6, AC-08.1, AC-09.1, AC-09.3, AC-09.4, AC-11.1–11.4 against fakes (fake `failNext`, latency) | integration incl. kill-and-resume test, duplicate batch, conflict, delta on a `verified` parent | US-07, 08, 09, 11 |
| T09 | Switch patients to the real C4 `LegacyPatientImportPort`; consent and search ACs | `src/load/patients.adapter.ts` (no change expected), `__tests__/e2e/patients.e2e.ts` | G-3, T08 | AC-07.x on real C4; AC-14.1; contract suite passes against C4 (run by C4) | e2e compose | US-07, AC-14.1 |
| T10 | Switch results to the real C5 port; history/trend ACs | `src/load/results.adapter.ts`, e2e | G-3, T08 | AC-09.2, AC-14.2, AC-14.3 on real C5 | e2e | US-09, 14 |
| T11 | Switch documents to the real C6 port; scan pipeline states in verify | `src/load/documents.adapter.ts`, e2e | G-3, T08 | AC-08.2, AC-14.4 on real C6 | e2e | US-08, 14 |
| T12 | Masters → C3 workbooks (`catalog_master`, `price_list`, `referrers`, `credit_parties`) | `src/masters/**`, `src/commands/masters-build.ts` | T03 | AC-13.1–13.5; produced workbook passes C3's own import validation in the compose stack (C3 merged) | integration with real C3 import (read-only check: upload in a test tenant) | US-13 |
| T13 | Host integration: C1 container image, metrics textfile, `status --metrics`, alerts registered | `src/runtime/metrics-textfile.ts`, `src/commands/status.ts`, `Dockerfile` under `tools/migration/` (image build config only; deploy is C1's) | G-5, T08 | alerts fire in C1's promtool tests; image scanned (trivy) | promtool test cases (C1), image scan | §16 of TRD |
| T14 | **eLabs transformer** | `src/sources/elabs/**` | **G-4** (B4), T01, T02 | deterministic package from the client's sample; questions in §6 answered and recorded in `sources/elabs/README.md` | unit on a **synthetic re-creation** of the sample's structure (never the real sample in the repo — 00 §7.5) | US-16 |
| T15 | Finance list and report section (no load) | `src/commands/finance-list.ts`, `src/report/financial.ts` | T05 | AC-15.1–15.3; CI grep "no `billing`" | unit + CI rule | US-15 |
| T16 | Sign-off and purge (incl. file shredding, early purge `request-early` / `approve-early`, child guard) | `src/commands/{signoff,purge}.ts`, `src/staging/purge.repo.ts` | T08 | AC-10.1–10.2, AC-12.1–12.3 | integration | US-10, 12 |
| T17 | Security test pack: log scan of full synthetic run, report denylist, probes, CI greps (no foreign schema SQL, no network modules), `--reveal` audit, operator mismatch | `__tests__/{probes,security}/**`, CI config in the package (`package.json` scripts) | T08, T16 | every test in 07-SECURITY §6 present and passing | as listed | US-17 |
| T18 | Runbooks + operator manual + sign-off form + lab FAQ | `runbooks/*.md`, `docs/manual/migration/*.md` | T16 | reviewed by founder; C1 links runbooks | doc review | — |
| T19 | Rehearsal with real client data on the production migration host (no load) | operational | G-4, G-5, T09–T14, T16–T18 | 03-APP-FLOW §6.2 completed; timings recorded; `abandoned` + purged | — | — |
| T20 | Cut-over | operational | T19 | 03-APP-FLOW §6.3–6.5 completed; R1/R2 signed off | — | — |

## 3. Milestones

| Milestone | Contents | Exit criterion |
|---|---|---|
| M0 | documents; CR status confirmed (T00) | 02-TRD §19 matches 08 §3 |
| M1 | pure core (T01–T02) — only after B4 is lifted (G-4) | unit suites green |
| M2 | staging, crosswalk, validation, matching against fakes (T03–T06) | integration suites green on compose |
| M3 | dry run, load, verify, void, sign-off, purge against fakes (T07, T08, T15, T16) | full synthetic rehearsal on compose with fakes |
| M4 | real owner ports (T09–T12) | nightly e2e with real C3/C4/C5/C6 |
| M5 | eLabs transformer (T14) — **B4** | client sample transforms deterministically |
| M6 | host + security + docs (T13, T17, T18) and rehearsal (T19) | rehearsal report accepted by founder and lab lead |
| M7 | cut-over (T20) | lab sign-off; staging purged within 30 days |

## 4. Fakes → real

| Contract | Fake (C0 `packages/fakes`) used in | Switch to real when | Proof |
|---|---|---|---|
| `LegacyPatientImportPort` (fake created by C0 when CR-C18-002 is accepted after B4; no stub before, 08 R9) | T07, T08 | C4 merges CR-C18-002 (G-3) | C4 runs `LegacyPatientImportPort.contract.ts` green; C18 e2e T09 |
| `LegacyResultImportPort` | T07, T08 | C5 merges CR-C18-003 | contract suite + T10 |
| `LegacyDocumentImportPort` | T07, T08 | C6 merges CR-C18-004 | contract suite + T11 |
| `CatalogPort` | T04, T05 | C3 merged (Wave 1) | crosswalk import validates against real catalog in e2e |
| `IdentityPort` (system permissions) | T03–T08 | C2 merges CR-C18-007 | `mig.runtime.permission_missing` test with a permission removed |
| Tool runtime | — (needed from T03) | C0 merges CR-C18-005 | runtime tests in C0 + T03 integration |

Production/staging boot of the tool runtime refuses fakes (02-CV §8.2), so a real run cannot accidentally use one.

## 5. CR candidates foreseen (not yet raised)

| Candidate | To | Trigger |
|---|---|---|
| Owner-written purge function for legacy rows (`lims_owner`, founder-approved) for incident R3 (03-APP-FLOW §7) | C4, C5, C6 + C0-0B | first security review of C18 / incident runbook review |
| Web review screen for duplicate pairs and crosswalks (staff web, lab lead uses it directly) | C0 + new module or C2 | if on-site CLI review proves impractical in the rehearsal |
| C8 analytics: whether legacy data should appear in MIS (default: no — legacy tables are not in any `v_pub_*`) | C8 | if the owner asks for historical income/volume trends |
| Patient portal / app access to legacy PDFs | C6, C16 | lab request after go-live |
| Structured micro/AST history | C10 | Phase 2, if the eLabs export carries structured AST |
| Credit-party opening balances / legacy invoice references | C4 | B6/B7 answered (draft CR-C18-009) |
| `frontdesk` patient merge (to clean duplicates found after go-live) | C4 | already deferred by C4 (C4 PRD §4.2) |

## 6. What the eLabs sample must answer (B4 checklist for T14)

The founder sends this list to the client together with the B4 request (07-BLOCKERS "Requests to send now"). C18 does not guess any answer.
1. Export mechanism offered by eLabs or its vendor (files? database dump? reports? API?) and who runs it.
2. File formats, encodings, delimiters; whether Devanagari text survives the export.
3. Entities available: patients, visits/registrations, results (with versions/amendments?), report PDFs (stored or re-generated?), masters (tests, analytes, ranges, prices, doctors, centres, credit parties), invoices, payments, dues.
4. Stable primary keys per entity; whether keys are reused after deletion.
5. Patient merge history (does eLabs record "A merged into B"?).
6. Result status values and how amended results are represented.
7. Date/time storage: A.D. or B.S.; time zone; precision.
8. Units and reference ranges per result row or only in masters.
9. Size: number of patients, visits, results, PDFs and total bytes per year.
10. Delta capability: "changed since timestamp" export? Deletions represented?
11. Whether invoices in eLabs were synced to CBMS, and the last invoice number per fiscal year (for the auditor, B6).
12. Licence/contract terms of eLabs that govern exporting the lab's own data (client's responsibility; recorded only).

## 7. Risks and mitigations

| # | Risk | Likelihood / impact | Mitigation |
|---|---|---|---|
| R-1 | eLabs export is incomplete (no results or no keys) | medium / high | canonical format allows partial packages; history value then limited to what exists; decision recorded in sign-off; E13 (no stable keys → full reload before go-live only) |
| R-2 | Duplicate patients fused wrongly | low (no auto-merge) / high | conservative rules §9 of TRD; samples; void before sign-off |
| R-3 | Owner ports not delivered (Wave-1 teams busy) | medium / high | CRs already registered in 08 §3 (DEFERRED until B4); fakes let C18 reach M3; cut-over date depends on G-3 |
| R-4 | Load overloads production DB | low / medium | day/night rate caps (TRD §15); one writing run per tenant; night windows |
| R-5 | PHI leaks via logs, terminal scrollback or copied files | medium / high | masking default; `--reveal` TTY-only + audited; no `--json` with `--reveal`; host-only volume; purge; log-scan test |
| R-6 | Historical invoices imported "to be helpful" against IRD rules | low / very high (04 L5: NPR 500,000 on the lab) | no code path to `billing` (CI grep); CR-C18-009 marked DO NOT FILE; sign-off form states invoices not imported |
| R-7 | Staging PHI persists in backups after purge | certain / medium | documented (05-SCHEMA §9); backup encryption + retention per C1; disclosed to the lab in the FAQ |
| R-8 | Unit/method differences make legacy trends misleading | medium / medium | legacy label in history/trend; legacy excluded from delta checks by default; unit crosswalk with factor; sample checks by the lab |
| R-9 | Scan/sanitise throughput for 250 k PDFs/year too slow | medium / low | load PDFs in nightly slices before cut-over; only the delta in the freeze window |
| R-10 | Cut-over mid fiscal year complicates the lab's IRD registers | medium / high | auditor decision (B6/B7) recorded before go-live; option of FY-start cut-over offered (03-APP-FLOW §6.1) |
| R-11 | Name/phone normalisation drift between C18 and C4 | low / low | C4 port re-runs its own dedupe; drift test in the contract suite |
| R-12 | Building pre-B4 wastes effort if the export is unusable | medium / low | no build before B4 (G-4, 08 F-06); the canonical side, once built, is source-independent and reusable for later labs |
