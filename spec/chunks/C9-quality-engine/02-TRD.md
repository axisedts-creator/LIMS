# C9 Quality Engine — 02 Technical Requirements (TRD)

Status: DECISION, 2026-11-06. Read `01-PRD.md` first. Names here (tables, operationIds, permissions, error codes, tasks) are binding for the C9 build and are the specification C0 transcribes into `contracts/openapi/quality.yaml`, `db/migrations/*quality*`, `contracts/permissions.yaml` and `contracts/errors.yaml`. Contract gaps are CRs in §16, designed as if accepted.

## 1. Owned paths (01-CHUNK-MAP §3)

| Path | Content |
|---|---|
| `services/api/src/modules/quality/**` | API module: manifest, handlers, services, domain (Westgard engine, auto-verify evaluator, TAT clock), repositories, `QualityPort` implementation, mappers, tests |
| `services/worker/src/jobs/quality/**` | consumers, tasks, crontab |
| `apps/web/src/app/(staff)/quality/**` | route segment (pages) |
| `apps/web/src/features/quality/**` | components, BFF server functions, nav manifest, help, forms, tests |
| `apps/web/tests/e2e/quality/**` | nightly E2E scenarios (§15; 01-CHUNK-MAP §3 mapping of `apps/web/tests/e2e/<module>/` requested from the lead) |
| `docs/manual/quality/**` | user-manual pages |

C9 never edits `db/`, `contracts/`, `packages/*`, any `core/` folder or another module (01 §4). DDL in `05-SCHEMA.md` is implemented by C0-0B.

## 2. Stack and libraries

| Item | Version | Source |
|---|---|---|
| Node.js | 26.x LTS, exact patch C0 pins | 02-CV §1.1 |
| TypeScript, Fastify, Next.js | C0 pins | 02-CV §1.1 |
| `fastify-openapi-glue` | 4.12.0 (via core) | 04 T7 |
| Graphile Worker | 0.18.0 (via core) | 04 S10, T7 |
| PostgreSQL | 17 (`supabase/postgres:17.6.1.136`) | 04 D9 |
| Decimal arithmetic | `@lims/shared-ts/decimal` (exact decimal, ≥ 28 significant digits; implemented once by C0-0A — 08 R12a; CR-C5-002 merged into CR-C3-002). Until it lands, C9 codes against the same interface with the `@lims/fakes` test double; no local copy is kept. | C5 02-TRD §15 |
| MSW (web tests) | 3.0.3 | 04 T7 |
| Charting | `@lims/ui` only; LJ chart needs a new kit component (CR-C9-007) | 02-CV §14 |

**Dependencies added by C9: none.** No statistics library is needed. QC arithmetic is decimal-only (08 A17 D-54): rule comparisons are exact decimal comparisons with no division, the mean and variance use one decimal division each, and the square root is the only IEEE-double step (§7.6). There is no `Rational` type.

## 3. Module architecture

```
services/api/src/modules/quality/
├── index.ts                         # manifest: name 'quality', openapi, handlers, ports { QualityPort }, produces ['quality.qc_run.rejected.v1']
├── permissions.ts                   # codes from §5.0 (incl. CR-C9-001)
├── config.ts                        # LIMS_QUALITY_* (§12.2)
├── handlers/                        # one file per operationId (§5); thin: authz → service → mapper
├── service/
│   ├── setup.service.ts             # materials, levels, lots, control-ID maps
│   ├── plan.service.ts              # QC plans + versions
│   ├── target.service.ts            # targets, establish-from-data
│   ├── observation.service.ts       # import from lab.v_pub_qc_result, classification, exclusion, re-process
│   ├── run.service.ts               # run assembly, evaluation, event publish, corrective actions, close
│   ├── status.service.ts            # qcStatusFor, status board, overdue
│   ├── chart.service.ts             # LJ data
│   ├── autoverify.service.ts        # rule sets, versions, simulation, activation
│   ├── decision.service.ts          # canAutoVerify evaluation + decision audit
│   ├── tat.service.ts               # sweep, clock transitions, alerts, acknowledgements
│   └── settings.service.ts          # quality.settings, coded sets
├── domain/
│   ├── westgard.ts                  # PURE: rule set by N, evaluate(run, history, options) (§7)
│   ├── run.state.ts                 # run status/outcome machine (03-APP-FLOW §2.1)
│   ├── assembly.ts                  # PURE: which run an observation joins (§7.3)
│   ├── target-stats.ts              # PURE: mean / sample SD (§7.6)
│   ├── qc-status.ts                 # PURE: status from run timeline (§7.8)
│   ├── autoverify-dsl.ts            # PURE: DSL schema, validation, compile to lookup map (§8.2)
│   ├── autoverify-eval.ts           # PURE: evaluate(context, compiled, qcStatus, enabled) (§8.4)
│   ├── ruleset.state.ts             # draft→simulating→active→retired (03-APP-FLOW §2.3)
│   ├── tat-clock.ts                 # PURE: clock state + alert level (§9)
│   └── (no local decimal: `@lims/shared-ts/decimal`, C0-0A — 08 R12a)
├── repository/                      # SQL for schema quality only + reads of lab.v_pub_* views (02-CV §5.13)
├── events/publish.ts                # publishQcRunRejected()
├── ports/QualityPort.impl.ts
├── mappers/                         # DTO allowlists (§5.10)
└── __tests__/{unit,integration,contract,probes}/

services/worker/src/jobs/quality/
├── index.ts                         # WorkerManifest (§10)
├── consumers/instruments.qc.received.v1.ts
├── consumers/instruments.result.received.v1.ts
├── consumers/lab.result.verified.v1.ts
├── consumers/lab.specimen.status_changed.v1.ts
├── consumers/reporting.report.released.v1.ts
├── tasks/sync_qc_observations.ts
├── tasks/close_stale_runs.ts
├── tasks/reprocess_pending_observations.ts
├── tasks/tat_sweep.ts
├── tasks/tat_refresh_order.ts
├── tasks/purge_tat_items.ts
├── ops/quality.rules.yml            # alert rules for C1 (§14, 08 A13 P-14; wired by CR-C9-008)
├── cron.ts
└── __tests__/{unit,integration}/

apps/web/src/app/(staff)/quality/            # pages per 04-UI-UX §2
apps/web/src/features/quality/{nav.manifest.ts,server/,components/,hooks/,forms/,help/,__tests__/}
```

Layer rules are 02-CV §2.2. `domain/` has no IO and no `new Date()`; time comes from `ctx.now()`.

## 4. Data flow overview

```mermaid
flowchart LR
  C7[C7 ingest] -- instruments.qc.received.v1 --> C5c[C5 consumer: lab.qc_results]
  C7 -- instruments.qc.received.v1 --> Q1[quality consumer: enqueue sync]
  C5ui[C5 manual QC entry] --> C5c
  C5c -. lab.v_pub_qc_result .-> SYNC[quality.sync_qc_observations]
  Q1 --> SYNC
  SYNC --> OBS[(quality.qc_observations)] --> RUN[run assembly + Westgard]
  RUN -- rejected --> EV[quality.qc_run.rejected.v1] --> C5h[C5: holdResultsSince]
  C5r[C5 result save R2/R3] -- QualityPort.canAutoVerify / qcStatusFor --> PORT[QualityPort.impl]
  PORT --> DEC[(quality.autoverify_decisions)]
  C5v[lab.result.verified.v1] --> VLOG[(quality.verification_log)]
  PEND[lab.v_pub_pending_items + lab.v_pub_specimen_timeline] --> TAT[quality.tat_sweep] --> TI[(quality.tat_items)]
  C6[reporting.report.released.v1] --> TAT
```

## 5. HTTP endpoints (spec for `contracts/openapi/quality.yaml`)

### 5.0 Common rules

