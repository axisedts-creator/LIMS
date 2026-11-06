# C9 Quality Engine — 06 Implementation Plan

Status: DECISION, 2026-11-06. One task ≈ one PR (02-CV §12). Every task lists the acceptance criteria (01-PRD) it proves. Prerequisite: C0 Wave-2 contract wave has merged the `quality` DDL (05-SCHEMA), `contracts/openapi/quality.yaml` (02-TRD §5), the event schema `quality.qc_run.rejected.v1` (03-IC §3.21) and the CRs in 02-TRD §16 (CR-C9-001…007 are ACCEPTED in 08; CR-C9-008 is C1 wiring only) — or C9 works against fakes.

Legend: API = `services/api/src/modules/quality`, WK = `services/worker/src/jobs/quality`, WEB-A = `apps/web/src/app/(staff)/quality`, WEB-F = `apps/web/src/features/quality`.

## 1. Tasks

| ID | Goal | Files | Depends on | Done when | Tests | ACs |
|---|---|---|---|---|---|---|
| T-01 | Module skeleton, manifest, config, permissions, phase switch, phase-stub replacement, settings bootstrap | API `index.ts`, `config.ts`, `permissions.ts`, `handlers/index.ts` (all operationIds stubbed 501→ replaced per task), `ports/QualityPort.impl.ts` (stub-equivalent), `service/settings.service.ts` + `repository/settings.repo.ts` (`ensure` only); WK `index.ts` with `quality.reprocess_pending_observations` registered as a no-op handler (so #12 can enqueue it before T-11); WEB-F `nav.manifest.ts`; paired C0-0D PR removing `QualityPort` from `services/api/src/core/ports/phase-stubs.ts` | C0 cores | API boots with every `quality.yaml` operationId mapped; `LIMS_QUALITY_ENABLED=false` → `403 common.feature_disabled`; manifest `produces` = `['quality.qc_run.rejected.v1']`; `QualityPort` stub entry removed in the same PR (C0 AC-0D-6.3 passes) and C9's impl returns exactly the stub results (`deny [feature_disabled]`, `no_qc_data`) and passes the `phase1Stub` contract subset (08 A17 P-20); `settings.service.ensure` inserts `quality.settings` with defaults and `activated_at = now()` on first use, `ON CONFLICT (tenant_id) DO NOTHING`, and ensures `sync_state` with `qc_cursor_at = activated_at − 400 days` (08 A17 D-56) | boot test; feature-flag test; `phase1Stub` contract subset; ensure idempotency + concurrent-ensure test | — |
| T-02 | Target statistics on shared decimal | API `domain/target-stats.ts` using `@lims/shared-ts/decimal` (fake from `@lims/fakes` until C0-0A ships; 08 R12a) | T-01 | decimal-only maths per 02-TRD §7.6 (08 A17 D-54): exact compare `dev > k·sd`; `S1`, `S2` exact; one division each for mean and variance (28 digits, half-up); sqrt in double rounded to 15 significant digits, `inexact`; no `Rational` type | unit golden (20 synthetic values pinning S1, S2, mean, variance, sd, stored rounding) | AC-04.2 |
| T-03 | **Westgard engine (pure)** | API `domain/westgard.ts` | T-02 | all V01–V32 + extra cases in 02-TRD §7.9 pass; canonical rule order | unit (table-driven from a fixture file copied verbatim from §7.9) | AC-06.1–06.5 |
| T-04 | Run assembly + run state machine (pure) | API `domain/assembly.ts`, `domain/run.state.ts` | T-03 | window, composition full, early rejection, late member attached to the early-rejected run (step 1a, 08 A17 D-52), stale close on `last_assembled_at`; every QR transition + forbidden ones | unit incl. AS1–AS4 (02-TRD §7.3) | AC-06.6, 06.7 |
| T-05 | qcStatus (pure) | API `domain/qc-status.ts` | T-04 | S1–S8 | unit | AC-09.1–09.4 |
| T-06 | Set-up services + endpoints: materials, levels, lots, maps | API `service/setup.service.ts`, `repository/setup.repo.ts`, handlers #1–#13, mappers | T-01, DDL | CRUD with If-Match, idempotency, `quality.code_duplicate`, `quality.lot_expired`, instrument FK violation → 400 `common.validation_failed`; lot number pattern equals the DB CHECK (leading/trailing space → 400); `lots_expiring_30d`; #12 enqueues the reprocess task (no-op until T-11) | integration (RLS tenants A/B), HTTP contract per error code | AC-01.1–01.4, 02.5 |
| T-07 | Plans + versions endpoints | API `service/plan.service.ts`, handlers #14–#19 | T-06 | composition/N/mean-rule validation; `instrument_code_unmapped` warning via CatalogPort fake; activation guard | integration + contract | AC-03.1–03.6 |
| T-08 | Targets + establish | API `service/target.service.ts`, handlers #20–#25 | T-07, T-02 | #21 accepts only `source: 'manufacturer'`; supersede on activate in one tx; immutability trigger maps to `common.immutable_record`; establish population rules; `basis_observation_ids_sha256` lowercase hex | integration | AC-04.1–04.6 |
| T-09 | Observation import + classification | API `service/observation.service.ts`, `repository/qcview.repo.ts` (reads `lab.v_pub_qc_result` only); WK `tasks/sync_qc_observations.ts`, `consumers/instruments.qc.received.v1.ts`, `cron.ts` | T-08 | dedupe on `source_qc_result_id`; first page with overlap, keyset continuation on `(created_at, qc_result_id)`, both cursor columns persisted, next page only while full and the key advanced, time budget + `qcsync:cont:` continuation (02-TRD §6.2); per-row savepoint and `import_error`; all §6.3 statuses incl. exact vs wildcard control-ID map | integration with seeded `lab.qc_results` (1,200 rows in one second; poison row; overlapping jobs); consumer duplicate-delivery test | AC-02.1–02.3, AC-05.1–05.5 |
| T-10 | Run service: assemble, evaluate, publish | API `service/run.service.ts`, `events/publish.ts`; WK `tasks/close_stale_runs.ts` | T-04, T-09 | pair lock; event in same tx (rollback test); `hold_since` H1–H4; `qc_activity` reset; late member of an early-rejected run attached without a second event; `close_stale_runs` on `last_assembled_at`; gauge `lims_quality_qc_rejected_without_action_oldest_age_seconds` | integration + event payload validation (03-IC example + generated) | AC-06.6–06.9 |
| T-11 | Re-processing | API `observation.service.ts`; WK `tasks/reprocess_pending_observations.ts` (replaces the T-01 no-op) | T-10 | map/plan/target activation enqueues; late rule respected; plan activation adopts older `no_plan` history via rows 4–8 only, never assembling it (08 A17 D-60) | integration | AC-02.4, AC-04.7 |
| T-12 | Runs read + review actions | handlers #26–#33 | T-10 | evaluate-now, corrective actions, close guards (later accepted run with `run_at > R.run_at + run_window_minutes`), acknowledge, exclusion guard (service + trigger); #30/#32/#33 `x-idempotency: required`; 92-day span on #26/#28; `needs_action_reason` | integration + contract | AC-07.1–07.5 |
| T-13 | `QualityPort.qcStatusFor` + status board | API `ports/QualityPort.impl.ts` (qcStatusFor replaces the T-01 stub-equivalent method, P-20), `service/status.service.ts`, handler #34; WK `consumers/instruments.result.received.v1.ts` | T-05, T-10 | port contract cases 1, 6, 7, 8, 9, 12; overdue flag; P95 ≤ 10 ms on 10× seed | port contract; perf | AC-09.1–09.5 |
| T-14 | LJ chart data | API `service/chart.service.ts`, handler #35 | T-10 | point status mapping, target segments, truncation, z view | integration | AC-08.1, 08.4 |
| T-15 | Auto-verify DSL + versions + lifecycle | API `domain/autoverify-dsl.ts`, `domain/ruleset.state.ts`, `service/autoverify.service.ts`, handlers #36–#41, #44, #45 | T-01 | schema validation errors as JSON Pointers; one simulating/active; trigger immutability; stop → `stopped` (terminal, 08 A17 D-55); aal2 on every `quality.autoverify.manage` operation | unit + integration + contract | AC-10.1–10.3, AC-11.4, AC-12.3 |
| T-16 | `canAutoVerify` + decision audit | API `domain/autoverify-eval.ts`, `service/decision.service.ts`, `ports/QualityPort.impl.ts` (canAutoVerify replaces the T-01 stub-equivalent method, P-20); WK `consumers/lab.result.verified.v1.ts` (verification_log; tolerates absent `specimen_id`/`verified_by_membership_id`, 08 A13 D-2) | T-13, T-15 | A1–A16; property test (no reason ⇔ allow); rows inside caller tx (rollback test); short-circuit metric; p95 ≤ 10 ms | unit + port contract (cases 1–5, 10, 11) + perf | AC-13.1–13.6, 11.1 |
| T-17 | Simulation report + activation (four-eyes) | handlers #42, #43, #46, #47; `ctx.audit.access` | T-16 | minimums, self-activation, aal2, `live_decision` in the sample; access log exactly `autoverify.activate`, `autoverify.retire`, `autoverify_decision.view` (#47), `autoverify_simulation.view` (#42) — 08 A17 D-53 | integration + contract | AC-11.2, 11.3, 12.1–12.3, 13.7 |
| T-18 | TAT clock (pure) | API `domain/tat-clock.ts` | T-01 | T1–T14; every TC transition | unit | AC-14.1, 14.4, 14.5 |
| T-19 | TAT sweep + consumers + endpoints | API `service/tat.service.ts`, handlers #48–#50; WK `tasks/tat_sweep.ts`, `tasks/tat_refresh_order.ts`, `tasks/purge_tat_items.ts`, consumers `lab.specimen.status_changed.v1`, `reporting.report.released.v1`, verified-consumer stop logic | T-18, T-16 | sweep p95 ≤ 2 s/tenant on 10× seed; centre-scoped RLS; total start from `reporting.v_pub_order_report_tat.registered_at` with `start_basis` fallback (08 A17 D-59); release stops only the items in `order_item_ids`; acknowledgement (#50 `x-idempotency: required`); purge deletes expired rows without alert children (P-18(c)) | integration + consumer duplicate/unknown-field tests + perf | AC-14.1–14.8 |
| T-20 | Settings + coded sets; `v_pub_qc_summary` verification | handlers #51–#54 (repository and `ensure` are in T-01, 08 A17 D-56); view test | T-01, T-10 | ranges validated; view columns exactly 03-IC §6.7 | integration | AC-15.1 |
| T-21 | Web: status board, runs, run detail, LJ chart, unassigned QC | WEB-A pages + `loading.tsx`/`error.tsx`; WEB-F components/server/help | T-12–T-14; CR-C9-007 (table fallback until merged) | all states of 03-APP-FLOW §4; keyboard flows; polling with visibility | component tests (MSW 3.0.3), axe | AC-07.4, 08.1–08.5, 09.5 |
| T-22 | Web: set-up tabs | WEB-A `setup/**`, WEB-F forms | T-06–T-08, T-21 | field validation mirrors spec; pickers via C3/C7 HTTP with permission fallback | component tests | AC-01.x, 02.x, 03.x, 04.x |
| T-23 | Web: auto-verification screens | WEB-A `autoverify/**` | T-15–T-17 | editor, simulation report, activation dialog, decisions | component tests | AC-10.x–12.x |
| T-24 | Web: TAT alerts + settings | WEB-A `tat-alerts/**`, `settings/**` | T-19, T-20 | badge, acknowledge, segment labels | component tests | AC-14.6–14.8 |
| T-25 | Security probes + log scan | API `__tests__/probes/**` | all API tasks | 07-SECURITY §5 list green (incl. S-05 partner/portal/patient claims → 0 rows, S-08 aal1 on every `quality.autoverify.manage` operation) | probes | 07 §5 |
| T-26 | Observability + runbook + manual | metrics registration, WK `ops/quality.rules.yml` (02-TRD §14 "Alert rules for C1", wired by C1 through CR-C9-008), `docs/manual/quality/**` | T-10, T-16, T-19 | metrics in 02-TRD §14 exported; every metric named in `quality.rules.yml` is one of the §14 metrics | metric presence test; rule-file parse test | 05-DoD §3.7–3.8 |
| T-27 | E2E nightly scenarios | `apps/web/tests/e2e/quality/**` | all | scenarios of 02-TRD §15 pass on compose stack with real C5 (the phase-stub removal is in T-01, P-20) | E2E | chunk gate |

## 2. Milestones

| Milestone | Tasks | Demo |
|---|---|---|
| M1 Engine core | T-01…T-05 | vectors V/S/H green in CI |
| M2 QC end-to-end | T-06…T-14, T-20 | synthetic QC event → rejected run → C5 hold (C5 real or LabPort fake), LJ data |
| M3 Auto-verify | T-15…T-17 | shadow simulation, four-eyes activation, C5 auto-verifies a normal result |
| M4 TAT | T-18, T-19 | breach and escalation visible from C5 seed data |
| M5 UI + hardening | T-21…T-27 | full screens, probes, perf, E2E; chunk gate (05-DoD §3) |

## 3. Fakes → real

| Dependency | Fake until | Switch to real when |
|---|---|---|
| `IdentityPort` | C2 chunk gate | C2 merged (settings `westgardMode`, `autoVerificationEnabled`) |
| `CatalogPort` (incl. `tatTargetSegment`, CR-C3-001, ACCEPTED) | C3 chunk gate | C3 merged; an absent `tatTargetSegment` means `within_lab` (C3 column default) |
| `lab.v_pub_*` views, C5 events, C5 `quality.qc_run.rejected.v1` consumer | C5 chunk gate (Phase 1, earlier than C9) | already real in Wave 2; integration tests seed `lab.*` through C0 seeds |
| C6 `reporting.report.released.v1`, `reporting.v_pub_order_report_tat` | C6 chunk gate | real |
| C7 events, `instruments.instruments` FK target, HTTP list | C7 chunk gate | real; directory view `instruments.v_pub_instrument_directory` (CR-C9-006 accepted, final columns 08 §4.9 incl. `is_active`) |
| C0 phase stub for QualityPort | T-01 | T-01 removes the stub in a paired C0-0D PR and registers C9's stub-equivalent impl; T-13/T-16 replace each method (08 A17 P-20; C0 06 plan row "QualityPort") |

## 4. Integration points to verify at the integration gate

1. C5 consumes `quality.qc_run.rejected.v1` and calls `holdResultsSince` with `since = hold_since` (C5 02-TRD §7.2).
2. C5 calls `canAutoVerify` per CR-C9-004 and performs R4 `mode: auto` only on `allow`; `lab.result.verified.v1` shows `mode: auto`.
3. C8 reads `quality.v_pub_qc_summary`.
4. C1 has wired the alert rules of 02-TRD §14 (CR-C9-008).

## 5. CRs raised (02-TRD §16)

CR-C9-001 permissions · CR-C9-002 error codes · CR-C9-003 `qc_warning` reason + semantics · CR-C9-004 C5 calls the port independent of the tenant switch · CR-C9-005 `lab.v_pub_qc_result.created_at` + index · CR-C9-006 `instruments.v_pub_instrument_directory` · CR-C9-007 `ControlChart` kit component (all ACCEPTED in 08) · CR-C9-008 alert rules wired by C1 (08 A13 P-14; raised in the review fix pass).

## 6. CR candidates foreseen (not raised yet)

| Candidate | To | Why |
|---|---|---|
| `quality.qc_run.accepted.v1` (or close event) so C5 can offer one-click hold release after an accepted rerun | C0-0C, C5 | D-QC-3; C5 lists the same candidate (C5 06 §6) |
| Re-ask `canAutoVerify` when QC for a pair becomes in control (results resulted before the QC run) | C5, C0-0C | PRD §4.2 out of scope v1 |
| `NotificationPurpose` `tat_escalation` / `qc_failure` + C9 as NotificationPort consumer (SMS to supervisor) | C6, C0-0C | D-TAT-1 |
| `frontdesk.order.cancelled.v1` consumer for C9 (exact total-clock cancellation) | C0-0C (consumer list) | E17 |
| Purge DEFINER for C9 class-A tables (`autoverify_decisions`, `verification_log`, `tat_alert_*`, `qc_corrective_actions`, `qc_run_reviews`) after `retentionYears`, with `app.maintenance`-bound owner policies and an 08 §4.7 row | lead / C0-0B | 08 A17 P-18(c); no row is eligible before 5 years (05-SCHEMA §7) |
| Route ids `staff.quality.lj_chart`, `staff.quality.tat_alerts`, `staff.lab.qc_holds` for cross-module links (C8 dashboard, C9 → C5 hold page) | C0-0C, C5 | 03-APP-FLOW §4 |
| Per-tenant timezone for `v_pub_qc_summary.business_date` | C0-0B | v1 fixes `Asia/Kathmandu` (08 A13 P-15); a per-tenant timezone needs a CR that adds a stored `business_date` column (08 §4.9 fallback) |
| N = 1, 5, 6 rule sets | C9 (after a primary source is read) | 02-TRD §5.3 |
| Ordinal/qualitative auto-verification (needs ordinal code in `ResultContext`) | C0-0C, C5 | 02-TRD §8.2 numeric only |

## 7. Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Analyser QC records not identifiable or missing control id/lot (B2) | QC never reaches C9 | manual QC entry in C5 flows through the same path; Unassigned QC page makes gaps visible |
| Wrong Westgard implementation | false accept or false reject → patient safety | pure engine, table-driven vectors from definitions, reference implementation check, mode/N explicit on every run |
| 2-2s / 2of3-2s scope (across runs) is not spelled out in westgard.com's text (research/01 §2.5: UNVERIFIED as to the letter); the N = 3 and 8x/12x definitions are DECISIONs by analogy (08 A17 D-58) | lab disagrees with a rejection | per-plan switch `two_two_s_across_runs`; documented on the plan screen |
| Decision table growth (36–73 GB/yr at N=10) | storage cost | retention by `retentionYears`; time-leading indexes ready for partitioning (04 D10); short-circuit rows not stored (D-AV-4) |
| `canAutoVerify` latency in C5's ingest path | slower ingest | ≤ 10 ms budget, cached rule sets, indexed QC lookup, perf test at 10× |
| TAT approximations (total start falls back to specimen `ordered_at` when C6 has no `v_pub_order_report_tat` row yet, recorded in `start_basis`; orders cancelled after verification) | slightly early/late alerts | documented on screen (segment labels), orphan close after 72 h, CR candidates |
| QC import stalls (backlog bursts, poison rows) | rejections not detected, results not held | keyset continuation, per-row savepoint, alerts `QualityQcSyncStalled` and `QualityQcImportError` (02-TRD §6.2, §14) |
