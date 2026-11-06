# C10 Microbiology — 06 Implementation Plan

Status: DECISION, 2026-11-06. One task ≈ one PR (02-CV §12). Branch `c10/<kebab-topic>`. Every task's tests follow 02-CV §11.4 gates. Abbreviations: **API** = `services/api/src/modules/micro/`, **WK** = `services/worker/src/jobs/micro/`, **WEB-A** = `apps/web/src/app/(staff)/micro/`, **WEB-F** = `apps/web/src/features/micro/`, **MAN** = `docs/manual/micro/`.

Prerequisite (C0 contract wave for Wave 2, 01 §1): `micro` DDL + RLS (05-SCHEMA), `contracts/openapi/micro.yaml` (02-TRD §5), errors/permissions/routes (CR-C10-004/005/006), fakes for `LabPort` (incl. a micro order item — 03-IC §4.5), `CatalogPort` (microbiology test — 03-IC §4.2), `IdentityPort` (incl. `getTenantSettings` `retention`), core `ctx.core.memberships.list` widened per 08 A17 D-47, synthetic micro fixtures (05-SCHEMA §3.2), `micro.culture.read` granted to `lab_manager` (08 A17 D-64).

## 1. Tasks

| ID | Goal | Files / paths | Depends on | Done when | Tests | ACs |
|---|---|---|---|---|---|---|
| T-01 | Module skeleton boots | API `index.ts`, `permissions.ts`, `config.ts`, `handlers/index.ts` (each operation throws `common.internal` until its task; none returns 501); WK `index.ts`, `cron.ts`; WEB-F `nav.manifest.ts` | C0 contracts | API and worker boot with fakes; nav build passes; manifest `produces: []` CI check green | boot test; nav build | — |
| T-02 | Pure domain: state tables | API `domain/culture.state.ts`, `isolate.state.ts`, `breakpoint-set.state.ts` | T-01 | every transition C1–C10, I1–I4, IR1–IR6, B1–B6 + one forbidden each has a unit test | unit | AC-03.3, AC-11.4, AC-13.5 |
| T-03 | Pure domain: AST value + interpretation | API `domain/ast-value.ts`, `interpretation.ts`, `decimal.ts` | T-01 | grammar table of 02-TRD §4.3 incl. `≤`, `8/4`, limits; all seeded codes accepted; cross-standard and restricted rejected; new synthetic code accepted without code change | unit (table-driven) | AC-06.2–06.5, AC-06.7 |
| T-04 | Pure domain: breakpoint evaluation + selection + schedule | API `domain/breakpoint-eval.ts`, `selection.ts`, `schedule.ts` | T-03 | golden table (synthetic bands only) covers inclusive/exclusive, open bands, gaps, qualifier spanning, precedence levels; protocol/panel precedence; schedule maths | unit | AC-07.2, AC-07.3, AC-03.2, AC-04.2 |
| T-05 | Coded sets + settings + plating-protocol config repositories and endpoints | API `repository/codedsets.repo.ts`, `config.repo.ts`, `service/config.service.ts`, handlers M23–M28, M39, M40, mappers | T-01 | M23–M28, M39, M40 pass HTTP contract tests (review m#33: M29–M32 belong to T-10, M33–M38 to T-14); single `x-permission` `micro.culture.read` on the GETs (D-64); `applies_to` key clash → `micro.code_duplicate`; settings row created lazily (`INSERT … ON CONFLICT (tenant_id) DO NOTHING`, 08 A17 P-22); tenant shadowing works; SNOMED field optional | integration, contract, probes | AC-14.1–14.5 |
| T-06 | Consumer `lab.specimen.status_changed.v1` | WK `consumers/lab.specimen.status_changed.v1.ts`; API `service/culture.service.ts` (`onSpecimenStatusChanged`), `repository/cultures.repo.ts` | T-02, T-05 | received → culture; duplicate/stale/no-micro/aliquot (re-point sets `last_specimen_seq`; aliquot after setup creates nothing)/recollection/rejection paths; `order_item_ids` absent → specimen-type filter, ambiguity → no culture + metric; `centre_id` copied to children | integration with LabPort/CatalogPort fakes; event contract (examples + extra fields + duplicate + stale seq) | AC-01.1–01.9, AC-01.4a |
| T-07 | Culture read endpoints | handlers M1, M2, M15, M16; `mappers/culture.dto.ts`; `service/chain.service.ts` (LabPort status) | T-06 | list filters/sorts/`include_total`; detail with `lab_result` only for `lab.result.read`; access-log action `culture.view`; `*_display` via `ctx.core.memberships.list` / `ctx.core.user` (D-47) | integration, contract, probes (cross-tenant, cross-centre) | AC-02.1, AC-02.3, AC-02.4, AC-17.2 |
| T-08 | Setup, plates, observations | handlers M3–M6; `service/culture.service.ts`; `repository/plates.repo.ts`, `observations.repo.ts` | T-07, T-04 | C2/C3 transitions; schedule fields; corrections; locks | integration, contract, probes | AC-03.1–03.4, AC-04.1–04.5 |
| T-09 | Isolates | handlers M7–M10; `service/isolate.service.ts`; `repository/isolates.repo.ts` (counter row created lazily: `INSERT … ON CONFLICT (tenant_id, specimen_id) DO UPDATE SET last_seq = last_seq + 1 RETURNING last_seq`, 08 A17 P-22) | T-08 | per-specimen numbering under concurrency (20 parallel creates → 1..20 unique); identify/withdraw | integration (concurrency), contract, probes | AC-05.1–05.5 |
| T-10 | AST panels + AST entry | handlers M11, M12, panel config M29–M32; `service/ast.service.ts`; `repository/ast.repo.ts` | T-09, T-03 | panel precedence with tie-break (lowest code, then id); per-entry outcomes with SAVEPOINTs and `path`; category without raw value refused; `off_panel`; no operation sets `report_visibility` (AC-16.1, contract test over `micro.yaml`); p95 ≤ 300 ms for 60 entries on 10× seed | integration, contract, perf | AC-06.1–06.6, AC-06.3a, AC-16.1 |
| T-11 | Breakpoint import endpoint + storage | handler M42, M41, M43–M45, M49; `service/breakpoint.service.ts`; `repository/breakpoints.repo.ts` | T-05, core `ctx.uploads`/`ctx.storage` (08 §4.13; fake storage until C0-0D ships) | `ctx.uploads.accept` with `bucket`/`objectPath` (no separate put); upload checks (5 MiB = 5,242,880 bytes, UTF-8, NUL, sha256 dedupe → `422 micro.breakpoint_import_invalid`); `intended_effective_from` stored; job enqueued; aal2 enforced | integration, contract, probes, MFA test | AC-12.1, AC-12.3, AC-12.5 |
| T-12 | Breakpoint validation job + CSV parser | WK `csv/parser.ts`, `csv/breakpoint-file.ts`, `tasks/micro.breakpoint_import_validate.ts` | T-11 | every issue code of 02-TRD §9.1 has a fixture; 20,000-line file ≤ 30 s; timeout path; a retried job leaves `validating` unchanged and succeeds | unit (parser), integration (job) | AC-12.2, AC-12.4 |
| T-13 | Breakpoint lifecycle + suggestions | handlers M46–M48, M13; `breakpoint.service.lookup` | T-12, T-04 | four-eyes; overlap closing under concurrent activation (two parallel tx); preview never writes; `accept_suggestion` re-evaluation | integration (concurrency), contract | AC-07.1, AC-07.4–07.6, AC-13.1–13.4 |
| T-14 | Instrument record consumer + resolution | WK `consumers/instruments.result.received.v1.ts`; API `service/instrument-record.service.ts`, `repository/instrument-records.repo.ts`; handlers M19–M22, vocab maps + AST defaults M33–M38 | T-10 | all `match_status` paths incl. `ignored` at IR1 and `isolate_seq_out_of_range`; mapped codes stored and reused on deferred apply; `expires_at` set on applied/ignored (D-65); `ignore_comment` stored; dedupe on key; conflict resolution; late after final; behind `LIMS_MICRO_SPECIMEN_LOOKUP_PORT` default false | integration with synthetic events, contract, probes | AC-08.1–08.12 |
| T-15 | Snapshot + submission | API `domain/snapshot.ts`, `service/report.service.ts`, `repository/reports.repo.ts`; handler M14 | T-10, T-07 | ajv-validated snapshot; size guard (20 isolates / 600 AST rows); snapshots exclude `suppressed_by_rule` rows (AC-16.1); single-tx with port; rollback on `failNext`; idempotent replay; guards; second preliminary over an approved preliminary sends `module_preliminary_update` (D-61); `amendment_reason_*` written to `report_versions` | unit (snapshot), integration with LabPort fake (`failNext` for each passed-through code), contract | AC-09.1–09.7, AC-10.1–10.7, AC-15.2, AC-16.1 |
| T-16 | Reopen / amend / cancel | handlers M17, M18; amendment logic in `report.service.ts` (`module_phase_progression` / `module_preliminary_update` auto-reasons) | T-15 | C8/C6/C9 transitions; amendment `{ reasonCode, reasonText? }` passed per CR-C10-001 (accepted, 08 R1 + A17 D-61); M17 checks reason format only, invalid reason surfaces as `lab.module_result_invalid` (D-62) | integration, contract | AC-11.1–11.6, AC-01.6 |
| T-17 | Published view contract | `__tests__/contract/v_pub_report_content.test.ts` | T-15, C0 view | columns/order/JSON schemas; immutability; cross-tenant and centre probes | contract, probes | AC-15.1–15.4 |
| T-18 | Reconciliation, metrics and purge jobs | WK `tasks/micro.reconcile_chain_status.ts`, `tasks/micro.refresh_metrics.ts`, `tasks/micro.purge_instrument_records.ts`, `cron.ts` | T-16, T-14 | all three `tenantScope: 'per_tenant'` (P-6); cancelled line closes culture; flags when versions exist; batch bound; purge deletes only expired records not referenced by AST rows (D-65) | integration with LabPort fake; purge integration | AC-17.1, AC-08.12 |
| T-19 | Web: worklist + scan | WEB-A `worklist/page.tsx`, `loading.tsx`, `error.tsx`; WEB-F `components/worklist/*`, `server/listCultures.server.ts`, `server/lookupSpecimenByBarcode.server.ts`, `server/getSpecimen.server.ts`, `server/listCentres.server.ts` (C2, `identity.centre.read`) | T-07 | tabs, filters, scan flow, empty/error/loading/permission states; axe clean | component (MSW), e2e smoke | AC-02.1, AC-02.2 |
| T-20 | Web: culture page (setup, reads, isolates) | WEB-A `cultures/[culture_id]/…`; WEB-F `components/culture/*`, `forms/*`, `server/*` incl. `getPatient.server.ts` | T-08, T-09, T-19 | dialogs per 04-UI-UX §3.1–3.3; shortcuts registered; patient display fallback | component, keyboard tests | AC-03.*, AC-04.*, AC-05.* (UI) |
| T-21 | Web: AST grid + suggestions | WEB-F `components/ast/*` | T-10, T-13, T-20 | debounce preview, "Use" sets fields, per-row errors, unsaved-changes guard | component, keyboard | AC-06.* , AC-07.5 (UI) |
| T-22 | Web: reports, reopen | WEB-F `components/reports/*`, `server/listLabCodedSet.server.ts` | T-15, T-16, T-20 | drawer, disabled-state explanation (final and updated preliminary), error copy; reopen reasons exclude the three system codes (D-62) | component | AC-09.*, AC-10.*, AC-11.* (UI) |
| T-23 | Web: instrument data inbox | WEB-A `instrument-records/…`; WEB-F `components/instrument-records/*` | T-14 | assign/apply/resolve/ignore dialogs; banner when port flag off | component | AC-08.4–08.6 (UI) |
| T-24 | Web: settings + breakpoint tables | WEB-A `settings/…`, `breakpoint-sets/…`; WEB-F `components/settings/*`, `components/breakpoints/*` | T-05, T-11–T-13 | all tabs; import dialog (CSV accept: `FileUpload` `accept` += `text/csv`, 08 §4.6); detail polling; four-eyes copy | component | AC-12.*, AC-13.*, AC-14.* (UI) |
| T-25 | Security suite | API `__tests__/probes/*`; log-scan test; CI grep for breakpoint values | T-05…T-18 | every 07-SECURITY §5 test present and green | probes, security | 07-SECURITY §5 |
| T-26 | Help + manual | WEB-F `help/*`; MAN pages (04-UI-UX §11) | T-19…T-24 | one help page per screen key; manual reviewed | doc check | 05-DoD §3.8 |
| T-27 | Integration gate | e2e under `apps/web/tests/e2e/micro/` | real C5 (`submitModuleResult`), real C6 (micro section), C7 synthetic replay | e2e of 02-TRD §14 runs on staging; fakes off for C5/C3/C2 | e2e | all |

## 2. Milestones

| Milestone | Tasks | Outcome |
|---|---|---|
| M1 Domain core | T-01–T-04 | all pure rules tested; no IO |
| M2 Manual culture workflow (API) | T-05–T-10, T-15–T-17 | a culture can be created from an event, worked up manually and submitted to the (fake) chain; view contract green |
| M3 Breakpoints | T-11–T-13 | lab-imported tables, suggestions for zone entry |
| M4 Instrument data | T-14 | records stored and matched (manual by default) |
| M5 Web | T-19–T-24 | all screens |
| M6 Hardening + gate | T-18, T-25–T-27 | security suite, docs, integration gate |

## 3. Fake → real switch points

| Dependency | Fake until | Switch when | Check |
|---|---|---|---|
| `LabPort.getOrderResults` / `submitModuleResult` | C5 passes its chunk gate incl. contract cases 14–20 (03-IC §4.5) | T-27 | LabPort contract suite on real impl; e2e prelim → verify → approve → final |
| `LabPort.lookupSpecimens` | CR-C10-003 (accepted in 08 §4.14) in contracts + C5 implements | flip `LIMS_MICRO_SPECIMEN_LOOKUP_PORT=true` per environment | AC-08.3 integration on staging; barcode snapshot backfill job not needed (snapshots fill on next event) — optional one-off task listed in CR follow-up |
| `SubmitModuleResultInput.amendment` | CR-C10-001 (accepted in 08 R1) in contracts + C5 seeds `module_phase_progression` and `module_preliminary_update` (08 A17 D-61) | rebuild against new contract type | amendment event carries reason; `module_phase_progression` accepted only for micro final after approved preliminary; `module_preliminary_update` only for micro preliminary after approved preliminary (03-IC §4.5 cases 35/36) |
| C6 micro section rendering | C6 Phase-2 IS-21 + CR-C6-006 (`moduleRef`) | T-27 | rendered PDF shows micro section from the view |
| `CatalogPort.getTest` | C3 chunk gate | Wave-2 integration | microbiology test resolved from real catalog |
| `IdentityPort` | C2 chunk gate | Wave-2 integration | MFA required for `micro.breakpoint.manage` |
| Core `ctx.uploads`/`ctx.storage` + `micro-imports` bucket | C0-0D/0B ship 08 §4.13 (CR-C2-011; CR-C10-008 merged into it) | T-11 rebuild | adapter tenant-path probe S-15 (server-side access only; end-user Storage policies only after SP-4, 08 R12b) |
| ID/AST driver (C7) | B2 resolved + CR-C10-007 honoured | per instrument | C7 simulator session with two isolates/same antibiotic replays into C10 with distinct records |

## 4. CR candidates already foreseen (beyond §15 of 02-TRD)

1. **Antibiogram view** (`micro.v_pub_ast_isolate_results`: tenant_id, business_date, organism_code, antibiotic_code, method, standard, standard_version, category_code, isolate counts — first isolate per patient rules UNVERIFIED) for C8 MIS (01 §2.3 "cumulative antibiogram export"). Needs 03-IC §6 addition + C8 consumer; raise when C8 plans it.
2. **Cascade/selective reporting engine** (Phase 3, 04 §12) using `ast_results.report_visibility`.
3. **`StatusChip` kinds** for micro statuses (C0-0D) — cosmetic.
4. **C10 consumer of `lab.result.approved.v1` / `lab.result.amended.v1`** — only if the per-page LabPort status read proves too slow for worklists (would show "Approved" chips without a port call).
5. **Automatic CLSI/EUCAST application for MIC manual entry** — KEEP-LATER (01 §2.3); flag `mic_suggestion_enabled` already exists.

## 5. Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| ID/AST system unknown / BCI payload UNVERIFIED (B2) | instrument path unused at launch | full manual workflow; generic record shape; CR-C10-007 driver rule; manual matching default |
| A1 treats a final or a second preliminary after an approved preliminary as an amendment | these need a pathologist; report labelled "Amended" | resolved by 08 R1 + A17 D-61: auto reasons `module_phase_progression` / `module_preliminary_update` + C6 rule (prints "Final" / "Preliminary"); UI explains the rule before submission |
| Breakpoint data licensing | legal exposure if the LIMS provider ships tables | no values in code/seeds/docs (CI grep); tenant attestation; four-eyes activation |
| Specimen-site dimension may not match the lab's tables (04 L24 UNVERIFIED) | wrong row chosen | site is optional per row; precedence documented; suggestions are never auto-saved |
| Instrument idempotency key lacks isolate (04 N10) | lost AST rows | CR-C10-007; C7 simulator test |
| No barcode in C10 until `lookupSpecimens` (CR-C10-003, accepted in 08) is implemented by C5 | slower worklists (BFF per-row lookups) | concurrency cap; page size 50; snapshot once port lands |
| Micro volume unknown (01 §7 Q6) | capacity mis-sizing | ×10 margin in 02-TRD §10; load test at 10× seed |
| Users treat suggested categories as authoritative | clinical error | explicit "Use" action, disclaimer copy, `suggestion_overridden` tracking, MIC suggestions off by default |
| Storage/Realtime claims behaviour UNVERIFIED (04 D3) | cross-tenant file access | all access server-side via `ctx.storage` (08 R12b); adapter probe S-15 must pass before CSV upload is enabled (T-11 gate) |
