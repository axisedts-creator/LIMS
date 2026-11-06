# C14 Smart Report — 06 Implementation Plan

Status: DECISION, 2026-11-06. Each task = one PR where possible (02-CV §12). "Maps to" = acceptance criteria in `01-PRD.md`. A task is done when its done-when and tests pass and the mapped criteria are demonstrably met (05-DoD §2).

## 0. Prerequisites from C0 (contract wave for Wave 2)

| Deliverable | Owner | If late |
|---|---|---|
| `smartreport` DDL + RLS + triggers + seeds from 05-SCHEMA §9; `db/tests` items 05-SCHEMA §10 | C0-0B | T01–T03 run against a local migration copy in the test harness only; no PR touches `db/` |
| `contracts/openapi/smartreport.yaml` from 02-TRD §5 / §5.1 (35 operations; #35 from the 08 A19 P-43 split) | C0-0C | handlers written against generated types from a draft spec in the CR thread |
| `contracts/ports/SmartReportPort.ts` + CR-C14-001/006 (no `summary_not_ready` in `@throws` — 08 A19 D-111); fake + phase stub + contract suite cases 1–7, 10–14 (8–9 withdrawn, 08 A2.3) | C0-0C | port impl tested with C14's own copy of cases 7, 10–14 until merged |
| C14 listed as FrontdeskPort consumer; C4 fake + contract suite cover C14's calls (CR-C14-009, 08 A19 D-110) | C0-0C + C4 | FrontdeskPort fake configured by C14 tests |
| Alert rule file wired into Prometheus (CR-C14-010, 08 A13 P-14) | C1 | rules stay in C14's path, unwired |
| Permissions (CR-C14-003), error codes (CR-C14-004) | C0-0C | fake IdentityPort configured with the codes |
| `smart_report` flag seed (CR-C14-005) | C2 + C0-0B | fake IdentityPort returns `featureFlags` from fixtures |
| `LabPort.getAnalyteHistory` (CR-C14-002) | C0-0C + C5 | trends return `[]` (AC-13.5) |
| `smart-*` print classes (CR-C14-007) | C6 | fragment tests use a fixture stylesheet; visual sign-off waits |
| `TextDiff` (CR-C14-008) | C0-0D | Phase 3 fallback layout (04-UI-UX SR-02) |

## 1. Tasks

| ID | Goal | Files / paths | Depends on | Done when | Tests | Maps to |
|---|---|---|---|---|---|---|
| T01 | Module + worker skeleton, manifests (`systemPermissions` in the API `ModuleManifest` only), permissions, config; phase-stub replacement (08 A17 P-20) | `services/api/src/modules/smartreport/{index,permissions,config}.ts`, `ports/SmartReportPort.impl.ts` (stub behaviour), `services/worker/src/jobs/smartreport/index.ts` + paired C0-0D PR removing `SmartReportPort` from `phase-stubs.ts` | C0 cores | API boots with C14 module; every operationId has a stub handler returning 501 behind a test flag; C14's registered `SmartReportPort` returns exactly the stub result (`smartreport.feature_disabled`) and passes the `phase1Stub` contract subset; worker manifest subscriptions validated by C0 CI check | boot test + `phase1Stub` contract | — |
| T02 | Repositories for all tables with explicit `tenant_id` filters and optimistic `version` updates | `repository/*.repo.ts` | C0 DDL | every query in 02-TRD uses an index of 05-SCHEMA §5 (EXPLAIN assertion for queue, live-summary, rules-by-kind) | integration | — |
| T03 | Coded sets endpoints (#26 `summary_reject_reasons` with `summary.read`, #35 `organ_groups` with `template.manage` — 08 A19 P-43) + deny-term endpoints | handlers 23–26, 35, `denyTerms.repo.ts`, `domain/wording.ts` (normaliser) | T02 | normalisation rules (NFC, zero-width, case fold); `lab_manager` gets 200 on #35 and 403 on #26 | unit + integration + probes | AC-18.2, AC-18.3 |
| T04 | `domain/fixed.ts`, `band.ts` with borderline | domain | — | B-vectors pass | unit | AC-08.7, AC-10.2, AC-10.3, AC-10.5 |
| T05 | `groups.ts`, `score.ts` (hs-1) | domain | T04 | G-01…G-06 pass | unit | AC-04.4, AC-09.1–AC-09.4 |
| T06 | `deranged.ts` rule resolution, `placeholders.ts` | domain | T04 | precedence analyte > group > any; order; placeholder fill per §4.9 | unit | AC-10.1, AC-10.4 |
| T07 | `advice.ts`, `followups.ts` | domain | T06 | dedupe, caps, `all_in_range`, no follow-up on all-in-range | unit | AC-11.1–AC-11.3, AC-12.1, AC-12.3 |
| T08 | `trends.ts` | domain | T04 | T-vectors pass; unit mismatch excluded; empty when history unavailable | unit | AC-13.2–AC-13.5 |
| T09 | `engine.ts` (pure, canonical JSON, `content_sha256`) | domain | T05–T08 | same inputs ⇒ byte-identical JSON (property test with shuffled input order) | unit | AC-08.2 |
| T10 | `library.validate.ts` (V1–V14) | domain + `library.service.ts` (V6 via CatalogPort fake, called in a savepoint — 08 A19 P-44) | T03, T06 | every rule has a passing and failing fixture; starter library: only V14 `no_mappings` (08 A19 D-108) | unit + integration | AC-02.5, AC-03.3, AC-03.4, AC-05.2, AC-06.1–AC-06.4, AC-18.4 |
| T11 | Library lifecycle service + handlers 1–21 (create/clone/starter, edit children, validate, submit, approve, return) | `library.service.ts`, handlers, `mappers/library.dto.ts`, `seed/starter-library.v1.json` | T02, T10 | state table 03-APP-FLOW §1.1 incl. forbidden transitions; triggers enforce draft-only; removals deactivate (no DELETE, 08 A17 P-18(a)) and readers use active rows only; `approved_by_display_name` via `ctx.core.memberships.list` (P-17); aal2 for approve/return; library_reviews rows | unit (state) + integration + HTTP contract + probes | AC-02.1–AC-02.4, AC-03.1, AC-03.2, AC-03.5–AC-03.7, AC-04.1–AC-04.3, AC-05.1, AC-05.3, AC-05.4, AC-06.5, AC-07.1–AC-07.5 |
| T12 | `summary.service.buildOrGet` (lock, live lookup, supersede, pinning, insert, binding) | `summary.service.ts`, `summaries.repo.ts`, `bindings.repo.ts` | T09, T11 | concurrency test: two parallel builds → one row; supersede on hash change, then `superseded_by_summary_id` set once after the successor insert (08 A19 D-107); `input_result_versions` = the whole hashed approved set (≤ 2,000; larger → `no_eligible_results`); pinning across library approval; history/follow-up port calls in savepoints (P-44 marker test) | integration | AC-07.5, AC-08.1–AC-08.6, AC-15.4 |
| T13 | `SmartReportPort.impl.ts` + status mapping (no non-staff path, 08 A2.3; `summary_not_ready` never thrown, 08 A19 D-111) | `ports/`, `mappers/port.mapper.ts` | T12 | `runSmartReportPortContract` cases 1–7, 10–14 pass on the real impl | contract | AC-01.1, AC-01.2, AC-14.4, AC-17.1 |
| T14 | Event consumers (approved, amended) + prebuild task | `services/worker/src/jobs/smartreport/{consumers,tasks}/*` | T12 | duplicate delivery no-op; late event no-op (incl. an unmapped result already in the hashed set); stale amendment no-op; prebuild skips incomplete orders; prebuild runs `buildOrGet` in a savepoint and rolls it back on `no_eligible_results`/`template_not_approved` (P-44); enqueue gated by flag + library | integration (worker) + event contract | AC-15.1–AC-15.3, AC-15.5 |
| T15 | Summary read/build/review handlers 27–32 + field allowlist mapper + access log | handlers, `mappers/summary.dto.ts` | T12, T13 | approve re-checks hash (supersede + 409); reject reasons; no bulk approval; `review_inputs` only for `summary.approve`; `reviews[]` from `summary_reviews` in `SmartSummaryView` (08 A22.1; no comment; actor names batched) | HTTP contract + integration + probes | AC-01.3, AC-14.1–AC-14.7, AC-21.1, AC-21.2 |
| T16 | Preview (#22) | `preview.service.ts` | T09, T11 | no writes (row counts unchanged); fixtures from `packages/test-fixtures`; `lab.result.read` check for real orders | integration | AC-19.1, AC-19.2 |
| T17 | Observability: metrics, log fields, alert rule file `services/worker/src/jobs/smartreport/ops/smartreport.rules.yml` (02-TRD §12 "Alert rules for C1"; wired by C1 via CR-C14-010, 08 A13 P-14); log-scan test | module + worker | T12–T15 | metrics in 02-TRD §12 exported; rule file lists the six rules of 02-TRD §12; log scan finds no block text/values | integration + log scan | AC-21.3 |
| T18 | Staff web: nav, SR-01 queue | `apps/web/src/{app/(staff),features}/smartreport/**` | T15, UI kit | all states of 03-APP-FLOW §4; keyboard J/K/Enter; axe clean | component (MSW) + a11y | AC-14.1 (UI) |
| T19 | Staff web: SR-02 review (approve/reject dialogs, banners, trend chart, results-used table) | same | T18 | approve-superseded banner; approved banner with "Open order results" link (`staff.lab.order_results`); History timeline from `reviews[]` (08 A22.1) | component + e2e | AC-14.2–AC-14.5, AC-14.7 (UI) |
| T20 | Staff web: SR-03/SR-04 library list + editor (all tabs, client-side checks mirroring server) | same | T11 | read-only when not draft; placeholder chips; follow-up banner | component + a11y | AC-02.*, AC-03.*, AC-04.*, AC-05.* (UI) |
| T21 | Staff web: SR-05 review/approve, SR-06 wording, preview dialog | same | T20 | MFA step-up path; diff counts | component + e2e | AC-07.* (UI), AC-18.2, AC-19.1 |
| T22 | Renderer fragment `services/renderer/templates/smart/` | renderer templates | T13, CR-C14-001, CR-C14-007 | snapshot tests (approved, Devanagari, no score, no trends, empty findings); escaping; draft → `''`; output unchanged by C6 sanitiser profile | unit + snapshot | AC-09.5, AC-12.4, AC-16.1–AC-16.3, AC-18.1 |
| T23 | User manual + in-app help pages | `docs/manual/smartreport/**`, `features/smartreport/help/` | T18–T21 | every screen has help; manual explains B14 responsibility and hs-1 | review | 05-DoD §3.8 |
| T24 | E2E on compose stack with real C5/C6 (integration gate) | `apps/web/tests/e2e/smartreport/*` | T13–T22, C5/C6 merged | journey: approve library → results approved → draft → approve → C6 Regenerate → PDF has section; summary approved before first assembly → first version carries the snapshot (08 A4.4); amendment → old summary never shown | e2e | AC-15.4, AC-16.1, AC-17.2–AC-17.4, US-14 end-to-end |
| T25 | Load test: build p95 and consumer throughput at 1× and 10× seed | `__tests__/load/` | T12–T14 | p95 ≤ 300 ms new build, ≤ 120 ms cached; consumer ≤ 20 ms p95 at 17 events/s | load | 02-TRD §11 |
| **Phase 3** | | | | | | |
| T26 | `LlmRephraser` interface, `DisabledRephraser`, fake rephraser for tests, `prompt.v1.ts`, `function-words.en.ts` | `llm/*` | T13 | disabled path makes zero network calls (spy) | unit | AC-20.1 |
| T27 | LLM validator L1–L8 | `llm/validator.ts` | T26 | every check has pass/fail fixtures incl. Devanagari script check | unit | AC-20.3 |
| T28 | Rephrase request endpoint #33, task `smartreport.llm_rephrase`, `llm_runs`, overlay, approval with `use_llm_text`, endpoint #34; host allowlist + startup refusal; circuit breaker | handlers, `llm.service.ts`, worker task | T26, T27, T15 | input contains no filled placeholders/values (assertion on captured request); overlay only while draft; port returns LLM text only when approved with `use_llm_text` | integration (fake rephraser) | AC-20.2, AC-20.4, AC-20.5 |
| T29 | SR-02 LLM panel (TextDiff or fallback) | web | T28, CR-C14-008 | diff visible; "Kept original" badges | component | AC-20.4 (UI) |
| T30 | Concrete adapter for the chosen self-hosted model server | `llm/adapters/<name>.ts` | **founder decision (BLOCKED)** + C1 hosting in Nepal | adapter passes the rephraser contract with the fake server; security review of the endpoint | integration | — |

## 2. Milestones

| Milestone | Tasks | Outcome |
|---|---|---|
| M1 Rules engine | T04–T10 | pure engine + validation with golden vectors |
| M2 Library + summaries backend | T01–T03, T11–T17 | port passes contract suite; consumers live; chunk usable by C6 against real C14 |
| M3 Staff UI + renderer | T18–T23 | pathologist can author, approve, review; PDF section renders |
| M4 Integration gate | T24, T25 | E2E with real C5/C6; performance met |
| M5 Phase 3 LLM | T26–T29 (T30 when unblocked) | LLM layer available behind flags |

## 3. Fakes → real

| Dependency | Fake until | Swap when |
|---|---|---|
| LabPort (C5) | M2 | C5 chunk gate passed; `getAnalyteHistory` after CR-C14-002 merges |
| FrontdeskPort (C4) | M2 | C4 chunk gate |
| CatalogPort (C3) | M2 | C3 chunk gate |
| IdentityPort (C2) | M2 | C2 chunk gate + CR-C14-005 seed |
| C6 renderer + assembly | M3 | C6 chunk gate; CR-C14-007 merged |
| LlmRephraser | always fake in CI | T30 after founder decision |

## 4. Definition of done for the chunk (in addition to 05-DoD)

- `SmartReportPort` contract cases 1–7 and 10–14 pass on the real impl; the phase stub for `SmartReportPort` was removed from `phase-stubs.ts` by T01's paired C0-0D PR (08 A17 P-20).
- Both consumers proven idempotent (duplicate `event_id`) and correct under late/stale delivery.
- Probes for all 35 operations and every tenant table, including device/patient/portal/partner claims → 0 rows (08 A19 D-109).
- Non-staff actors make zero `SmartReportPort` calls; the renderer returns `''` for drafts (tests T13, T22; 08 A2.3).

## 5. CR candidates foreseen (not raised now)

| Candidate | To | Why |
|---|---|---|
| Event `smartreport.summary.approved.v1` (consumers C6 auto-regenerate, C16 notify) | C0-0C, C6, C16 | removes the manual Regenerate step (C6 E23); C16 can notify "summary ready" |
| ~~Patient/portal actor SELECT policies on `smartreport.summaries`~~ | — | withdrawn by 08 A2.3: `smartreport.*` stays staff/system-only; non-staff readers use the C6 report-version snapshot |
| `smartreport.v_pub_summary_daily` (counts by status/band) | C0-0B, C8 | MIS adoption metric if the owner asks |
| Nepali fixed copy `labels.ne.ts` | C14 internal + tenant pathologist review | needs a verified translation |
| Staff contact for "summary waiting" notifications | C2/C6 | same gap as C6's staff-recipient CR |

08 Addendum A2/A3 applied 2026-11-06 (A2.3: no non-staff RLS on `smartreport.*`; read-only port path withdrawn). The portal "Health summary" section was decided by 08 A4.7 (C6), so it is no longer a candidate here. Review fix pass 2026-11-06 (08 A19) applied.
Final sweep 2026-11-06 — second touch (08 A22.1): `SmartSummaryView.reviews[]` for the SR-02 history, no new endpoint — tasks T15 (API) and T19 (UI).

## 6. Risks and mitigations

| # | Risk | Mitigation |
|---|---|---|
| R1 | Per-summary approval overloads the pathologist (up to ~500 drafts/day/lab at full adoption — 02-TRD §11) | `min_mapped_results` keeps small orders out; queue sorted oldest first with critical filter; "Approve & next" keyboard flow; tenant can leave the feature off (flag). Metric `lims_smartreport_drafts_pending` accepted by the founder 2026-11-06: per-summary approval kept, `min_mapped_results` default 3 (research/04 §13; 08 R17). No bulk approval (safety). |
| R2 | Named pathologist not appointed (B14) | Feature unusable until a library is approved — by design; starter draft lets the lab prepare |
| R3 | Clinical defaults (score weights, bands, trend threshold) mistaken for medical facts | All are library parameters labelled DECISION, shown in the editor, approved by the pathologist, formula published in the report |
| R4 | Follow-up rules become an upsell channel | follow-ups require a finding (DB CHECK), visible rules, deny terms (price/booking), no links, pathologist approval, audit; abuse case AB-3 tests |
| R5 | Stale summary shown after amendment | port and approval recompute the hash; consumers supersede; tests with consumer disabled |
| R6 | Trend data missing (CR-C14-002 late) | trends empty; everything else works |
| R7 | LLM adds medical claims | rephrase-only input with unfilled placeholders, strict validator incl. novelty check, pathologist diff review, flag off by default, founder approval, Nepal-only host allowlist |
| R8 | Renderer sanitiser strips fragment markup | fragment restricted to simple elements and `smart-*` classes; test runs C6's sanitiser profile |
| R9 | Large content JSON grows storage | measured in T25 (02-TRD §11 assumption) |