- Prefix `/v1/quality`, `tags: [quality]`, security `bearerJwt` (called through the BFF), `x-rate-limit-tier: general` (04 §4: 10 req/s/user, burst 20), problem+json errors, `additionalProperties: false` on every object, no `null` on the wire (02-CV §4.2).
- Errors every operation may return (not repeated): `400 common.validation_failed`, `401 auth.unauthenticated|auth.token_invalid|auth.token_expired`, `403 auth.forbidden|auth.account_locked`, `404 common.not_found`, `429 common.rate_limited`, `500 common.internal`, `503 common.dependency_unavailable`. Mutations add `409 common.version_conflict`, `428 common.precondition_required` (If-Match). Operations with Idem = R add `400 common.idempotency_key_required`, `422 common.idempotency_key_reused`, `409 common.idempotency_in_progress`. Privileged permissions add `403 auth.mfa_required`.
- Lists: cursor pagination, `limit` default 50 max 200 (02-CV §4.3); `sort` enums listed per operation; `id` tie-breaker.
- Idem column: R = `x-idempotency: required`, O = optional, – = none (02-CV §4.5). Every POST that inserts a row is R (08 A13 P-8), including #30 and #32 (they insert a `qc_run_reviews` row), #33 (review row) and #50 (`tat_alert_acks` row). O remains only on POSTs that change the state of an existing row and insert nothing.
- Privileged operations: every operation whose `x-permission` is `quality.autoverify.manage` (#37, #39, #40, #41, #43, #44, #45) needs aal2 and lists `403 auth.mfa_required`; the web client runs the kit step-up flow on that code for every one of them (04-UI-UX §2.8).
- Phase gate: every operation returns `403 common.feature_disabled` while `LIMS_QUALITY_ENABLED=false` (§12.2).

Permissions (03-IC §11 + CR-C9-001):

| Code | Privileged | Default roles | Status |
|---|---|---|---|
| `quality.qc_run.read` | no | lab_technologist, lab_manager, pathologist | existing |
| `quality.qc.manage` | no | lab_manager | existing |
| `quality.autoverify.manage` | **yes** | pathologist, lab_manager | existing |
| `quality.qc_run.review` | no | lab_technologist, lab_manager, pathologist | CR-C9-001 |
| `quality.autoverify.read` | no | lab_technologist, pathologist, lab_manager | CR-C9-001 |
| `quality.tat_alert.read` | no | lab_technologist, pathologist, lab_manager | CR-C9-001 |
| `quality.tat_alert.ack` | no | lab_technologist, pathologist, lab_manager | CR-C9-001 |
| `quality.config.manage` | no | lab_manager | CR-C9-001 |

### 5.1 Control materials, levels, lots

| # | Method + path | operationId | Permission | Request | Response | Extra errors | Idem |
|---|---|---|---|---|---|---|---|
| 1 | GET `/control-materials` | `listControlMaterials` | quality.qc_run.read | query `is_active?` (default true), `q?` (code/name prefix ≤40), `sort` ∈ {`code`,`-created_at`}, cursor/limit | `{ data: ControlMaterialDto[], page }` | `common.invalid_cursor` | – |
| 2 | POST `/control-materials` | `createControlMaterial` | quality.qc.manage | `{ code ^[A-Z0-9_-]{2,32}$, name 1..120, manufacturer? ≤120, matrix? ≤60, levels: [{ level_code ^[A-Za-z0-9]{1,16}$, display_name 1..60, sort_order 0..99 }] 1..6 }` | `201 ControlMaterialDto` (with levels) | `409 quality.code_duplicate` | R |
| 3 | GET `/control-materials/{material_id}` | `getControlMaterial` | quality.qc_run.read | — | `ControlMaterialDto` (levels, lots) | — | – |
| 4 | PATCH `/control-materials/{material_id}` | `updateControlMaterial` | quality.qc.manage | `If-Match`; `{ name?, manufacturer?, matrix?, unset?: ('manufacturer'|'matrix')[] }` | `ControlMaterialDto` | — | – |
| 5 | POST `/control-materials/{material_id}/deactivate` | `deactivateControlMaterial` | quality.qc.manage | `If-Match`; `{}` | `ControlMaterialDto` | — | O |
| 6 | POST `/control-materials/{material_id}/levels` | `createControlLevel` | quality.qc.manage | `{ level_code, display_name, sort_order }` | `201 ControlLevelDto` | `409 quality.code_duplicate` | R |
| 7 | PATCH `/control-levels/{level_id}` | `updateControlLevel` | quality.qc.manage | `If-Match`; `{ display_name?, sort_order?, is_active? }` | `ControlLevelDto` | — | – |
| 8 | POST `/control-levels/{level_id}/lots` | `createControlLot` | quality.qc.manage | `{ lot_no` pattern `^[\x21-\x7E]([\x20-\x7E]{0,62}[\x21-\x7E])?$` (= DB `control_lots__lot__ck`: 1–64 printable ASCII, no leading/trailing space; not trimmed), `expires_on: IsoDate }` | `201 ControlLotDto` | `409 quality.code_duplicate`, `422 quality.lot_expired` | R |
| 9 | GET `/control-lots` | `listControlLots` | quality.qc_run.read | query `material_id?`, `level_id?`, `is_active?`, `expires_on_to?` (expiring before), cursor/limit, `sort` ∈ {`expires_on`,`-created_at`} | list | — | – |
| 10 | PATCH `/control-lots/{lot_id}` | `updateControlLot` | quality.qc.manage | `If-Match`; `{ expires_on?, is_active? }` | `ControlLotDto` | `422 quality.lot_expired` (new date in the past) | – |

### 5.2 Control-ID maps

| # | Method + path | operationId | Permission | Request | Response | Extra errors | Idem |
|---|---|---|---|---|---|---|---|
| 11 | GET `/control-id-maps` | `listControlIdMaps` | quality.qc_run.read | query `instrument_id?`, `lot_id?`, `is_active?` | list of `ControlIdMapDto` | — | – |
| 12 | POST `/control-id-maps` | `createControlIdMap` | quality.qc.manage | `{ instrument_id, control_id_raw 1..64, control_lot_raw? 1..64 (absent = any lot), lot_id }` | `201 ControlIdMapDto` | `409 quality.code_duplicate`, `422 quality.lot_expired`, `400 common.validation_failed` (`/instrument_id` unknown — FK) | R |
| 13 | POST `/control-id-maps/{map_id}/deactivate` | `deactivateControlIdMap` | quality.qc.manage | `If-Match`; `{}` | `ControlIdMapDto` | — | O |

Creating a map enqueues `quality.reprocess_pending_observations` for the instrument (§10).

### 5.3 QC plans

| # | Method + path | operationId | Permission | Request | Response | Extra errors | Idem |
|---|---|---|---|---|---|---|---|
| 14 | GET `/qc-plans` | `listQcPlans` | quality.qc_run.read | query `instrument_id?`, `analyte_id?`, `status?` ∈ {active, inactive}, cursor/limit | list of `QcPlanDto` | — | – |
| 15 | POST `/qc-plans` | `createQcPlan` | quality.qc.manage | `{ instrument_id, test_id, analyte_id, params: QcPlanParams }` | `201 QcPlanDto` (status `inactive`, version 1) + `warnings: ('instrument_code_unmapped')[]` | `409 quality.code_duplicate` (plan exists for pair), `400 common.validation_failed` | R |
| 16 | GET `/qc-plans/{plan_id}` | `getQcPlan` | quality.qc_run.read | — | `QcPlanDto` + versions[] | — | – |
| 17 | POST `/qc-plans/{plan_id}/versions` | `createQcPlanVersion` | quality.qc.manage | `If-Match`; `{ params: QcPlanParams, change_reason 1..500 }` | `QcPlanDto` (new current version, effective now) | — | R |
| 18 | POST `/qc-plans/{plan_id}/activate` | `activateQcPlan` | quality.qc.manage | `If-Match`; `{}` | `QcPlanDto` | `422 quality.qc_target_missing` (a composition level has no active target for any active lot) | O |
| 19 | POST `/qc-plans/{plan_id}/deactivate` | `deactivateQcPlan` | quality.qc.manage | `If-Match`; `{ reason 1..500 }` | `QcPlanDto` | — | O |

`QcPlanParams` (all validated; defaults [CONV]):

| Field | Type / range | Default | Meaning |
|---|---|---|---|
| `controls_per_run` | int ∈ {2, 3, 4} | — (required) | N (04 L23). 1, 5, 6 rejected: 04 L23 gives no rule set for them. |
| `composition` | `[{ level_id, count 1..4 }]` 1..4 items, `sum(count) = controls_per_run`, levels of one material or several | — (required) | expected observations per level per run |
| `mean_rule` | N∈{2,4}: `8x`/`10x`/`12x`; N=3: `6x`/`9x` | `10x` (N=2/4), `6x` (N=3) | the n-x rule (04 L23) |
| `two_two_s_across_runs` | bool | true | apply 2-2s / 2of3-2s also across runs within one level (01 §2.5: common practice, letter UNVERIFIED) |
| `count_rules_across_materials` | bool | true | apply 4-1s/3-1s/n-x also on the interleaved all-levels sequence (research/01 §2.5: 4-1s "often applied across runs (and across materials)"; 10x "usually has to be applied across runs and often across materials") |
| `exclude_rejected_runs_from_history` | bool | true | observations of rejected runs are not history for later runs (DECISION §7.4) |
| `run_window_minutes` | int 5..240 | 30 | assembly window, late-member window of an early-rejected run (§7.3 step 1a) and stale-run timeout |
| `qc_validity_hours` | int 1..168 | 24 | after this, `qcStatusFor` → `no_qc_data` |
| `hold_lookback_hours` | int 1..168 | 24 | `hold_since` when no in-control run is known (03-IC §3.21) |

### 5.4 Targets

| # | Method + path | operationId | Permission | Request | Response | Extra errors | Idem |
|---|---|---|---|---|---|---|---|
| 20 | GET `/qc-targets` | `listQcTargets` | quality.qc_run.read | query `plan_id?`, `lot_id?`, `status?` csv ∈ {draft, active, superseded, retired, discarded} | list of `QcTargetDto` | — | – |
| 21 | POST `/qc-targets` | `createQcTarget` | quality.qc.manage | `{ plan_id, lot_id, mean: DecimalString, sd: DecimalString (> 0), unit_code: Code, source: 'manufacturer', note? ≤500 }` (`source` enum has the single value `manufacturer`; established targets are created only by #22, which fills the basis columns that `qc_targets__basis__ck` requires) | `201 QcTargetDto` (draft) | `422 quality.lot_expired`, `400 common.validation_failed` (sd ≤ 0, lot level not in plan composition) | R |
| 22 | POST `/qc-targets/establish` | `establishQcTarget` | quality.qc.manage | `{ plan_id, lot_id, observed_at_from: IsoUtc, observed_at_to: IsoUtc, include_observation_ids?: Uuid[] ≤500, exclude_observation_ids?: Uuid[] ≤500 }` | `201 QcTargetDto` (draft, source `established`, `basis {n, from, to, observation_ids_sha256}`) | `422 quality.insufficient_qc_data` | R |
| 23 | POST `/qc-targets/{target_id}/activate` | `activateQcTarget` | quality.qc.manage | `If-Match`; `{ effective_from?: IsoUtc (≥ now; default now) }` | `QcTargetDto` | `409 common.immutable_record` (target not in `draft`) | O |
| 24 | POST `/qc-targets/{target_id}/retire` | `retireQcTarget` | quality.qc.manage | `If-Match`; `{ reason 1..500 }` | `QcTargetDto` | `409 common.immutable_record` (not active) | O |
| 25 | POST `/qc-targets/{target_id}/discard` | `discardQcTarget` | quality.qc.manage | `If-Match`; `{}` | `QcTargetDto` | `409 common.immutable_record` (not draft) | O |

Establish population (DECISION): observations of that plan × lot with status `assigned` in runs with outcome `accepted`/`accepted_warning`, plus observations with status `no_target` (baseline period before any target exists), within the date range, not excluded; then `include`/`exclude` lists applied. Minimum `settings.target_min_points` (default 20 [CONV]).

### 5.5 Observations and runs

| # | Method + path | operationId | Permission | Request | Response | Extra errors | Idem |
|---|---|---|---|---|---|---|---|
| 26 | GET `/qc-observations` | `listQcObservations` | quality.qc_run.read | query `plan_id?`, `instrument_id?`, `analyte_id?`, `level_id?`, `lot_id?`, `status?` csv, `observed_at_from/_to?` (when both are given, span ≤ 92 d [CONV]; when only one is given the other defaults to it ± 92 d), `sort` ∈ {`-observed_at`, `observed_at`}, cursor/limit | list of `QcObservationDto` | `400 common.validation_failed` (`/observed_at_to`, span) | – |
| 27 | POST `/qc-observations/{observation_id}/exclude` | `excludeQcObservation` | quality.qc.manage | `If-Match`; `{ reason_code: Code (x-coded-set: quality.exclusion_reasons), comment? ≤500 }` | `QcObservationDto` | `409 quality.qc_run_already_evaluated` (its run is evaluated; checked by the service; trigger `quality.enforce_observation_exclusion` is the DB backstop) | O |
| 28 | GET `/qc-runs` | `listQcRuns` | quality.qc_run.read | query `plan_id?`, `instrument_id?`, `analyte_id?`, `status?` csv ∈ {collecting, evaluated, closed}, `outcome?` csv ∈ {accepted, accepted_warning, incomplete, rejected}, `needs_action?: boolean` (rejected and not closed), `run_at_from/_to?` (span ≤ 92 d [CONV], same defaulting as #26), `sort` ∈ {`-run_at`}, cursor/limit | list of `QcRunSummaryDto` | `400 common.validation_failed` (`/run_at_to`, span) | – |
| 29 | GET `/qc-runs/{qc_run_id}` | `getQcRun` | quality.qc_run.read | — | `QcRunDto` (observations with z, rule hits, plan version, targets used, corrective actions, reviews, hold info) | — | – |
| 30 | POST `/qc-runs/{qc_run_id}/evaluate` | `evaluateQcRunNow` | quality.qc_run.review | `If-Match`; `{ comment? ≤500 }` | `QcRunDto` | `409 quality.qc_run_already_evaluated` | R |
| 31 | POST `/qc-runs/{qc_run_id}/corrective-actions` | `recordCorrectiveAction` | quality.qc_run.review | `{ action_code: Code (x-coded-set: quality.corrective_actions), description 1..1000, performed_at: IsoUtc (≤ now + 5 min, ≥ run_at − 24 h) }` | `201 CorrectiveActionDto` | `409 common.immutable_record` (run outcome is not `rejected`) | R |
| 32 | POST `/qc-runs/{qc_run_id}/close` | `closeQcRun` | quality.qc_run.review | `If-Match`; `{ comment? ≤500 }` | `QcRunDto` | `409 quality.corrective_action_required`, `409 quality.rerun_required`, `409 common.immutable_record` (not a rejected evaluated run) | R |
| 33 | POST `/qc-runs/{qc_run_id}/acknowledge` | `acknowledgeQcRun` | quality.qc_run.review | `{ comment 1..500 }` | `201 QcRunReviewDto` | `409 common.immutable_record` (still collecting) | R |
| 34 | GET `/qc-status` | `getQcStatusBoard` | quality.qc_run.read | query `instrument_id?`, `status?` csv ∈ {in_control, warning, out_of_control, no_qc_data}, `overdue_only?`, cursor/limit | `{ data: QcStatusRowDto[], page, generated_at }` | — | – |
| 35 | GET `/lj-chart` | `getLeveyJenningsChart` | quality.qc_run.read | query `plan_id` (req), `view` ∈ {`level`,`z`} (default level), `level_id?` (req when view=level), `lot_id?`, `observed_at_from`, `observed_at_to` (span ≤ 400 d [CONV]) | `LjChartDto` (§7.10) | `400 common.validation_failed` (span) | – |

### 5.6 Auto-verification

| # | Method + path | operationId | Permission | Request | Response | Extra errors | Idem |
|---|---|---|---|---|---|---|---|
| 36 | GET `/autoverify/rule-set` | `getAutoverifyRuleSet` | quality.autoverify.read | — | `AutoverifyRuleSetDto` (versions summary, active/simulating ids) or `404 common.not_found` if none yet | — | – |
| 37 | POST `/autoverify/versions` | `createAutoverifyVersion` | quality.autoverify.manage | `{ copy_from_version_id?: Uuid, definition?: RuleSetDefinition }` (exactly one) — creates the tenant rule set on first call | `201 AutoverifyVersionDto` (draft) | `422 quality.rule_set_invalid` | R |
| 38 | GET `/autoverify/versions/{version_id}` | `getAutoverifyVersion` | quality.autoverify.read | — | `AutoverifyVersionDto` (definition, status, timestamps, actors) | — | – |
| 39 | PUT `/autoverify/versions/{version_id}` | `replaceAutoverifyDraft` | quality.autoverify.manage | `If-Match`; `{ definition: RuleSetDefinition }` | `AutoverifyVersionDto` | `422 quality.rule_set_invalid`, `409 quality.rule_set_invalid_transition` | – |
| 40 | POST `/autoverify/versions/{version_id}/start-simulation` | `startAutoverifySimulation` | quality.autoverify.manage | `If-Match`; `{}` | `AutoverifyVersionDto` (simulating) | `409 quality.rule_set_invalid_transition` (not draft, or another version simulating) | O |
| 41 | POST `/autoverify/versions/{version_id}/stop-simulation` | `stopAutoverifySimulation` | quality.autoverify.manage | `If-Match`; `{}` | `AutoverifyVersionDto` (status `stopped`, terminal; `simulation_stopped_at` set, rule-set pointer cleared, shadow rows kept — 08 A17 D-55). To continue, create a new draft with #37 `copy_from_version_id` | `409 quality.rule_set_invalid_transition` (not `simulating`) | O |
| 42 | GET `/autoverify/versions/{version_id}/simulation-report` | `getAutoverifySimulationReport` | quality.autoverify.read | query `sample_limit` 0..200 default 50 | `SimulationReportDto` (§8.6) | — | – |
| 43 | POST `/autoverify/versions/{version_id}/activate` | `activateAutoverifyVersion` | quality.autoverify.manage (privileged) | `If-Match`; `{ confirmation_text: "ACTIVATE" }` | `AutoverifyVersionDto` (active) | `409 quality.simulation_incomplete`, `403 quality.self_activation_forbidden`, `409 quality.rule_set_invalid_transition` | O |
| 44 | POST `/autoverify/versions/{version_id}/retire` | `retireAutoverifyVersion` | quality.autoverify.manage (privileged) | `If-Match`; `{ reason 1..500 }` | `AutoverifyVersionDto` (retired) | `409 quality.rule_set_invalid_transition` | O |
| 45 | POST `/autoverify/versions/{version_id}/discard` | `discardAutoverifyDraft` | quality.autoverify.manage | `If-Match`; `{}` | `AutoverifyVersionDto` (discarded) | `409 quality.rule_set_invalid_transition` | O |
| 46 | GET `/autoverify/decisions` | `listAutoverifyDecisions` | quality.autoverify.read | query `result_id?`, `analyte_id?`, `instrument_id?`, `version_id?`, `mode?` ∈ {live, shadow}, `decision?` ∈ {allow, deny}, `reason?`, `decided_at_from` (req), `decided_at_to` (req, span ≤ 31 d [CONV]), `sort` ∈ {`-decided_at`}, cursor/limit | list of `AutoverifyDecisionDto` | — | – |
| 47 | GET `/autoverify/decisions/{decision_id}` | `getAutoverifyDecision` | quality.autoverify.read | — | `AutoverifyDecisionDto` (+ inputs) | — | – |

Access log (08 A13 P-3; codes in `audit.g_cs_access_actions`, 08 §4.4 / 03-IC §13.1; call shape per C0 TRD §6.9, 08 R20), in addition to the C0 data-change trigger. Operation → `action` → `entityType` [CONV: entityType names]; no other action is used by C9:

| Operation | `action` | `entityType` |
|---|---|---|
| #43 `activateAutoverifyVersion` | `autoverify.activate` | `autoverify_version` |
| #44 `retireAutoverifyVersion` | `autoverify.retire` | `autoverify_version` |
| #47 `getAutoverifyDecision` (detail with P3 `inputs`) | `autoverify_decision.view` (08 A17 D-53) | `autoverify_decision` |
| #42 `getAutoverifySimulationReport` | `autoverify_simulation.view` (08 A17 D-53) | `autoverify_version` |

Each call passes `entityId` and `outcome: 'allowed'`.

### 5.7 TAT alerts

| # | Method + path | operationId | Permission | Request | Response | Extra errors | Idem |
|---|---|---|---|---|---|---|---|
| 48 | GET `/tat-alerts` | `listTatAlerts` | quality.tat_alert.read | query `level?` csv ∈ {warning, breached, escalated}, `acknowledged?: boolean`, `segment?` ∈ {within_lab, total}, `department_id?`, `centre_id?`, `priority?` ∈ {routine, urgent}, `sort` ∈ {`-alert_level_rank`, `-pct_of_target`, `started_at`}, cursor/limit | `{ data: TatAlertDto[], page, generated_at }` (open = clock running and level ≥ warning) | — | – |
| 49 | GET `/tat-alerts/{tat_item_id}` | `getTatAlert` | quality.tat_alert.read | — | `TatAlertDetailDto` (clock history, level events, acknowledgements) | — | – |
| 50 | POST `/tat-alerts/{tat_item_id}/acknowledge` | `acknowledgeTatAlert` | quality.tat_alert.ack | `If-Match`; `{ note? ≤500 }` | `TatAlertDto` | `409 common.immutable_record` (clock not running or level `none`) | R |

### 5.8 Settings and coded sets

| # | Method + path | operationId | Permission | Request | Response | Idem |
|---|---|---|---|---|---|---|
| 51 | GET `/settings` | `getQualitySettings` | quality.qc_run.read | — | `QualitySettingsDto` (+ read-only `westgard_mode`, `auto_verification_enabled` from C2) | – |
| 52 | PUT `/settings` | `updateQualitySettings` | quality.config.manage | `If-Match`; full mutable subset (§12.1) | `QualitySettingsDto` | – |
| 53 | GET `/coded-sets/{set_name}` | `listQualityCodedSet` | quality.qc_run.read | `set_name` ∈ {corrective_actions, exclusion_reasons} | `{ data: [{ code, display, sort_order, is_active, source: global|tenant }] }` | – |
| 54 | PUT `/coded-sets/{set_name}/codes/{code}` | `upsertQualityCode` | quality.config.manage | `{ display 1..120, sort_order 0..999, is_active }` | code | O |

### 5.9 Error codes used

From 03-IC §8 (owner C9): `quality.qc_target_missing`, `quality.qc_run_already_evaluated`, `quality.corrective_action_required`, `quality.lot_expired`. New (CR-C9-002): `quality.code_duplicate`, `quality.rerun_required`, `quality.rule_set_invalid`, `quality.rule_set_invalid_transition`, `quality.simulation_incomplete`, `quality.self_activation_forbidden`, `quality.insufficient_qc_data`. Plus `common.*`/`auth.*`. Every operation's `x-error-codes` lists exactly the codes in its table row plus §5.0.

### 5.10 DTO field allowlists (mappers, REQ-SEC-081)

| DTO | Fields |
|---|---|
| `ControlMaterialDto` | id, version, code, name, manufacturer, matrix, is_active, levels[`ControlLevelDto`], lots_expiring_30d (count of active lots of the material with `expires_on` between today and today + 30 days, tenant business date [CONV: 30 days as on 04-UI-UX §2.6]), created_at |
| `ControlLevelDto` | id, version, material_id, level_code, display_name, sort_order, is_active, lots[`ControlLotDto`]? |
| `ControlLotDto` | id, version, level_id, material_id, lot_no, expires_on, is_expired (computed on the tenant business date, Asia/Kathmandu — 08 A13 P-15), is_active |
| `ControlIdMapDto` | id, version, instrument_id, instrument_label?, control_id_raw, control_lot_raw, lot_id, is_active |
| `QcPlanDto` | id, version, instrument_id, instrument_label?, test_id, analyte_id, analyte_code, analyte_name, unit_code, decimals, status, current_version_no, params (`QcPlanParams`), rule_set_preview (`{ warning: ['1-2s'], rejection: Code[] }`), effective_from |
| `QcTargetDto` | id, version, plan_id, lot_id, level_id, mean, sd, cv_pct (computed, 2 dp), unit_code, source, basis?, status, effective_from, effective_to, note, created_by_display, activated_by_display |
| `QcObservationDto` | id, version, plan_id?, instrument_id, analyte_id?, level_id?, lot_id?, control_id_raw, control_lot_raw, control_level_raw, value (DecimalString), unit_code, observed_at, received_at, observed_at_basis (`instrument`|`server`), source (`instrument`|`manual`), status, qc_run_id?, z (DecimalString, 3 dp), target_id?, excluded {reason_code, comment, by_display, at}? |
| `QcRunSummaryDto` | id, version, plan_id, instrument_id, analyte_id, run_at, status, outcome, is_complete, observation_count, controls_per_run, rule_mode, warning_rules, rules_violated, needs_action, needs_action_reason? (`corrective_action` when no corrective action exists yet, else `rerun`; present iff `needs_action`), closed_at |
| `QcRunDto` | summary + plan_version_no, observations[`QcObservationDto` + rule_hits: Code[]], rule_detail [{rule, observation_ids}], hold {hold_since, last_in_control_run_at, event_id}?, corrective_actions[`CorrectiveActionDto`], reviews[`QcRunReviewDto`], evaluated_at, evaluated_by (`system` or member display) |
| `CorrectiveActionDto` | id, qc_run_id, action_code, action_display, description, performed_at, performed_by_display, created_at |
| `QcRunReviewDto` | id, qc_run_id, kind (`acknowledge`|`evaluate_now`|`close`), comment?, reviewed_by_display, created_at |
| `QcStatusRowDto` | plan_id, instrument_id, instrument_label?, analyte_id, analyte_code, status, last_in_control_run_at?, current_run_id?, violated_rules, open_rejected_run_ids, qc_overdue, patient_results_since_last_qc, last_patient_result_at? |
| `AutoverifyRuleSetDto` | id, version, active_version_id?, simulating_version_id?, versions[{ id, version_no, status, rule_count, created_at, created_by_display, simulation_started_at?, simulation_stopped_at?, activated_at?, activated_by_display?, retired_at? }] (newest first, ≤ 200 [CONV]) |
| `AutoverifyVersionDto` | id, rule_set_id, version_no, version, status (`draft`|`simulating`|`stopped`|`active`|`retired`|`discarded`), definition, rule_count, created_at, created_by_display, simulation_started_at?, simulation_stopped_at?, activated_at?, activated_by_display?, retired_at? |
| `AutoverifyDecisionDto` | id, decided_at, mode, decision, reasons, result_id, analyte_id, instrument_id?, version_id?, matched_rule_key?, qc_status, qc_run_id?, inputs {value_numeric?, range_flag?, delta_check_failed, is_critical, instrument_flags, resulted_at} — `inputs` only in the detail response (P3) |
| `TatAlertDto` | tat_item_id, version, order_id, order_item_id, test_id, test_code, department_id, specimen_id, centre_id, priority, segment, segment_label, start_basis, target_seconds, started_at, elapsed_seconds, pct_of_target, alert_level, acknowledged_level?, acknowledged_at?, acknowledged_by_display?, state |
| `TatAlertDetailDto` | `TatAlertDto` + restart_count, first_verified_at?, stopped_at?, stop_source?, level_events[{ level, raised_at, elapsed_seconds, restart_no }], acknowledgements[{ level, note?, acknowledged_by_display, created_at }] |
| `QualitySettingsDto` | version, tat_alerts_enabled, tat_warn_pct, tat_escalate_pct, tat_orphan_close_hours, target_min_points, sim_min_days, sim_min_decisions, reprocess_window_days, default_plan_params, activated_at, updated_at, updated_by_display, westgard_mode (read-only, C2), auto_verification_enabled (read-only, C2) |

`SimulationReportDto` is defined in §8.6 and `LjChartDto` in §7.10.

Number precision of `z` (one rule): stored in `qc_observations.z` with 6 dp (half-up), sent on the wire with 3 dp (`QcObservationDto.z`, `LjChartDto` points), displayed with 2 dp (04-UI-UX §1). Rules never use a rounded `z` (§7.1).

Staff names (08 A17 P-17): every `*_display` field and `evaluated_by` comes from `ctx.core.memberships.list({ membershipIds, activeOnly: false })` for `*_membership_id` columns and from `ctx.core.user` for `*_by` user ids (`created_by`, `activated_by`, `excluded_by`, `updated_by`), memoised per request. C9 never reads `core.memberships` and does not use `IdentityPort.getActor` for other people's names.

`instrument_label` = `display_name` (`instrument_code`) from `instruments.v_pub_instrument_directory` (columns `tenant_id, instrument_id, centre_id, instrument_code, display_name, vendor, model, state, is_active` — CR-C9-006 primary, CR-C12-005 merged; 08 R12d/§4.9; P0, security invoker). The view is used for labels only (reporting-type read, 08 R25 as extended by 08 A17 P-21); instrument state checks for writes use the C7 HTTP API in the BFF.

No DTO carries barcode, registration number, patient name or phone (C9 does not hold them). Links to C5 pages use `routes.yaml` ids (`staff.lab.specimen`, `staff.lab.order_results`).

## 6. QC observation import

### 6.1 Single ingestion path (DECISION)

C5 stores every QC observation (instrument and manual) in `lab.qc_results` and publishes it in `lab.v_pub_qc_result` (03-IC §6.3, consumer C9). C9 imports **only** from that view, keyed by `qc_result_id`, so instrument and manual QC follow one code path and no observation is imported twice. `instruments.qc.received.v1` (03-IC §3.15) is used as a low-latency trigger, not as a second data source, because its payload carries no C5 row id and C5's consumer may commit after C9's.

### 6.2 `quality.sync_qc_observations` (task)

Triggers: crontab `* * * * *` `per_tenant` (08 A13 P-6); and enqueued by the `instruments.qc.received.v1` consumer with `job_key = 'qcsync:' || tenant_id`, `run_at = now + LIMS_QUALITY_SYNC_DEBOUNCE_SECONDS` (default 5 [CONV]). Debounce semantics: `app.enqueue_job` adds jobs with Graphile Worker `job_key_mode => 'unsafe_dedupe'` (C0 02-TRD §7.3), so an event that finds a queued or running job with the same key adds nothing and never moves its `run_at`. A steady stream of QC events therefore cannot postpone the sync. Rows committed while a sync is running are read by that run's later pages (step 6) or by the next cron tick (≤ 60 s). Matching this mode to Graphile Worker 0.18.0 exactly is C0's SP-2 check (UNVERIFIED until then); no C0 change is requested.

1. `settings.service.ensure(tx)` and `sync_state` ensure (§12.1, 08 A17 D-56). Read the cursor `(qc_cursor_at, qc_cursor_id)` from `quality.sync_state`. Initial value: `qc_cursor_at = settings.activated_at − 400 days`, `qc_cursor_id = NULL` [CONV: 400 days], so Phase-1 captured history is imported once (research/01 §1 "capture QC data from day one"; how old history is used: §6.4, 08 A17 D-60).
2. **First page of a cycle:** `SELECT … FROM lab.v_pub_qc_result WHERE tenant_id = $t AND created_at >= $cursor_at − interval '<overlap>' ORDER BY created_at, qc_result_id LIMIT $batch` (overlap `LIMS_QUALITY_SYNC_OVERLAP_SECONDS` default 600 [CONV]; batch `LIMS_QUALITY_SYNC_BATCH` default 500). `created_at` and the index `lab.qc_results (tenant_id, created_at, id)` are CR-C9-005 (ACCEPTED). **Continuation pages** use keyset order: `… WHERE tenant_id = $t AND (created_at, qc_result_id) > ($last_at, $last_id) ORDER BY created_at, qc_result_id LIMIT $batch`, where `($last_at, $last_id)` is the last row of the previous page. The overlap re-read on the first page is deduplicated by step 3.
3. Insert each row with `INSERT INTO quality.qc_observations (…) ON CONFLICT (tenant_id, source_qc_result_id) DO NOTHING RETURNING id`, each inside its own `SAVEPOINT`. A row that fails (for example an FK violation on `qc_observations__instrument__fk`/`__analyte__fk`, or a value that does not fit) is rolled back to the savepoint, logged as `qc_result_id` + SQLSTATE only (no values), counted in `lims_quality_qc_observations_total{status="import_error"}`, skipped, and the page continues. A skipped row is not retried automatically; the alert `QualityQcImportError` (§14) makes it visible.
4. Group the new observations by `(instrument_id, analyte_id)`. For each group, in its own transaction: `SELECT … FROM quality.qc_plans WHERE tenant_id = $t AND instrument_id = $i AND analyte_id = $a FOR UPDATE` (serialises assembly per pair; §7.3), then process the observations in `observed_at, received_at, source_qc_result_id` order (§6.3).
5. Persist the cursor as the last row read: `UPDATE quality.sync_state SET qc_cursor_at = $last_at, qc_cursor_id = $last_id, updated_at = now() WHERE tenant_id = $t AND (qc_cursor_at, coalesce(qc_cursor_id, '00000000-0000-0000-0000-000000000000'::uuid)) < ($last_at, $last_id)` (never backwards, also when two sync jobs overlap — E1).
6. Read the next page (step 2, continuation form) **only while** the page was full **and** the key `($last_at, $last_id)` advanced past the previous page's last key. Pages are read in the same job run until that condition fails or `LIMS_QUALITY_SYNC_TIME_BUDGET_SECONDS` (default 25 [CONV]) is used up. When the budget is used up, the job enqueues a continuation with `job_key = 'qcsync:cont:' || tenant_id` [CONV]. It uses a key of its own because `unsafe_dedupe` would drop a job that re-enqueues under its own running key.

Integration tests: 1,200 rows sharing one `created_at` second are all imported in one cycle with no repeated page; a poison row (FK violation) is skipped, counted and the cursor passes it; overlapping cron and event jobs leave one observation per `qc_result_id`.

`observed_at` (DECISION): `instrument_result_time` when present and within ±24 h [CONV] of `received_at`; otherwise `received_at`. Basis stored in `observed_at_basis`. Rationale: instrument time orders levels of one QC event correctly when the agent uploads a backlog (04 N12 stores both); the ±24 h guard stops a wrong analyser clock from reordering history.

### 6.3 Classification (first matching row wins; status stored on the observation)

| # | Check | Status | Evaluated? |
|---|---|---|---|
| 1 | `analyte_id` absent | `unmapped_analyte` | no |
| 2 | `value_numeric` absent | `non_numeric` | no |
| 3 | no `active` plan for (instrument, analyte) | `no_plan` | no |
| 4 | no active control-ID map: exact `(instrument, control_id_raw, control_lot_raw)` first, else `(instrument, control_id_raw, any lot)` | `unmapped_control` | no |
| 5 | mapped lot's level not in plan composition | `level_not_in_plan` | no |
| 6 | lot `expires_on` < `observed_at` date in the tenant timezone (`Asia/Kathmandu` in v1, 08 A13 P-15) | `lot_expired` | no |
| 7 | no target with status `active`/`superseded` effective at `observed_at` for (plan, lot) | `no_target` | no (usable for "establish") |
| 8 | `unit_code` present and ≠ target `unit_code` (absent → ASSUMPTION: reported in the analyte's unit, because C3's code map converts units) | `unit_mismatch` | no |
| 9 | `observed_at` < `run_at` of the pair's latest evaluated run (a late member of an early-rejected run has `observed_at ≥ R.run_at` and passes this row; §7.3 step 1a) | `late_unassigned` | no (charted) |
| 10 | otherwise | `assigned` (joins a run, §7.3) | yes |

The observation stores `target_id`, `mean`, `sd` (snapshot) and `z` (display only; 6 dp stored, precision rule in §5.10) when steps 7–8 pass.

### 6.4 Re-processing

`quality.reprocess_pending_observations` `{ tenant_id, instrument_id?, plan_id? }` (job key `reproc:<instrument_id|plan_id>`) runs after a control-ID map is created, a plan is activated or a target is activated. It re-runs §6.3 for observations of the scope with status ∈ {`unmapped_control`, `no_plan`, `no_target`, `level_not_in_plan`, `unit_mismatch`} and `observed_at` within `settings.reprocess_window_days` (default 7 [CONV]), oldest first, under the pair lock. Row 9 still applies, so history is never rewritten.

**Adopting Phase-1 history (08 A17 D-60).** When a plan is activated (#18), the same job also takes the pair's `no_plan` observations **older** than `reprocess_window_days`. For them it re-runs §6.3 rows 4–8 only (map, level, lot expiry, target, unit). An observation that would reach row 10 is set to `late_unassigned` instead (charted, never assembled). History therefore feeds the LJ chart (#35) and "establish from data" (#22, through `no_target` rows) but never creates runs, `quality.qc_run.rejected.v1` events or result holds.

## 7. Westgard multirule engine (algorithm specification)

Rule definitions: 04 L23 and research/01 §2.5 (1-2s, 1-3s, 2-2s, R-4s, 4-1s, 10x — VERIFIED). The N = 3 rules (2of3-2s, 3-1s, 6x, 9x) and 8x/12x are named in 04 L23, but research holds no exact text for them. Their §7.5 definitions are **DECISION (by analogy with 2-2s/4-1s/10x; UNVERIFIED as to the letter)** and pinned by golden vectors (08 A17 D-58). Quotes in this section are from research/01 §2.5 only. Other choices are labelled DECISION.

### 7.1 Definitions

- Observation `o` has value `v`, the snapshot target `(mean, sd)` of its lot, level `L`, and order key `(observed_at, level.sort_order, observation.id)`.
- **Exceeds** (DECISION, strict inequality, exact decimal arithmetic): `o` exceeds `+kSD` iff `v − mean > k × sd`; exceeds `−kSD` iff `v − mean < −k × sd`. A value exactly on a limit does not exceed it (research/01 §2.5 definitions use "exceeds").
- **Side of mean**: above iff `v − mean > 0`, below iff `< 0`; a value equal to the mean is on neither side and breaks an n-x sequence (DECISION).
- `z = (v − mean) / sd` is for display only (stored 6 dp half-up, wire 3 dp, display 2 dp — §5.10); rules never use `z` (08 A17 D-54).
- **Current run** `C` = the run being evaluated (its non-excluded `assigned` observations, in order-key order).
- **History** `H` = earlier non-excluded `assigned` observations of the same plan (instrument × analyte) whose runs have outcome `accepted`, `accepted_warning` or `incomplete`, plus `rejected` when `exclude_rejected_runs_from_history = false`; most recent last; limited to the last 11 per level and the last 11 overall (the longest window, 12x, needs 11 predecessors).
- **Sequences**: `S = H ++ C` (all levels interleaved by order key); `S_L = (H ++ C)` filtered to level `L`.
- **Attribution**: a window (a run of consecutive elements of `S`, `S_L` or `C`) only counts if at least one of its *violating* observations belongs to `C`. Old violations never reject a new run.

### 7.2 Rule set by N (04 L23)

| N (`controls_per_run`) | Warning | Rejection rules |
|---|---|---|
| 2 or 4 | 1-2s | 1-3s, 2-2s, R-4s, 4-1s, and one of 8x / **10x** (default) / 12x |
| 3 | 1-2s | 1-3s, 2of3-2s, R-4s, 3-1s, and one of **6x** (default) / 9x |

04 L23 lists for N=3 "2of3 2s, 3-1s, 6x/9x" and for N=2/4 "2-2s, 4-1s, 8x/10x/12x". **DECISION (UNVERIFIED as to the letter, 08 A17 D-58):** the N=3 rules replace the count-based rules (2-2s, 4-1s, 10x) only; 1-3s and R-4s stay in the N=3 set. The event schema already lists all of these codes (03-IC §3.21).

### 7.3 Run assembly (`assembly.ts`, DECISION)

Input: an `assigned` observation `o` for plan `P` (pair locked, §6.2 step 4).

1. Let `R` = the pair's run with `status = 'collecting'` (at most one — partial unique index).
1a. **Early-rejected run (08 A17 D-52).** If no collecting run exists, let `R` = the pair's latest run with `status = 'evaluated' AND outcome = 'rejected' AND is_complete = false`. If `o.observed_at − R.run_at ≤ run_window_minutes` and `count(R, o.level) < composition[o.level]`, attach `o` to `R` (observation `assigned`, `observation_count + 1`, `last_member_received_at`, `last_assembled_at = now()`, its rule hits appended to `rule_detail`), never re-evaluate, and stop. Otherwise continue with step 4.
2. If a collecting `R` exists and `o.observed_at − R.run_at ≤ run_window_minutes` and `count(R, o.level) < composition[o.level]` → add `o` to `R` (`last_assembled_at = now()`).
3. Else if a collecting `R` exists → evaluate `R` final (§7.5, outcome may be `incomplete`), then open a new run with `o`.
4. Else open a new run `R'` with `run_at = o.observed_at`, `last_assembled_at = now()`, `plan_version_no` = current, `controls_per_run` = N, `rule_mode` = `IdentityPort.getTenantSettings(ctx, { keys: ['westgardMode'] })` at open time.
5. After adding: if the run now has N observations matching the composition → evaluate final. Else evaluate **provisionally**: if any rejection rule fires (§7.5) → finalise as `rejected` now (real-time per point — research/01 §2.5 "evaluate rules in real time per point"); otherwise keep collecting.
6. A run rejected early keeps its late members through step 1a while the window lasts and its composition is not full. Late members are stored (`assigned`, linked) and their rule hits recorded in `rule_detail`, but `outcome`, `rules_violated` (as at rejection), `is_complete = false` and the event never change (monotonic; trigger `quality.enforce_run_frozen`).
7. `quality.close_stale_runs` (cron `* * * * *` `per_tenant`) finalises every `collecting` run whose `last_assembled_at < now − run_window_minutes`. Staleness uses the server time of the last assembly, not the instrument-side `received_at`, so a backlog import split over several sync pages does not close a run whose remaining members are in the next page. The window test in steps 1a and 2 keeps using `observed_at`.

Assembly vectors (unit, `assembly.ts`; N = 2, composition {L1: 1, L2: 1}, window 30 min):

| ID | Sequence | Expected |
|---|---|---|
| AS1 | V27 (L1 z 3.4 at 08:00, rejected early), then L2 z 0.2 observed 08:10 | one run: `rejected`, `is_complete = false`, `observation_count = 2`, `rules_violated = [1-3s]`; exactly one `quality.qc_run.rejected.v1` |
| AS2 | as AS1, but L2 observed 08:40 (outside the window) | the L2 observation opens a new collecting run |
| AS3 | as AS1, then a second L1 observed 08:15 | `count(R, L1) = composition[L1]`, so the observation opens a new run (step 4) |
| AS4 | backlog upload: L1 observed and received 02:00 is assembled at 08:00 (new collecting run); `close_stale_runs` ticks at 08:05; L2 observed 02:02 is processed on the next sync page at 08:06 | the run is still collecting at 08:05 (`last_assembled_at` 08:00 + 30 min > 08:05) and L2 joins it: one complete run |

### 7.4 History choices (DECISION)

- History crosses lot changes and target versions: each observation keeps its own target snapshot, so sequences are compared in SD units (glossary "Target mean / SD").
- `exclude_rejected_runs_from_history = true` by default: after a rejection and corrective action the next run is not rejected again for the same old points (vectors V26a/b show the effect). Labs that want rejected points to count switch it off.
- Excluded observations (`excludeQcObservation`) are skipped as if absent, so the sequence closes over them (V25).

### 7.5 Rule evaluation (`westgard.ts`)

```ts
export type RuleCode = '1-2s' | '1-3s' | '2-2s' | 'R-4s' | '4-1s' | '10x' | '2of3-2s' | '3-1s' | '6x' | '8x' | '9x' | '12x';
import type { Decimal } from '@lims/shared-ts/decimal';                                            // 08 R12a, 08 A17 D-54
export interface QcPoint { id: string; level: string; dev: Decimal; sd: Decimal; inCurrentRun: boolean } // dev = v − mean (exact)
export interface WestgardOptions { n: 2 | 3 | 4; mode: 'classic' | 'modern'; meanRule: '6x' | '8x' | '9x' | '10x' | '12x';
  twoTwoAcrossRuns: boolean; countAcrossMaterials: boolean }
export interface WestgardResult { warning: boolean; fired: readonly RuleCode[];                 // fired = rejection rules, canonical order
  hits: readonly { rule: RuleCode; observationIds: readonly string[] }[];                          // incl. '1-2s'
  outcome: 'accepted' | 'accepted_warning' | 'rejected' }                                           // 'incomplete' is decided by the caller
export function evaluate(current: readonly QcPoint[], history: readonly QcPoint[], o: WestgardOptions): WestgardResult;
```

Let `exc(o,k,+1)` ≡ `o.dev > k·o.sd`, `exc(o,k,−1)` ≡ `o.dev < −k·o.sd` (exact decimal multiplication and comparison; no division — 08 A17 D-54).

| Rule | Fires iff (with attribution §7.1) | Scope |
|---|---|---|
| 1-2s (warning) | ∃ o ∈ C: exc(o,2,+1) ∨ exc(o,2,−1) | current run |
| 1-3s | ∃ o ∈ C: exc(o,3,±1) | current run |
| R-4s | ∃ a, b ∈ C: exc(a,2,+1) ∧ exc(b,2,−1) | **current run only** ("this rule should only be interpreted within-run, not between-run" — research/01 §2.5) |
| 2-2s | ∃ window of 2 consecutive elements, both exc(·,2,s) for the same s, ≥1 in C, in: `C` (within run, across levels) or, if `twoTwoAcrossRuns`, any `S_L` | 01 §2.5 scopes (letter UNVERIFIED) |
| 2of3-2s | ∃ window of 3 consecutive elements with ≥2 elements exc(·,2,s) for the same s, ≥1 of those in C, in: `C` or, if `twoTwoAcrossRuns`, any `S_L` | same scopes as 2-2s (DECISION by analogy with 2-2s; UNVERIFIED as to the letter — D-58) |
| 4-1s / 3-1s | ∃ window of 4 / 3 consecutive elements all exc(·,1,s) for the same s, ≥1 in C, in: any `S_L`, and `S` if `countAcrossMaterials` | 4-1s: research/01 §2.5 "often applied **across runs** (and across materials)"; 3-1s: DECISION by analogy with 4-1s (UNVERIFIED as to the letter — D-58) |
| kx (6, 8, 9, 10, 12) | ∃ window of k consecutive elements all on the same side of the mean, ≥1 in C, in: any `S_L`, and `S` if `countAcrossMaterials` | 10x: research/01 §2.5 "usually has to be applied across runs and often across materials"; 6x, 8x, 9x, 12x: DECISION by analogy with 10x (UNVERIFIED as to the letter — D-58) |

Mode gating:
- **classic**: 4-1s, 3-1s and the kx rule are reported only if 1-2s fired in `C` (research/01 §2.5 implementation note: "in the **classic** multirule, 4-1s and 10x are evaluated only after a 1-2s warning has fired"; **DECISION** to apply the same gate to their N=3/N=4 variants 3-1s, 6x, 8x, 9x, 12x). 1-3s, 2-2s, 2of3-2s and R-4s need no explicit gate: each requires an observation in `C` beyond 2SD, which is itself a 1-2s violation.
- **modern**: every rule evaluated independently (research/01 §2.5: "In the **modern** version they are evaluated independently"). 1-2s is still reported as a warning (DECISION: 03-IC §4.11 defines `warning` = 1-2s fired).

Outcome: any rejection rule fired → `rejected`; else 1-2s → `accepted_warning`; else `accepted`. The caller sets `incomplete` when the run is finalised with fewer than N observations and the result is not `rejected` (a 1-2s on an incomplete run is kept in `warning_rules`).

Canonical order of `fired`/`rules_violated`: `1-3s, 2-2s, 2of3-2s, R-4s, 4-1s, 3-1s, 6x, 8x, 9x, 10x, 12x`.

### 7.6 Target statistics (`target-stats.ts`)

Decimal-only arithmetic with `@lims/shared-ts/decimal` (08 R12a; 08 A17 D-54). There is no rational type.
- `S1 = Σv` and `S2 = Σv²` are exact decimal sums.
- `mean = S1 / n`: one division at 28 significant digits, half-up.
- `variance = (n·S2 − S1²) / (n·(n − 1))`: the numerator is exact; one division at 28 significant digits, half-up.
- `sd = sqrt(variance)` in IEEE-754 double, rounded to 15 significant digits and marked `inexact` (R12a).
- Stored target `mean` and `sd` are rounded half-up to the analyte's `decimals + 2` (≤ 6) [CONV]. `n ≥ settings.target_min_points` (default 20 [CONV]; "≥20 baseline runs" is common practice, UNVERIFIED — research/01 §2.5); n < 2 always fails.
- Golden case (unit, T-02): 20 synthetic values pin `S1`, `S2`, the unrounded mean and variance, the 15-digit `sd` and the stored rounded mean/sd.
- `cv_pct = sd / mean × 100` (display only; mean = 0 → omitted).

### 7.7 Rejection event and `hold_since`

In the transaction that sets `outcome = 'rejected'`:

```ts
await events.publish(tx, 'quality.qc_run.rejected.v1', {
  aggregate: { type: 'qc_run', id: run.id, seq: run.version },
  idempotencyKey: `${run.id}:rejected`,
  payload: { qc_run_id: run.id, instrument_id: run.instrumentId, analyte_ids: [run.analyteId],
             rules_violated: run.rulesViolated,               // ≥1, canonical order, ⊆ event enum
             rule_mode: run.ruleMode, controls_per_run: run.controlsPerRun,
             run_at: run.runAt, last_in_control_run_at: lastInControl?.runAt /* omitted when unknown */,
             hold_since: lastInControl?.runAt ?? minus(run.runAt, plan.holdLookbackHours), rejected_at: run.evaluatedAt },
});
```

`last_in_control_run_at` = `run_at` of the latest run of the same plan with outcome `accepted` or `accepted_warning` and `run_at < run.run_at` (`incomplete` runs do not count — DECISION, they did not run every level).

| Vector | Prior runs of the pair | Rejected run `run_at` | `last_in_control_run_at` | `hold_since` |
|---|---|---|---|---|
| H1 | R2 accepted_warning 2026-11-05T06:00:00.000Z | 2026-11-05T09:00:00.000Z | 2026-11-05T06:00:00.000Z | 2026-11-05T06:00:00.000Z |
| H2 | none; `hold_lookback_hours = 24` | 2026-11-05T06:00:00.000Z | (omitted) | 2026-11-04T06:00:00.000Z |
| H3 | R1 accepted 01:00; R5 incomplete 05:00 (same day) | 2026-11-05T06:00:00.000Z | 2026-11-05T01:00:00.000Z | 2026-11-05T01:00:00.000Z |
| H4 | R1 accepted 2026-11-01T01:00Z only | 2026-11-05T06:00:00.000Z | 2026-11-01T01:00:00.000Z | 2026-11-01T01:00:00.000Z (03-IC: use the last in-control run when known, whatever its age; the status board warns "hold window > 24 h") |

**Close-out guard (#32, 03-APP-FLOW QR7; 08 A17 D-52).** A rejected run `R` may be closed only when (a) ≥ 1 `qc_corrective_actions` row exists for it (`409 quality.corrective_action_required`; DB backstop in `quality.enforce_run_frozen`), and (b) a later run of the same plan has outcome `accepted`/`accepted_warning` **and `run_at > R.run_at + run_window_minutes`** (`409 quality.rerun_required`). Condition (b) stops the remainder of the same QC event from counting as the rerun.

### 7.8 `qcStatusFor` (`qc-status.ts`)

Input `(instrumentId, analyteId, at)`. Steps:
1. No plan for the pair (any status) → `no_qc_data`.
2. Let `E` = runs of the plan with `status ∈ {evaluated, closed}` and `run_at ≤ at`. Empty → `no_qc_data`.
3. `open` = runs in `E` with outcome `rejected` and (`closed_at` absent or `closed_at > at`). If `open` is non-empty → `out_of_control`, `currentRunId` = latest of `open`, `violatedRules` = its `rules_violated`.
4. Else `g` = latest run in `E`: `accepted` → `in_control`; `accepted_warning` → `warning`, `violatedRules: ['1-2s']`; `incomplete` → `warning`, `violatedRules: ['incomplete_run']` (+ `'1-2s'` if present); `currentRunId = g.id`.
5. `lastInControlRunAt` = latest `run_at` in `E` with outcome `accepted`/`accepted_warning`.
6. Staleness: if the result of 3–4 is `in_control` or `warning` and (`lastInControlRunAt` absent or `at − lastInControlRunAt > qc_validity_hours`) → `no_qc_data` (keep `lastInControlRunAt`).

Timeline for vectors S1–S8 (pair I1×K, validity 24 h, all 2026-11-05 unless stated): R1 01:00 accepted; R2 06:00 accepted_warning (1-2s); R3 09:00 rejected (1-3s), closed 10:30; R4 10:00 accepted; R5 14:00 incomplete.

| Vector | `at` | status | lastInControlRunAt | currentRunId | violatedRules |
|---|---|---|---|---|---|
| S1 | 00:30 | no_qc_data | — | — | — |
| S2 | 03:00 | in_control | 01:00 | R1 | — |
| S3 | 07:00 | warning | 06:00 | R2 | [1-2s] |
| S4 | 09:30 | out_of_control | 06:00 | R3 | [1-3s] |
| S5 | 10:15 | out_of_control | 10:00 | R3 | [1-3s] |
| S6 | 11:00 | in_control | 10:00 | R4 | — |
| S7 | 15:00 | warning | 10:00 | R5 | [incomplete_run] |
| S8 | 2026-11-06T10:30 | no_qc_data | 10:00 (11-05) | R5 | [incomplete_run] |

Query: `qc_runs__tenant_plan_runat__idx (tenant_id, plan_id, run_at DESC)` — the latest ≤ 20 evaluated runs are read and reduced in memory; `open` uses `qc_runs__tenant_plan_open_rejected__p_idx`. Plan lookup by `(tenant_id, instrument_id, analyte_id)` unique index. No writes.

### 7.9 Westgard test vectors (derived from the definitions; mean 100.0, SD 2.0, value = 100 + 2z)

Each vector lists history runs (oldest first, each `[level: z, …] outcome`) and the current run. Unless stated: `twoTwoAcrossRuns = true`, `countAcrossMaterials = true`, `exclude_rejected_runs_from_history = true`, mean rule = default for N. Expected `fired` and `warning` are exact. These vectors were executed against a reference implementation of this section before publication.

| ID | N | Mode | History | Current run (z) | Options | Outcome | Fired | 1-2s |
|---|---|---|---|---|---|---|---|---|
| V01 | 2 | classic | — | L1 0.5, L2 −0.5 | | accepted | — | no |
| V02 | 2 | classic | — | L1 2.1, L2 0 | | accepted_warning | — | yes |
| V03 | 2 | classic | — | L1 3.1, L2 0 | | rejected | 1-3s | yes |
| V04 | 2 | classic | — | L1 2.2, L2 2.1 | | rejected | 2-2s | yes |
| V05 | 2 | classic | — | L1 2.2, L2 −2.2 | | rejected | R-4s | yes |
| V06 | 2 | classic | [L1 2.2, L2 0] acc_warn | L1 −2.2, L2 0 | | accepted_warning | — (R-4s is within-run only) | yes |
| V07 | 2 | classic | — | L1 3.5, L2 −0.6 | | rejected | 1-3s (not R-4s) | yes |
| V08 | 2 | classic | [L1 2.2, L2 0] acc_warn | L1 2.1, L2 0 | | rejected | 2-2s (across runs, L1) | yes |
| V08b | 2 | classic | as V08 | L1 2.1, L2 0 | twoTwoAcrossRuns=false | accepted_warning | — | yes |
| V09 | 2 | classic | [L1 0, L2 2.2] acc_warn | L1 2.1, L2 0 | | accepted_warning | — (prev L2 + cur L1 is not a 2-2s scope) | yes |
| V10m | 2 | modern | [L1 1.5, L2 1.5] acc | L1 1.5, L2 1.5 | | rejected | 4-1s | no |
| V10c | 2 | classic | as V10m | L1 1.5, L2 1.5 | | accepted | — (gated: no 1-2s) | no |
| V11 | 2 | classic | [L1 1.5, L2 1.5] acc | L1 2.1, L2 1.5 | | rejected | 4-1s | yes |
| V12m | 2 | modern | 4 × [L1 0.5, L2 0.5] acc | L1 0.5, L2 0.5 | | rejected | 10x | no |
| V12c | 2 | classic | as V12m | L1 0.5, L2 0.5 | | accepted | — | no |
| V13 | 2 | modern | 3 × [0.5, 0.5] acc, then [L1 0.5, L2 0] acc | L1 0.5, L2 0.5 | | accepted | — (0 breaks the sequence) | no |
| V14 | 2 | modern | 9 × [L1 0.5, L2 −0.5] acc | L1 0.5, L2 −0.5 | | rejected | 10x (within L1 across 10 runs) | no |
| V14b | 2 | modern | 8 × [L1 0.5, L2 −0.5] acc | L1 0.5, L2 −0.5 | | accepted | — | no |
| V15a | 2 | modern | 3 × [0.5, 0.5] acc | L1 0.5, L2 0.5 | meanRule 8x | rejected | 8x | no |
| V15b | 2 | modern | 3 × [0.5, 0.5] acc | L1 0.5, L2 0.5 | (10x) | accepted | — | no |
| V16 | 3 | classic | — | L1 2.1, L2 2.2, L3 0 | | rejected | 2of3-2s | yes |
| V17 | 3 | classic | — | L1 2.1, L2 0, L3 −0.5 | | accepted_warning | — | yes |
| V18m | 3 | modern | — | L1 1.2, L2 1.3, L3 1.1 | | rejected | 3-1s | no |
| V18c | 3 | classic | — | L1 1.2, L2 1.3, L3 1.1 | | accepted | — | no |
| V19 | 3 | modern | [L1 0.3, L2 0.4, L3 0.2] acc | L1 0.1, L2 0.6, L3 0.9 | (6x) | rejected | 6x | no |
| V19b | 3 | modern | as V19 | as V19 | meanRule 9x | accepted | — | no |
| V20 | 3 | modern | 2 × [0.3, 0.4, 0.2] acc | L1 0.1, L2 0.6, L3 0.9 | meanRule 9x | rejected | 9x | no |
| V21 | 3 | classic | — | L1 2.1, L2 −2.3, L3 0 | | rejected | R-4s | yes |
| V22 | 4 | classic | — | L1 1.2, L1 1.4, L2 1.1, L2 2.1 | | rejected | 4-1s | yes |
| V23a | 4 | modern | [L1 0.5, L1 0.5, L2 0.5, L2 0.5] acc | same values | meanRule 8x | rejected | 8x | no |
| V23b | 4 | modern | as V23a | same values | (10x) | accepted | — | no |
| V24a | 2 | classic | — | L1 2.0, L2 −2.0 | | accepted | — (on the limit ≠ exceeds) | no |
| V24b | 2 | classic | — | L1 3.0, L2 0 | | accepted_warning | — | yes |
| V25 | 2 | modern | [1.5, 1.5] acc, then [L1 −0.4 **excluded**, L2 1.5] acc | L1 1.5, L2 1.5 | | rejected | 4-1s (excluded point skipped) | no |
| V26a | 2 | modern | [1.5, 1.5] acc, then [L1 −3.5, L2 0.2] **rejected** | L1 1.5, L2 1.5 | (exclude rejected) | rejected | 4-1s | no |
| V26b | 2 | modern | as V26a | L1 1.5, L2 1.5 | exclude_rejected=false | accepted | — | no |
| V27 | 2 | classic | — | L1 3.4 (first member only) | provisional | rejected (early) | 1-3s | yes |
| V30 | 2 | classic | [L1 0, L2 −2.4] acc_warn | L1 0.3, L2 −2.05 | | rejected | 2-2s (negative side, L2) | yes |
| V31 | 2 | modern | [L1 1.5, L2 0.2], [L1 1.5, L2 −0.3], [L1 1.5, L2 0.1] acc | L1 1.5, L2 0 | | rejected | 4-1s (within L1) | no |
| V31b | 2 | modern | as V31 | as V31 | countAcrossMaterials=false | rejected | 4-1s | no |
| V32 | 2 | modern | [1.5, 1.5] acc | L1 1.5, L2 1.5 | countAcrossMaterials=false | accepted | — (only 2 per level) | no |

Additional required unit cases: same vectors with SD 0.5 and mean −10 (sign handling); a vector per mean-rule option with exactly k−1 points (must not fire); classic-mode V22 with L2 2.1 replaced by 1.9 (no 1-2s → accepted). `incomplete`: N=2, single member z 0.5, finalised by `close_stale_runs` → outcome `incomplete`, `warning_rules = []`.

### 7.10 Levey-Jennings chart data (`LjChartDto`)

```ts
interface LjChartDto {                      // HTTP JSON → snake_case (02-CV §3); the features/quality view-model maps it to camelCase
  plan: { id: string; instrument_id: string; analyte_id: string; analyte_code: string; unit_code?: string; decimals: number };
  view: 'level' | 'z';
  series: readonly {
    level_id: string; level_code: string; lot_id: string; lot_no: string;
    points: readonly { observation_id: string; observed_at: string; value: string /* DecimalString */; z?: string /* 3 dp */;
      status: 'accepted' | 'warning' | 'rejected' | 'excluded' | 'unevaluated' | 'collecting';
      qc_run_id?: string; rule_hits: readonly string[] }[];
    targets: readonly { target_id: string; effective_from: string; effective_to?: string; mean: string; sd: string; source: 'manufacturer' | 'established' }[];
  }[];
  truncated: boolean;                       // > LIMS_QUALITY_LJ_MAX_POINTS (2,000 [CONV]) → newest kept
}
```

Point status mapping: observation `excluded` → `excluded`; status ≠ `assigned` → `unevaluated`; run `collecting` → `collecting`; run outcome `rejected` and the point is in a `rule_detail` hit → `rejected`; point beyond 2SD → `warning`; else `accepted`. Lines (drawn by the chart component): mean, ±1SD, ±2SD, ±3SD per target segment. `view = 'z'`: y = z for all levels of the plan, lines at 0, ±1, ±2, ±3.

## 8. Auto-verification

### 8.1 Rule-set lifecycle (summary; full machine in 03-APP-FLOW §2.3)

`draft → simulating → active → retired`; `simulating → stopped` (terminal); `draft → discarded` (08 A17 D-55). Stopping a simulation sets `simulation_stopped_at`, clears the rule-set pointer and keeps the shadow rows; to continue, the user creates a new draft with #37 `copy_from_version_id`. One rule set per tenant (D-AV-3); at most one `active` and one `simulating` version (partial unique indexes). A version's `definition` is immutable once it leaves `draft` (trigger `quality.enforce_version_frozen`, unchanged by D-55), and `stopped`, `retired` and `discarded` are terminal (same trigger). A simulation report covers that version's shadow rows only.

### 8.2 DSL (`RuleSetDefinition`, JSON stored in `autoverify_versions.definition`)

```jsonc
{
  "schema_version": 1,
  "rules": [                                   // 0..2000 [CONV]
    {
      "key": "K_ANY",                          // ^[A-Za-z0-9_-]{1,40}$, unique in the version
      "test_id": "01a1a98a-ac40-7000-8000-000000070011",   // analyte's test (validated via CatalogPort.getTest)
      "analyte_id": "01a1a98a-ac40-7000-8000-000000080011",
      "instrument_id": "01a1a98a-ac40-7000-8000-0000000d0001", // optional; absent = any instrument
      "enabled": true,                         // false = explicit opt-out (blocks the any-instrument fallback)
      "limits": { "low": "3.5", "high": "5.1" },            // DecimalString, inclusive; ≥1 bound; low ≤ high
      "allowed_range_flags": ["N"],            // non-empty subset of N, L, H (LL/HH/A are never allowed)
      "instrument_flags_allowed": [],          // exact strings (≤20 items, each ≤16 chars) ignored when present
      "qc_allow_warning": false,               // allow when qcStatusFor = warning
      "note": "Synthetic potassium rule"       // ≤200
    }
  ]
}
```

JSON Schema: `additionalProperties: false` everywhere; `rules[].key` unique; `(analyte_id, instrument_id ?? '*')` unique; `limits.low ≤ limits.high` when both; the analyte must belong to `test_id` and have `resultType = 'numeric'` (CatalogPort `getTest`) — violations → `422 quality.rule_set_invalid` with JSON-Pointer `errors[]`. Rationale for numeric-only: `ResultContext` carries `valueNumeric` but no ordinal code (03-IC §4.11), so non-numeric rules could not be evaluated (DECISION).

Compilation: `Map<"analyteId|instrumentId", Rule>` plus `Map<"analyteId|*", Rule>`; cached per process keyed `(tenant_id, version_id)` (immutable → no invalidation needed; LRU `LIMS_QUALITY_RULE_CACHE_MAX` = 200 versions [CONV]).

### 8.3 What C9 needs from C5 (CR-C9-004)

Before CR-C9-004, C5 called `canAutoVerify` only when `LIMS_LAB_AUTOVERIFY_HOOK_ENABLED=true` **and** `autoVerificationEnabled`. Shadow simulation needs the call while the tenant is still disabled. CR-C9-004 has C5 call `canAutoVerify` for every `origin = instrument` R2/R3 save that is not `on_hold` and not `unit_mismatch` whenever the env flag is on, and act only on `allow`. Port semantics are unchanged: C9 returns `deny`/`feature_disabled` while the tenant is disabled (03-IC §4.11 invariant). CR-C9-004 is ACCEPTED (08 §3) and C5 implements it (C5 02-TRD §4.5 step 11).

### 8.4 `canAutoVerify` algorithm (`autoverify-eval.ts`)

```ts
canAutoVerify(ctx, rc: ResultContext): Promise<{ decision: 'allow' | 'deny'; reasons: readonly AutoVerifyReason[]; ruleSetVersion?: string }>
```

1. `enabled` = `IdentityPort.getTenantSettings(ctx, { keys: ['autoVerificationEnabled'] })`. Load `active` and `simulating` version ids (cached per request; table `autoverify_rule_sets` row).
2. **Live evaluation** (`active` version `A`):
   - not `enabled` → live result `deny [feature_disabled]` (no live row).
   - `enabled` and no `A` → `deny [rule_missing]` (no live row; metric).
   - else `r = evaluateWith(A)` and insert a `live` decision row.
3. **Shadow evaluation** (`simulating` version `S` exists): `evaluateWith(S)` ignoring `enabled`; insert a `shadow` row. Never affects the returned value.
4. Return the live result; `ruleSetVersion = A.id` when `A` was used.

`evaluateWith(V)` (reasons accumulated in canonical order: `manual_origin, rule_missing, critical, delta_failure, instrument_flag, outside_autoverify_limits, qc_out_of_control, qc_warning, qc_no_data`):
1. `rc.instrumentId` absent → `[manual_origin]`, stop (no QC lookup possible; calculated and manual results are never auto-verified — D-AV-2).
2. `rule` = `V[analyte|instrument]` if present, else `V[analyte|*]`. None, or `enabled = false` → add `rule_missing` (limits skipped).
3. `rc.isCritical` → `critical`. 4. `rc.deltaCheckFailed` → `delta_failure`.
5. `flags = rc.instrumentFlags \ rule.instrument_flags_allowed` (no rule → all) non-empty → `instrument_flag`.
6. With a rule: `valueNumeric` absent, or `< low`, or `> high` (exact decimal compare, inclusive limits), or `rangeFlag` absent or ∉ `allowed_range_flags` → `outside_autoverify_limits` (once).
7. `q = qcStatusFor({ instrumentId, analyteId, at: rc.resultedAt })`: `out_of_control` → `qc_out_of_control`; `no_qc_data` → `qc_no_data`; `warning` and not `rule.qc_allow_warning` (or no rule) → `qc_warning` (CR-C9-003, ACCEPTED in 08).
8. `decision = reasons.length === 0 ? 'allow' : 'deny'`.

Decision row: `id, tenant_id, decided_at = ctx.now(), mode, version_id, result_id, analyte_id, instrument_id, decision, reasons, matched_rule_key, qc_status, qc_run_id, inputs {value_numeric, range_flag, delta_check_failed, is_critical, instrument_flags, resulted_at}`, inside `ctx.tx` (the caller's transaction — 02-CV §8.1); if C5's transaction rolls back, so does the row.

### 8.5 Auto-verify test vectors

Fixture: tenant enabled; active version V3 with rule `K_ANY` (analyte K, any instrument, limits 3.5–5.1, flags [N], no instrument flags allowed, `qc_allow_warning = false`) and rule `K_I2_OFF` (analyte K, instrument I2, `enabled = false`). Base context: instrument I1, analyte K, value "4.2", rangeFlag N, flags [], delta false, critical false; `qcStatusFor` = in_control.

| ID | Change from base | decision | reasons |
|---|---|---|---|
| A1 | — | allow | [] (ruleSetVersion = V3 id) |
| A2 | tenant disabled | deny | [feature_disabled] |
| A3 | instrumentId absent | deny | [manual_origin] |
| A4 | value "7.0", rangeFlag HH, isCritical | deny | [critical, outside_autoverify_limits] |
| A5 | deltaCheckFailed | deny | [delta_failure] |
| A6 | instrumentFlags ["SYN_FLAG"] | deny | [instrument_flag] |
| A7 | value "5.2", rangeFlag H | deny | [outside_autoverify_limits] |
| A8 | value "5.1", rangeFlag N | allow | [] (inclusive limit) |
| A9 | valueNumeric absent | deny | [outside_autoverify_limits] |
| A10 | QC out_of_control | deny | [qc_out_of_control] |
| A11 | QC no_qc_data | deny | [qc_no_data] |
| A12 | QC warning | deny | [qc_warning] (CR-C9-003 accepted in 08) |
| A13 | instrument I2 | deny | [rule_missing] |
| A14 | analyte with no rule | deny | [rule_missing] |
| A15 | delta + flags ["SYN_FLAG"] + QC out_of_control | deny | [delta_failure, instrument_flag, qc_out_of_control] |
| A16 | tenant disabled, version V4 simulating with K_ANY limits 3.0–6.0 | live deny [feature_disabled]; shadow row allow [] | — |

### 8.6 Simulation report (`SimulationReportDto`)

Computed on read from `autoverify_decisions` (mode `shadow`, version = V, `decided_at ≥ simulation_started_at`) left-joined to `verification_log` on `result_id`:
`{ version_id, started_at, days_running, decisions, would_allow, would_deny, deny_by_reason: {reason: count}, allow_later_manually_verified, allow_not_verified_yet, live_comparison?: { both_allow, live_only_allow, shadow_only_allow }, sample: [{ decision_id, result_id, order_id?, analyte_id, decided_at, shadow_decision, shadow_reasons, live_decision?, manually_verified_at? }] }` (`live_decision` = the decision of the `live` row written in the same `canAutoVerify` call for that `result_id`; absent when no live row exists, D-AV-4) with `sample` = most recent `sample_limit` would-allow decisions. `order_id` comes from `verification_log` (payload of `lab.result.verified.v1`); the UI links it with `staff.lab.order_results`. Minimums for activation: `days_running ≥ settings.sim_min_days` (7 [CONV]) and `decisions ≥ settings.sim_min_decisions` (100 [CONV]).

## 9. TAT alerts

### 9.1 Inputs

| Input | Use |
|---|---|
| `lab.v_pub_pending_items` (03-IC §6.3) | the set of open tests: `order_item_id, test_id, specimen_id, order_id, centre_id, department_id, priority, item_status, received_at, tat_target_seconds` (C5's snapshot of the catalog target for the item's priority) |
| `reporting.v_pub_order_report_tat` (03-IC §6; C9 is a listed consumer) | `registered_at` of the order: start of the total segment (08 A17 D-59). Read by the TAT worker only when it creates a total clock (worker projection, 08 A17 P-21) |
| `lab.v_pub_specimen_timeline` | `ordered_at` of the order's specimens (fallback start of the total segment when the order has no `v_pub_order_report_tat` row yet) |
| `CatalogPort.getTest({ testId, asOf: ordered_at })` | `tatTargetSegment` (CR-C3-001; absent → `within_lab`, the C3 column default) |
| `lab.result.verified.v1` | within-lab stop (first verified result of that order item × test); `first_verified_at` for total clocks |
| `reporting.report.released.v1` | total stop: `report_kind ∈ {final, partial}` → the items in `order_item_ids` when the field is present (CR-C5-006, accepted in 08); `final` without `order_item_ids` → all items of the order; otherwise — incl. `addendum`/unknown kinds — none. A `final` release of one report family therefore stops only that family's items (C6 tracks finality per family, `v_pub_order_report_tat`) |
| `lab.specimen.status_changed.v1` | trigger `quality.tat_refresh_order` (receipt, rejection, recollection) |

### 9.2 Segments (01 §2.7; named on every screen)

| Segment | Start | Stop |
|---|---|---|
| `within_lab` | `received_at` of the specimen currently carrying the test (restarts on recollection) | first `lab.result.verified.v1` for (order_item_id, test_id) |
| `total` | `registered_at` of the order from `reporting.v_pub_order_report_tat`, read by the TAT worker when it creates the clock (08 A17 D-59, P-21). If the view has no row for the order yet, the start falls back to the earliest specimen `ordered_at` (C5 creates specimens from `frontdesk.order.created.v1` with p95 ≤ 5 s, C5 02-TRD §10). The basis is stored in `tat_items.start_basis` (`registered_at` / `specimen_ordered_at`) and is not changed later | a release whose `order_item_ids` contains the item, or a `final` release without `order_item_ids` |

### 9.3 Clock (`tat-clock.ts`, one `quality.tat_items` row per order_item × test)

`state ∈ {not_started, running, stopped, cancelled, orphan_closed}`; `alert_level ∈ {none, warning, breached, escalated}` with thresholds `pct = elapsed / target × 100`: `≥ tat_warn_pct` (80 [CONV]) → warning, `≥ 100` → breached, `≥ tat_escalate_pct` (150 [CONV]) → escalated. Levels only rise while running; each first crossing inserts a `tat_alert_events` row. Transition table: 03-APP-FLOW §2.4.

`quality.tat_sweep` (cron `* * * * *`, per tenant, when `settings.tat_alerts_enabled`):
1. `settings.service.ensure(tx)` (§12.1). `SELECT … FROM lab.v_pub_pending_items p LEFT JOIN lab.v_pub_specimen_timeline s ON s.tenant_id = p.tenant_id AND s.specimen_id = p.specimen_id WHERE p.tenant_id = $t AND p.tat_target_seconds IS NOT NULL`. For order ids that need a new total clock: `SELECT order_id, registered_at FROM reporting.v_pub_order_report_tat WHERE tenant_id = $t AND order_id = ANY($ids)`, and `min(ordered_at)` per order from the timeline for orders the view does not return.
2. Upsert `tat_items` (key `(tenant_id, order_item_id, test_id)`); new rows get `segment` from CatalogPort (cached by `(test_id, catalog revision)`), `target_seconds` from the view, and `start_basis` (`specimen_received_at` for `within_lab`; `registered_at` or `specimen_ordered_at` for `total`, step 1); set `last_seen_sweep_at = now`.
3. Apply §9.3 transitions: start/restart (`received_at`/`specimen_id` changed), level recompute, insert alert events.
4. Rows `running`/`not_started` not seen in this sweep: `within_lab` → `cancelled`; `total` with `first_verified_at` set → keep running, `in_pending_view = false`; `total` without → `cancelled`.
5. `total` rows with `in_pending_view = false` and `now − left_pending_view_at > tat_orphan_close_hours` (72 [CONV]) → `orphan_closed`.

### 9.4 TAT vectors (CBC routine target 14,400 s, warn 80 %, escalate 150 %)

| ID | Situation | Expected |
|---|---|---|
| T1 | within_lab, received 08:00, now 11:11 (11,460 s) | running, level none |
| T2 | now 11:12 (11,520 s = 80 %) | warning (≥ is inclusive) |
| T3 | now 12:00 (100 %) | breached |
| T4 | now 14:00 (150 %) | escalated |
| T5 | `lab.result.verified.v1` verified_at 11:30 | stopped, stopped_at 11:30, open list empty, level history [warning] |
| T6 | specimen rejected 10:00; new specimen received 12:30; now 13:00 | running from 12:30, level none, restart_count 1 |
| T7 | total, urgent target 7,200 s, ordered_at 08:00, final release 09:50 | warning raised at 09:36 (08:00 + 5,760 s = 80 %); stopped 09:50; level history [warning]; never breached |
| T8 | item with `tat_target_seconds` absent | no row |
| T9 | within_lab running item disappears from the view, no verified event | cancelled |
| T10 | total, target 14,400 s, ordered 08:00, verified 10:00, approved (left view) 10:30, final release 13:00 | running after 10:30 (`in_pending_view = false`), breached at 12:00, stopped 13:00 |
| T11 | `lab.result.verified.v1` arrives after the item was `cancelled` (late event) | stopped with verified_at (correction) |
| T12 | total clocks for items I1 (report family A) and I2 (family B); `reporting.report.released.v1` `final` with `order_item_ids = [I1]` | I1 stopped (`release_event`); I2 keeps running until a release containing I2 |
| T13 | total clock created when `v_pub_order_report_tat` has `registered_at` 07:58 and the earliest specimen `ordered_at` is 08:00 | `started_at` 07:58, `start_basis = registered_at` |
| T14 | as T13 but the view has no row for the order yet | `started_at` 08:00, `start_basis = specimen_ordered_at` |

## 10. Events and jobs

### 10.1 Produced

| Event | Exact trigger | Idempotency key |
|---|---|---|
| `quality.qc_run.rejected.v1` | commit of the transaction that sets a run's `outcome = 'rejected'` (early provisional rejection, full evaluation, stale close or `evaluateQcRunNow`) | `<qc_run_id>:rejected` |

`quality.qc_run.rejected.v1` is never emitted for `accepted_warning` (04 L23: 1-2s warning only) or `incomplete`.

### 10.2 Consumed (`services/worker/src/jobs/quality/consumers/<event>.ts`)

| Event | Handler | Idempotency / ordering |
|---|---|---|
| `instruments.qc.received.v1` | enqueue `quality.sync_qc_observations` (job key `qcsync:<tenant_id>`, run_at now + 5 s; an existing queued or running job absorbs it and keeps its `run_at` — `unsafe_dedupe`, §6.2). Payload not stored. | inbox; trigger only |
| `instruments.result.received.v1` | if `mapping_status = mapped` and `analyte_id` and an active plan exists for (instrument_id, analyte_id): upsert `quality.qc_activity` (`last_patient_result_at = greatest(…, received_at)`, `patient_results_since_last_qc + 1` when `received_at > last_qc_run_at`). **Never stores or logs `sample_barcode`, values or flags** (payload P3+P2, 03-IC §3.14). | inbox; counter is advisory (at-least-once may over-count by retries that already committed — inbox prevents that) |
| `lab.result.verified.v1` | insert `quality.verification_log` (`result_id, result_version_no, order_id, order_item_id, test_id, analyte_id, mode, verified_at`) `ON CONFLICT (tenant_id, result_id, result_version_no) DO NOTHING`. C9 reads neither `specimen_id` nor `verified_by_membership_id`, so their absence (03-IC §3.9 `if`/`then`, 08 A13 D-2, P-5) needs no handling; contract test with both fields absent and `mode = auto`; within_lab `tat_items` for (order_item_id, test_id) in `running`/`not_started`/`cancelled` → `stopped` with `stopped_at = verified_at` (earliest wins); total item → set `first_verified_at` if absent | inbox |
| `lab.specimen.status_changed.v1` | enqueue `quality.tat_refresh_order { order_id }` (job key `tat:<order_id>`, run_at now + 2 s) when `to_status ∈ {received, rejected, recollection_ordered, ordered}` | inbox; refresh reads current views, so stale `seq` is harmless |
| `reporting.report.released.v1` | `report_kind ∈ {final, partial}` with `order_item_ids` → those total items in `running` → `stopped` (`stopped_at = released_at`, `stop_source = release_event`); `final` without `order_item_ids` → all total items of `order_id`; else no-op — incl. `preliminary`, `amended`, `addendum` (08 R1) and any unknown value (`report_kind` is `x-extensible`, 08 R13; P-4: C9 stores no `report_kind`) | inbox |

All consumers: max 10 attempts, built-in backoff, dead letter (02-CV §7.5); duplicate-delivery and unknown-field tests mandatory (02-CV §11.4).

### 10.3 Tasks and crontab

| Task id | Trigger | Behaviour | Max attempts |
|---|---|---|---|
| `evt.quality.<event>` (5) | fan-out | §10.2 | 10 |
| `quality.sync_qc_observations` | cron `* * * * *` per_tenant + event trigger | §6.2 | 5 [CONV] |
| `quality.close_stale_runs` | cron `* * * * *` per_tenant | §7.3 step 7 | 5 |
| `quality.reprocess_pending_observations` | enqueued by map/plan/target changes | §6.4 | 5 |
| `quality.tat_sweep` | cron `* * * * *` per_tenant | §9.3 | 3 (next minute retries anyway) |
| `quality.tat_refresh_order` | enqueued by specimen consumer | §9.3 steps 1–4 for one order | 5 |
| `quality.purge_tat_items` | cron `40 2 * * *` [CONV] per_tenant | `DELETE FROM quality.tat_items t WHERE t.tenant_id = $t AND t.expires_at < now() AND NOT EXISTS (SELECT 1 FROM quality.tat_alert_events e WHERE e.tenant_id = t.tenant_id AND e.tat_item_id = t.id) AND NOT EXISTS (SELECT 1 FROM quality.tat_alert_acks a WHERE a.tenant_id = t.tenant_id AND a.tat_item_id = t.id)` as the system actor under `tat_items__delete__tenant` (08 A17 P-18(c)); rows with alert events or acks are kept (class A children, 05-SCHEMA §7) | 3 |

Worker manifest:

```ts
export const manifest: WorkerManifest = {
  module: 'quality',
  tasks: { 'quality.sync_qc_observations': syncQcObservations, 'quality.close_stale_runs': closeStaleRuns,
           'quality.reprocess_pending_observations': reprocessPending, 'quality.tat_sweep': tatSweep,
           'quality.tat_refresh_order': tatRefreshOrder, 'quality.purge_tat_items': purgeTatItems },
  subscriptions: {
    'instruments.qc.received.v1': onQcReceived, 'instruments.result.received.v1': onInstrumentResult,
    'lab.result.verified.v1': onResultVerified, 'lab.specimen.status_changed.v1': onSpecimenStatusChanged,
    'reporting.report.released.v1': onReportReleased,
  },
  crontab: [
    { identifier: 'quality.sync_qc_observations', schedule: '* * * * *', tenantScope: 'per_tenant' },
    { identifier: 'quality.close_stale_runs',     schedule: '* * * * *', tenantScope: 'per_tenant' },
    { identifier: 'quality.tat_sweep',            schedule: '* * * * *', tenantScope: 'per_tenant' },
    { identifier: 'quality.purge_tat_items',      schedule: '40 2 * * *', tenantScope: 'per_tenant' },
  ],
  maxAttempts: { 'quality.tat_sweep': 3, 'quality.sync_qc_observations': 5, 'quality.close_stale_runs': 5,
                 'quality.reprocess_pending_observations': 5, 'quality.tat_refresh_order': 5, 'quality.purge_tat_items': 3 },
};
```

All five subscriptions are listed for C9 in 03-IC §3 (01 §5.1 + A3), as the CI check requires (02-CV §7.4).

## 11. Ports

### 11.1 Implemented: `QualityPort` (03-IC §4.11, verbatim)

```ts
canAutoVerify(ctx: RequestContext, resultContext: ResultContext):
  Promise<{ decision: 'allow' | 'deny'; reasons: readonly AutoVerifyReason[]; ruleSetVersion?: string }>;
qcStatusFor(ctx: RequestContext, input: { instrumentId: Uuidv7; analyteId: Uuidv7; at: IsoUtc }):
  Promise<{ status: 'in_control' | 'warning' | 'out_of_control' | 'no_qc_data'; lastInControlRunAt?: IsoUtc; currentRunId?: Uuidv7; violatedRules?: readonly Code[] }>;
```

Behaviour: §8.4 and §7.8. Both run in `ctx.tx`, never open a transaction, read tenant from `ctx` only, throw only `common.validation_failed`/`common.internal` (02-CV §8.1). `canAutoVerify` writes decision rows; `qcStatusFor` is read-only. Contract suite `runQualityPortContract` (03-IC §4.11 cases 1–7) plus C9 additions: (8) open rejected run masks a newer accepted run (S5); (9) staleness → `no_qc_data` (S8); (10) shadow version never changes the returned decision (A16); (11) `allow` never returned when any reason applies (property test over random contexts); (12) other tenant's plan invisible → `no_qc_data`.

**Phase stub (08 R9; 02-CV §8.2 exception; 08 A17 P-20).** Until the C9 module exists, staging/production resolve `QualityPort` to the C0 phase stub listed in `services/api/src/core/ports/phase-stubs.ts`: `canAutoVerify` → `deny` [`feature_disabled`], `qcStatusFor` → `no_qc_data`; it never allows, returns no data, has no seeding, passes the `phase1Stub` subset of the contract suite and is counted by `lims_core_phase_stub_ports_active`. The first C9 PR that creates `services/api/src/modules/quality/` (**T-01**) removes `QualityPort` from `phase-stubs.ts` in a paired C0-0D PR (AC-0D-6.3 unchanged; no C0 manifest flag). In the same PR C9 registers its own `QualityPort.impl`, which returns exactly the stub results for both methods and passes the `phase1Stub` contract subset. T-13 then replaces `qcStatusFor` and T-16 replaces `canAutoVerify`, each adding that method's full contract cases. C5's call semantics (CR-C9-004, accepted): with `LIMS_LAB_AUTOVERIFY_HOOK_ENABLED=true` C5 calls `canAutoVerify` for every instrument-origin save (not on hold, no unit mismatch) and auto-verifies only on `allow`.

### 11.2 Consumed

| Port | Methods | Notes |
|---|---|---|
| `IdentityPort` | `assertRole` (every handler), `getActor` (the caller only, e.g. the four-eyes check in #43), `getTenantSettings(ctx, { keys })` (`westgardMode`, `autoVerificationEnabled`, `timezone`, `retentionYears`) | settings cached per request (≤ 2 ms — 03-IC §4.6). `timezone` is always `Asia/Kathmandu` in v1 (08 A13 P-15) |
| `ctx.core` (C0) | `memberships.list({ membershipIds, activeOnly: false })`, `user` | other staff members' display names (§5.10; 08 A17 P-17, D-47) |
| `CatalogPort` | `getTest` (analyte unit/decimals/resultType/code/name; `tatTargetSegment`), `mapInstrumentCode` (outbound, plan creation warning only) | in-process cache keyed `(tenant, testId, catalogRevision)`; C9 does not consume `catalog.changed.v1` (not listed in 01 §5.1), so the cache key includes the revision C3 returns, and entries expire after 10 min [CONV] |

C9 does not call `LabPort` (holds go by event) and not `NotificationPort` (D-TAT-1).

## 12. Configuration

### 12.1 Per tenant (`quality.settings`, edited via #52)

| Key | Type / range | Default | Meaning |
|---|---|---|---|
| `tat_alerts_enabled` | bool | true | sweep on/off |
| `tat_warn_pct` | int 50..99 | 80 [CONV] | warning threshold |
| `tat_escalate_pct` | int 101..1000 | 150 [CONV] | escalation threshold |
| `tat_orphan_close_hours` | int 1..720 | 72 [CONV] | §9.3 step 5 |
| `target_min_points` | int 2..500 | 20 [CONV] (practice UNVERIFIED, 01 §2.5) | establish-from-data minimum |
| `sim_min_days` | int 1..90 | 7 [CONV] | activation minimum |
| `sim_min_decisions` | int 10..100000 | 100 [CONV] | activation minimum |
| `reprocess_window_days` | int 1..30 | 7 [CONV] | §6.4 |
| `default_plan_params` | `QcPlanParams` minus required fields | §5.3 defaults | pre-fill for new plans |

**Bootstrap (08 A17 D-56, P-22).** `settings.service.ensure(tx)` runs in every C9 path that reads settings (HTTP handlers #51/#52 and the set-up/target/autoverify services, the sync, TAT and stale-run tasks). It executes `INSERT INTO quality.settings (…defaults…, activated_at) VALUES (…, now()) ON CONFLICT (tenant_id) DO NOTHING` and then reads the row, so the first ensure for a tenant fixes `activated_at` (a tenant created after C9 ships gets its first-use time). The sync task also ensures `quality.sync_state` with `qc_cursor_at = activated_at − 400 days` (`ON CONFLICT (tenant_id) DO NOTHING`). A read that finds no row uses the defaults above. There is no tenant-provisioning hook. The `QualityPort` methods do not read `quality.settings` and do not call `ensure`.

Read from C2 (`IdentityPort.getTenantSettings`), not editable in C9: `westgardMode` (default `classic`, D-QC-1), `autoVerificationEnabled` (default false), `timezone`, `retentionYears`.

### 12.2 Global env (`config.ts`)

| Env | Default | Purpose |
|---|---|---|
| `LIMS_QUALITY_ENABLED` | `false` | Phase-2 switch: routes return `common.feature_disabled`, crons no-op, port still answers (phase-stub-equivalent deny/no_qc_data) |
| `LIMS_QUALITY_SYNC_BATCH` | 500 [CONV] | rows per sync batch |
| `LIMS_QUALITY_SYNC_OVERLAP_SECONDS` | 600 [CONV] | re-scan window |
| `LIMS_QUALITY_SYNC_DEBOUNCE_SECONDS` | 5 [CONV] | event-trigger delay |
| `LIMS_QUALITY_SYNC_TIME_BUDGET_SECONDS` | 25 [CONV] | pages read per job run before a continuation job is enqueued (§6.2 step 6) |
| `LIMS_QUALITY_RULE_CACHE_MAX` | 200 [CONV] | compiled rule-set versions per process |
| `LIMS_QUALITY_LJ_MAX_POINTS` | 2000 [CONV] | chart cap |

## 13. Performance targets (inputs: 04 §14 ASSUMPTION rows; N = 10 labs; peak hour 25 %)

| Path | Arithmetic | Target |
|---|---|---|
| QC observations | not in 04 → ASSUMPTION ≤ 2,000/day/lab (e.g. 150 plans × N=2 × 3 runs ≈ 900, ×2 headroom); peak 500/h/lab; ×10 = 5,000/h ≈ 1.4/s | sync + evaluation ≥ 20 obs/s sustained [CONV] (14× peak); p95 import→outcome ≤ 15 s with event trigger |
| `canAutoVerify` | results 15,000–25,000/day/lab (04 §14) → peak 6,250/h/lab ≈ 1.74/s; ×10 ≈ 17.4/s | p95 ≤ 10 ms in-process (03-IC §4.11) incl. `qcStatusFor` + ≤ 2 inserts |
| `qcStatusFor` | ≤ 20 run rows via index | p95 ≤ 10 ms (03-IC §4.11) |
| Decision rows | live ≤ 25,000/day/lab (+ ≤ 25,000 shadow while simulating); ×10 = 250k–500k/day; ≈ 400 B/row → 100–200 MB/day ≈ 36–73 GB/year at N=10 vs ≈ 475 GB/year total storage in 04 §14 | accepted; retention by tenant `retentionYears`; `decided_at` leads time indexes for future partitioning (04 D10) |
| TAT sweep | order items 5,000/day/lab (04 §14 "billable orders"); open set ≤ ~1 day ≈ 5,000–10,000 rows/lab | p95 ≤ 2 s per tenant per sweep [CONV]; whole fleet ≤ 20 s/min |
| Status board / run list / LJ (≤ 2,000 points) | — | p95 ≤ 300 ms [CONV] |
| API rate | 6–12 req/s/lab (04 §14) for all modules | general tier covers C9 screens (polling every 15 s per open chart) |

Load test: C0 seed generator at 1× and 10× (05-DoD §3.5), with ≥ 50 plans × 90 days of synthetic QC per tenant.

## 14. Observability

Logs: ids and codes only (02-CV §9). Never logged: values of patient results, `sample_barcode`, decision `inputs`. QC values (P0) may appear in debug logs only in non-production.

| Metric | Type | Labels |
|---|---|---|
| `lims_quality_qc_observations_total` | counter | `status` (§6.3 statuses + `import_error`, §6.2 step 3) |
| `lims_quality_qc_sync_last_success_timestamp_seconds` | gauge | `tenant_id` (set at the end of every successful sync run) |
| `lims_quality_qc_rejected_without_action_oldest_age_seconds` | gauge | `tenant_id` (age of the oldest evaluated rejected run with no corrective action; set by `close_stale_runs`) |
| `lims_quality_qc_runs_total` | counter | `outcome`, `rule_mode`, `n` |
| `lims_quality_qc_rule_hits_total` | counter | `rule` |
| `lims_quality_qc_eval_lag_seconds` | histogram | — (C5 `created_at` → evaluation) |
| `lims_quality_qc_open_rejected_runs` | gauge | `tenant_id` |
| `lims_quality_qc_overdue_pairs` | gauge | `tenant_id` |
| `lims_quality_unassigned_observations` | gauge | `status`, `tenant_id` |
| `lims_quality_port_duration_seconds` | histogram | `method` |
| `lims_quality_autoverify_decisions_total` | counter | `mode`, `decision`, `reason` (one increment per reason of the decision; `reason="none"` once for a decision with no reasons) |
| `lims_quality_autoverify_short_circuit_total` | counter | `reason` (feature_disabled/rule_missing with no version) |
| `lims_quality_tat_sweep_duration_seconds` | histogram | — |
| `lims_quality_tat_alerts_total` | counter | `level`, `segment` |
| `lims_quality_tat_open_alerts` | gauge | `level`, `tenant_id` |
| `lims_quality_tat_alert_lag_seconds` | histogram | — (threshold crossing → row) |

#### Alert rules for C1 (08 A13 P-14)

C9 keeps the rule file in its own path, `services/worker/src/jobs/quality/ops/quality.rules.yml` [CONV], and C1 wires it into `infra/` through **CR-C9-008** (§16). C1 adds only `team` and `runbook_url`. All thresholds and durations are [CONV] unless noted.

| Alert | expr | for | severity | route (C1 receiver) |
|---|---|---|---|---|
| `QualityRejectedRunWithoutAction` | `max by (tenant_id) (lims_quality_qc_rejected_without_action_oldest_age_seconds) > 14400` | 5m | warn | `ops-digest-email` |
| `QualityConsumerDeadLetter` | `increase(lims_core_dead_letters_total{task=~"(evt\\.)?quality\\..*"}[5m]) > 0` | 0m | page | `oncall-email` |
| `QualityQcSyncStalled` | `time() - max by (tenant_id) (lims_quality_qc_sync_last_success_timestamp_seconds) > 300` | 5m | page | `oncall-email` |
| `QualityQcImportError` | `increase(lims_quality_qc_observations_total{status="import_error"}[15m]) > 0` | 0m | warn | `ops-digest-email` |
| `QualityPortSlow` | `histogram_quantile(0.95, sum by (le, method) (rate(lims_quality_port_duration_seconds_bucket[5m]))) > 0.01` (10 ms budget, 03-IC §4.11) | 15m | warn | `ops-digest-email` |
| `QualityTatSweepSlow` | `histogram_quantile(0.95, sum by (le) (rate(lims_quality_tat_sweep_duration_seconds_bucket[5m]))) > 10` | 15m | warn | `ops-digest-email` |
| `QualityAutoverifyAllowWithReasons` | `increase(lims_quality_autoverify_decisions_total{decision="allow", reason!="none"}[5m]) > 0` (invariant breach; must be 0 — the `reason` label is `none` on a reason-free row) | 0m | page | `oncall-email` |

#### CI jobs for C0-0A (08 A13 P-14)

None: C9 has no gate script of its own; its tests run in the standard module jobs.

#### Access log (08 A13 P-3; 08 A17 D-53)

Every `ctx.audit.access` call is listed in §5.6 (operation → `action` → `entityType`): `autoverify.activate`, `autoverify.retire`, `autoverify_decision.view`, `autoverify_simulation.view`. All four are in 03-IC §13.1 / 08 §4.4 / the C0 `audit.g_cs_access_actions` seed; no other action is used by C9. Data changes: C0 audit triggers on every C9 table (04 D11).

## 15. Test strategy

| Layer | What | Fakes |
|---|---|---|
| Unit | `westgard.ts` all §7.9 vectors + extra cases; `assembly.ts` (window, composition full, early rejection, late member; AS1–AS4 of §7.3); `qc-status.ts` S1–S8; `target-stats.ts` golden (synthetic 20 values pinning `S1`, `S2`, mean, variance, 15-digit sd and stored rounding — §7.6); `autoverify-dsl.ts` schema errors; `autoverify-eval.ts` A1–A16 + property test "no reason ⇔ allow"; `tat-clock.ts` T1–T14; state machines (every allowed + a forbidden transition) | none |
| Integration | services + repos + RLS on migrated PG17 with tenants A/B; sync from a seeded `lab.qc_results` (incl. the §6.2 cases: 1,200 rows in one `created_at` second, poison row, overlapping jobs); event publish in same tx (rollback test); close-out guard incl. the `run_at > R.run_at + run_window_minutes` rule; `quality.purge_tat_items` deletes only expired rows without alert children | IdentityPort, CatalogPort fakes from `@lims/fakes` |
| Contract — HTTP | every operation validated against `quality.yaml`; one test per `x-error-codes` entry | — |
| Contract — port | `runQualityPortContract` (03-IC §4.11 cases 1–7 + C9 cases 8–12) on the real impl | — |
| Contract — events | `quality.qc_run.rejected.v1` payload validates (incl. 03-IC example); each consumer: 03-IC example, unknown extra fields, duplicate `event_id`; specimen consumer stale seq | — |
| Probes | 07-SECURITY §5 | — |
| Web | component tests with MSW 3.0.3 from the spec; keyboard-only flows: record corrective action, acknowledge TAT alert, rule editor | Prism/MSW |
| E2E (nightly) | synthetic QC events → run rejected → C5 hold (real C5 or LabPort fake) → corrective action → accepted rerun → close; simulation → activate (two users) → C5 result auto-verified; TAT breach visible | compose stack |

## 16. Change requests raised

> Status per `program/08-CR-REGISTER.md` (2026-11-06). CR texts below are kept as history.

| CR | Status |
|---|---|
| CR-C9-001 | ACCEPTED in 08 |
| CR-C9-002 | ACCEPTED in 08 |
| CR-C9-003 | ACCEPTED in 08 |
| CR-C9-004 | ACCEPTED in 08 |
| CR-C9-005 | ACCEPTED in 08 |
| CR-C9-006 | ACCEPTED-MODIFIED in 08 — Primary; columns merged with CR-C12-005 (§4.9). |
| CR-C9-007 | ACCEPTED in 08 |
| CR-C9-008 | RAISED 2026-11-06 (08 A13 P-14) — C1 wires `services/worker/src/jobs/quality/ops/quality.rules.yml` (§14 "Alert rules for C1"); awaiting 08 register row |
| Review fix pass | Review fix pass 2026-11-06 — review/C9-quality-engine.md + 08 Addendum A17 (plus A13 rules P-1…P-15 that apply to you) applied (A13: P-3, P-5/D-2, P-6, P-8, P-14, P-15; A16.1; A17: P-16, P-17, P-18(c), P-20, P-21, P-22; D-52, D-53, D-54, D-55, D-56, D-58, D-59, D-60; D-57 wording in 01-PRD §10). |

**08 Addenda applied (08 A25 P-60: one row per addendum A1–A29; final check 2026-11-06)**

| Addendum | Status for C9 |
|---|---|
| A1 | not applicable |
| A2 | applied 2026-11-06 — A2.4 (SCH) |
| A3 | not applicable |
| A4 | not applicable |
| A5 | not applicable |
| A6 | not applicable |
| A7 | not applicable |
| A8 | not applicable |
| A9 | not applicable |
| A10 | not applicable |
| A11 | not applicable |
| A12 | not applicable |
| A13 | applied 2026-11-06 — P-1, P-3, P-4, P-5, P-6, P-8, P-14, P-15, D-2 (PRD, TRD, PLAN, SEC) |
| A14 | not applicable |
| A15 | not applicable |
| A16 | applied 2026-11-06 — A16.1 (TRD, SCH, SEC) |
| A17 | applied 2026-11-06 — P-16, P-17, P-18, P-20, P-21, P-22, D-47, D-52, D-53, D-54, D-55, D-56, D-57, D-58, D-59, D-60, D-65 (PRD, TRD, AF, SCH, PLAN, SEC) |
| A18 | not applicable |
| A19 | not applicable (A19 P-40 cites this chunk's existing port idempotency keys as already compliant; D-106/D-109/D-110/D-123 change other chunks or program docs) |
| A20 | not applicable |
| A21 | not applicable |
| A22 | not applicable |
| A23 | not applicable |
| A24 | not applicable |
| A25 | not applicable |
| A26 | not applicable (A26.3 changes 03-IC / 01-CM only) |
| A27 | not applicable |
| A28 | not applicable |
| A29 | not applicable |


Template per `program/04-CHANGE-REQUESTS.md` §2. All designed as if accepted.

### CR-C9-001: Permission codes
```
Title: CR-C9-001: quality permission codes for run review, auto-verify read, TAT alerts, settings
From chunk: C9            To owner: C0-0C (contracts/permissions.yaml)
Type: api                 Blocking? no — IdentityPort fake accepts configured codes (T-02)
Problem: US-07 (corrective action/close/acknowledge by technologists), US-11/13 (technologists must see why a result was
  not auto-verified without being able to edit rules), US-14 (TAT alerts), §12.1 settings. 03-IC §11 has only
  quality.qc_run.read, quality.qc.manage (lab_manager only), quality.autoverify.manage (privileged).
Proposed (03-IC §11, phase: 2):
  - { code: quality.qc_run.review,   privileged: false, roles: [lab_technologist, lab_manager, pathologist], phase: 2 }
  - { code: quality.autoverify.read, privileged: false, roles: [lab_technologist, pathologist, lab_manager], phase: 2 }
  - { code: quality.tat_alert.read,  privileged: false, roles: [lab_technologist, pathologist, lab_manager], phase: 2 }
  - { code: quality.tat_alert.ack,   privileged: false, roles: [lab_technologist, pathologist, lab_manager], phase: 2 }
  - { code: quality.config.manage,   privileged: false, roles: [lab_manager], phase: 2 }
Backward compatible? yes (additive)
Tenant/security impact: none beyond new grants; autoverify.read exposes decision inputs (P3) to lab roles that already
  hold lab.result.read.
Alternatives considered: reuse quality.qc.manage for review (rejected: technologists must not edit targets).
Tests: permission registry equality; probes per endpoint with each role.
```

### CR-C9-002: Error codes
```
Title: CR-C9-002: quality error codes
From chunk: C9            To owner: C0-0C (contracts/errors.yaml)
Type: api                 Blocking? no
Proposed:
- { code: quality.code_duplicate,          http: 409, owner: C9, title: "Already exists", meaning: "Material/level/lot code, control-ID map or QC plan for the pair already exists" }
- { code: quality.rerun_required,          http: 409, owner: C9, title: "Accepted QC rerun required", meaning: "Rejected run can be closed only after a later accepted run (01 §2.5)" }
- { code: quality.rule_set_invalid,        http: 422, owner: C9, title: "Auto-verification rules invalid", meaning: "DSL validation errors in errors[]" }
- { code: quality.rule_set_invalid_transition, http: 409, owner: C9, title: "Rule set version cannot change state", meaning: "03-APP-FLOW §2.3" }
- { code: quality.simulation_incomplete,   http: 409, owner: C9, title: "Simulation not long enough", meaning: "sim_min_days / sim_min_decisions not met" }
- { code: quality.self_activation_forbidden, http: 403, owner: C9, title: "Another person must activate", meaning: "Four-eyes activation of auto-verification rules" }
- { code: quality.insufficient_qc_data,    http: 422, owner: C9, title: "Not enough QC data", meaning: "Fewer observations than target_min_points" }
Backward compatible? yes. Tests: one HTTP test per code.
```

### CR-C9-003: `QualityPort` reason `qc_warning` + documented semantics
```
Title: CR-C9-003: AutoVerifyReason += 'qc_warning'; qcStatusFor semantics and extra contract cases
From chunk: C9            To owner: C0-0C (contracts/ports/QualityPort.ts, fake, contract suite)
Type: port                Blocking? no — pre-merge C9 emits qc_out_of_control for warning denials
Problem: A rule may refuse auto-verification when the governing QC run only had a 1-2s warning (or was incomplete);
  no reason code expresses that, and reporting it as qc_out_of_control is false (glossary: a warning is not out of control).
Proposed: type AutoVerifyReason = … | 'qc_warning'. Document in JSDoc: qcStatusFor returns out_of_control while a rejected
  run is not closed even if a newer run is accepted; returns no_qc_data when the last in-control run is older than the
  plan's validity; violatedRules may contain 'incomplete_run'. Add contract cases 8–12 (02-TRD §11.1). Fake: programmable.
Backward compatible? yes (union extended; C5 treats every reason as deny and stores reasons as text).
Tests: contract cases; C5 stores the new code without validation errors.
```

### CR-C9-004: C5 calls `canAutoVerify` independent of the tenant switch (shadow simulation)
```
Title: CR-C9-004: C5 asks QualityPort for every instrument-origin save when the hook flag is on
From chunk: C9            To owner: C5 (behaviour) + C0-0C (QualityPort JSDoc)
Type: port (semantics of the caller)   Blocking? no — degraded simulation until merged (§8.3)
Problem: US-11 needs shadow decisions before a tenant enables auto-verification; C5 only calls canAutoVerify when
  autoVerificationEnabled is true (C5 02-TRD §6.2).
Proposed: when LIMS_LAB_AUTOVERIFY_HOOK_ENABLED=true, C5 calls canAutoVerify on every R2/R3 with origin=instrument,
  on_hold=false, unit_mismatch=false, in the save transaction; performs R4 mode auto only on decision=allow. C9 keeps the
  invariant "allow never when tenant disabled" (03-IC §4.11).
Backward compatible? yes for C9's fake/stub (always deny). C5 adds ≤ 10 ms per instrument save (03-IC §4.11 budget);
  C5 confirms this fits its ingestInstrumentResult ≤ 50 ms budget (03-IC §4.5).
Tenant/security impact: none (same tenant transaction).
Tests: C5 integration — disabled tenant: port called, result not auto-verified; enabled + allow: R4 auto.
```

### CR-C9-005: `lab.v_pub_qc_result.created_at` + index
```
Title: CR-C9-005: add created_at to lab.v_pub_qc_result and index lab.qc_results (tenant_id, created_at, id)
From chunk: C9            To owner: C0-0B (C5 must agree)
Type: schema              Blocking? no — fallback scan by received_at with 24 h overlap (§6.2)
Problem: C9 imports QC incrementally (§6.2). received_at is not insert order (C5's consumer can commit minutes after
  received_at during backlog/retries), so a received_at cursor can skip rows unless the overlap is large; no index
  supports a per-tenant time-ordered scan (only (tenant_id, instrument_id, analyte_id, instrument_result_time)).
Proposed DDL:
  CREATE OR REPLACE VIEW lab.v_pub_qc_result WITH (security_invoker = true) AS
  SELECT <existing columns>, q.created_at FROM lab.qc_results q;   -- column appended at the end
  CREATE INDEX CONCURRENTLY qc_results__tenant_id_created_at__idx ON lab.qc_results (tenant_id, created_at, id);
Backward compatible? yes (column appended; C8 unaffected). PHI: P0.
Tests: view column contract; EXPLAIN uses the index for the sync query.
```

### CR-C9-006: `instruments.v_pub_instrument_directory`
```
Title: CR-C9-006: published instrument directory view for labels
From chunk: C9            To owner: C0-0B (C7 must agree)
Type: schema              Blocking? no — labels fall back to the C7 HTTP API in the BFF (users with
                          instruments.instrument.read) or to a short instrument id
Problem: QC plans, runs, status board and LJ charts must name the instrument for pathologists who lack
  instruments.instrument.read; C9 may not read instruments tables (01 §5 R1).
Proposed: CREATE VIEW instruments.v_pub_instrument_directory WITH (security_invoker = true) AS
  SELECT tenant_id, id AS instrument_id, centre_id, instrument_code, display_name, vendor, model, state FROM instruments.instruments;
  GRANT SELECT … TO lims_app. Consumers: C9 (C12 may also use it). PHI: P0.
Backward compatible? yes (new view).
Tests: column contract; cross-tenant probe.
```

### CR-C9-007: UI kit `ControlChart` (Levey-Jennings)
```
Title: CR-C9-007: @lims/ui ControlChart component
From chunk: C9            To owner: C0-0D
Type: ui-kit              Blocking? task T-21 only (C9 renders a DataTable of points until merged)
Problem: US-08 needs mean/±1/2/3SD reference lines that step when targets change, per-point status markers with
  text/shape (not colour only), multiple series (z view), rule labels and a hidden data table. TimeSeriesChart
  supports only one referenceBand.
Proposed props:
  interface ControlChartProps { title: string; unit?: string; mode: 'value' | 'z';
    series: readonly { id: string; label: string; points: readonly { id: string; at: IsoUtc; value: DecimalString;
      status: 'accepted' | 'warning' | 'rejected' | 'excluded' | 'unevaluated' | 'collecting'; annotations?: readonly string[] }[] }[];
    limits: readonly { from: IsoUtc; to?: IsoUtc; mean: DecimalString; sd: DecimalString }[];   // ignored in 'z' mode (0, ±1, ±2, ±3)
    onPointSelect?: (pointId: string) => void; height?: number }
  Marker shapes: accepted ●, warning ▲, rejected ✕ (+ rule text), excluded ○, unevaluated ◇, collecting ◌; keyboard:
  arrow keys move between points, Enter selects; visually hidden data table (02-CV §14).
Backward compatible? yes (new component).
```

### CR-C9-008: C9 alert rules (08 A13 P-14)
- From C9 → C1. Type: alert. Blocking: no.
- Proposed: C1 includes `services/worker/src/jobs/quality/ops/quality.rules.yml` (the seven rules of §14 "Alert rules for C1", thresholds verbatim) in its Prometheus rule set, adding `team` and `runbook_url` (`infra/runbooks/quality.md#<alert>`). Replaces any C9 row of C1 02-TRD §11.3 "Imported rules".

Other foreseen CRs (not raised now) are listed in `06-IMPLEMENTATION-PLAN.md` §6.
