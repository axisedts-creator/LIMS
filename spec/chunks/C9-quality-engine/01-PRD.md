# C9 Quality Engine — 01 Product Requirements (PRD)

Status: DECISION, 2026-11-06. Chunk C9, **Phase 2** (04 §12: "Auto-verification engine; QC LJ charts + Westgard engine; TAT targets/alerts"). Module `quality` (Postgres schema, API module `services/api/src/modules/quality`, worker jobs `services/worker/src/jobs/quality`, web feature `apps/web/src/{app/(staff),features}/quality`).
Precedence: `research/00` > `research/04` > `program/03-INTERFACE-CATALOG.md` (03-IC) > `program/01`/`02` > this file. Contract gaps are raised as CRs in `02-TRD.md` §16 and designed as if accepted (marked **(CR-C9-00n)**).

Labels: **VERIFIED** (named source opened), **DECISION** (engineering choice made here; change by CR), **[CONV]** (value chosen here with no external fact behind it), **ASSUMPTION** (planning number to validate), **UNVERIFIED**, **BLOCKED (B#)** as in 04.

---

## 1. Purpose

C9 is the lab's statistical quality-control and release-automation layer. It does three jobs:

1. **QC engine.** It keeps the QC set-up: control materials, levels, lots, target mean/SD per instrument × analyte × lot, and the QC plan per instrument × analyte (N controls per run). It takes every QC observation captured by C5, evaluates the Westgard multirule exactly as 04 L23 defines it, accepts or rejects the QC run, logs corrective actions, and draws Levey-Jennings charts. A rejected run emits `quality.qc_run.rejected.v1`, and C5 then holds patient results since the last good QC (`LabPort.holdResultsSince`).
2. **Auto-verification engine.** It answers `QualityPort.canAutoVerify` for C5 from a rule set stored as data, after a simulation (shadow) period, and it audits every decision. Auto-verification replaces only the technologist's first verification. Pathologist approval is never automated.
3. **TAT alerts.** It watches pending tests against the TAT targets C3 stores as data, raises warning/breach/escalation alerts in-app, and lets staff acknowledge them.

C9 owns `QualityPort` (03-IC §4.11) and the event `quality.qc_run.rejected.v1` (03-IC §3.21).

## 2. Users and roles

Role codes and permission codes are from 03-IC §11. Codes marked **(CR)** are requested in CR-C9-001.

| Role (default) | What they do in C9 | Permissions |
|---|---|---|
| `lab_technologist` | Sees QC status, runs, LJ charts; reviews runs (evaluate now, acknowledge warnings, record corrective actions, close a rejected run after an accepted rerun); sees why a result was or was not auto-verified; sees and acknowledges TAT alerts | `quality.qc_run.read`, `quality.qc_run.review` (CR), `quality.autoverify.read` (CR), `quality.tat_alert.read` (CR), `quality.tat_alert.ack` (CR) |
| `lab_manager` | Everything above, plus QC set-up (materials, levels, lots, control-ID maps, plans, targets incl. "establish from data"), observation exclusion, auto-verify rule sets (draft, simulate, activate), C9 settings and coded sets | above + `quality.qc.manage`, `quality.autoverify.manage` (privileged), `quality.config.manage` (CR) |
| `pathologist` | Reads QC; authors, simulates and activates (four-eyes) auto-verify rule sets; reviews runs; reads TAT alerts | `quality.qc_run.read`, `quality.qc_run.review` (CR), `quality.autoverify.read` (CR), `quality.autoverify.manage` (privileged), `quality.tat_alert.read` (CR), `quality.tat_alert.ack` (CR) |
| `tenant_admin` | Turns auto-verification on/off and picks the Westgard mode in C2's tenant settings (not a C9 screen) | `identity.settings.manage` (C2) |
| C5 (in-process caller) | Calls `QualityPort.canAutoVerify` / `qcStatusFor` inside its own transaction | none checked by the port (03-IC §4.11; the calling C5 path has already authorised its own action) |
| System actor (`quality` worker) | Event consumers, QC sync, run assembly, TAT sweep | declared in the `quality` worker manifest (02-CV §2.3) |

## 3. Problems this chunk solves

1. The client asked for a "QC module: real-time LJ curve, Westgard rules, of each LIS analyser" (00 §3 item 16). C5 only captures QC values in Phase 1 (04 §12); nothing evaluates them.
2. When QC fails, patient results produced since the last good QC must not be released unchecked (01 §2.5). No component decides "failed" today.
3. Accreditation assessors ask for a corrective-action log after QC failures (01 §2.5).
4. Every result is manually first-verified in Phase 1 (04 R2). Labs want normal, QC-covered, non-critical results to pass the first verification step automatically, but only under rules the lab has reviewed (01 §2.2).
5. TAT targets exist as catalog data (C3), but nobody is told when a test is running late (00 §3 item 15 "TAT management"; 01 §2.7).

## 4. Scope

### 4.1 In scope (mapped to client baseline)

| # | Capability | Baseline item(s) | Notes |
|---|---|---|---|
| IS-01 | Control materials, levels, lots (lot number, expiry) | 00 §3 item 16 | glossary F "Control material", "Lot" |
| IS-02 | Control-ID maps: instrument's raw control id (+ lot) → C9 lot/level | 00 §3 item 16 ("of each LIS analyser") | how a driver marks QC is model-specific (B2) |
| IS-03 | QC plan per instrument × analyte: N controls per run (2, 3 or 4), level composition, rule options | 04 L23 | N determines the rule set |
| IS-04 | Target mean/SD per instrument × analyte × lot, versioned; source `manufacturer` or `established` (computed from the lab's own in-control data) | 00 §3 item 16; 01 §2.5 | "≥20 runs" minimum is UNVERIFIED (01 §2.5) → configurable default |
| IS-05 | QC observation import from C5's captured QC (`lab.v_pub_qc_result`), triggered by `instruments.qc.received.v1` and a one-minute sweep | 04 §12 (C5 captures, C9 evaluates) | single ingestion path (02-TRD §6.1) |
| IS-06 | Run assembly and Westgard multirule evaluation (1-2s warning; 1-3s, 2-2s, R-4s, 4-1s, 10x / N=3 and N=4 variants; classic vs modern per lab) | 00 §3 item 16; 04 L23 | algorithm in 02-TRD §7, test vectors in 02-TRD §7.9 |
| IS-07 | Run outcome, `quality.qc_run.rejected.v1` → C5 hold | 01 §2.5; 03-IC §3.21 | |
| IS-08 | Corrective-action log and close-out of rejected runs | 01 §2.5 | |
| IS-09 | Levey-Jennings charts per instrument × analyte × level × lot, near real-time (15-s refresh) | 00 §3 item 16 | needs UI-kit component (CR-C9-007) |
| IS-10 | QC status board (current status per instrument × analyte, overdue QC, patient results since last QC) | 00 §3 item 16 | |
| IS-11 | `QualityPort` implementation (`canAutoVerify`, `qcStatusFor`) | 04 R2; 03-IC §4.11 | |
| IS-12 | Auto-verify rule set as data (versioned DSL), shadow simulation, four-eyes activation, decision audit | 04 R2; 01 §2.2 | |
| IS-13 | TAT alerts: warning / breached / escalated, acknowledgement, alert board | 00 §3 item 15; 01 §2.7 | targets from C3 data |
| IS-14 | `quality.v_pub_qc_summary` for C8 | 03-IC §6.7 | |
| IS-15 | In-app help + user-manual pages per screen | 01 §2 training note; 05-DoD §3.8 | |

### 4.2 Out of scope

| Item | Where it lives / why |
|---|---|
| QC value **capture** (instrument and manual entry), QC holds on results, hold release | C5 (`lab.qc_results`, `LabPort.holdResultsSince`, `releaseQcHold`) |
| Parsing QC records from analysers | C7 (driver decides what is QC — 01 §2.5) |
| TAT **measurement reports** (median, 90th percentile, % within target) | C8 (from C5/C6 published views) |
| TAT target **data entry** | C3 (`catalog.tat_targets`) |
| Auto-**approval** (replacing the pathologist) | not offered (DECISION D-AV-1, §8) |
| Re-asking `canAutoVerify` after QC later turns good | CR candidate (06 §6); v1 asks once, when C5 saves the value |
| SMS/WhatsApp/email TAT or QC alerts | `NotificationPort` is C6's and has no QC/TAT purpose; C9 is not a listed consumer (01 §5.1). In-app only (DECISION). CR candidate (06 §6). |
| Calibration tracking, reagent lots | C12 (inventory) |
| Peer-group / inter-lab QC comparison, Sigma metrics, QC design tools | not requested in 00 |
| Microbiology QC (organism QC strains) | C10 (Phase 2); not requested in 00 |

## 5. User stories and acceptance criteria

Numbering: `AC-<story>.<n>`. Every AC becomes an automated test (05-DoD §2). Synthetic data only. Unless stated, the QC examples use mean 100.0 and SD 2.0, so a value of `100 + 2z` sits at z SD.

### US-01 Control materials, levels and lots
- **AC-01.1** Given a `lab_manager`, When they create material `MCS-SYN` with levels `1` and `2`, Then the material and two levels exist with `is_active = true`, and a second material with code `MCS-SYN` in the same tenant returns `409 quality.code_duplicate` (CR-C9-002).
- **AC-01.2** Given level `1`, When a lot `LOT-SYN-01` with `expires_on = 2027-03-31` is created, Then it is listed under that level. Creating it with `expires_on` earlier than today (tenant timezone) returns `422 quality.lot_expired`.
- **AC-01.3** Given a `lab_technologist`, When they call any create/update set-up endpoint, Then `403 auth.forbidden`.
- **AC-01.4** Given a material referenced by any observation, When it is deactivated, Then it remains readable and charts still render its points (02-CV §5.2 class M).

### US-02 Control-ID maps
- **AC-02.1** Given instrument I1 sends `control_id_raw = "QC-L2"`, `control_lot_raw = "LOT-SYN-01"`, When a map `(I1, "QC-L2", "LOT-SYN-01") → lot L2/LOT-SYN-01` exists, Then the imported observation is assigned that lot and level.
- **AC-02.2** Given only a wildcard map `(I1, "QC-L2", any lot) → lot L2/LOT-SYN-01` and an exact map for `LOT-SYN-02`, When an observation with lot raw `LOT-SYN-02` arrives, Then the exact map wins.
- **AC-02.3** Given no map, Then the observation is stored with status `unmapped_control`, appears in the "Unassigned QC" queue, and is not evaluated.
- **AC-02.4** Given an `unmapped_control` observation newer than the pair's latest evaluated run, When the missing map is created, Then a re-process job assigns it within 2 minutes.
- **AC-02.5** Given a map to an `instrument_id` that does not exist in the tenant, Then `400 common.validation_failed` (`/instrument_id`).

### US-03 QC plans (N per run)
- **AC-03.1** Given instrument I1 and analyte K (test BMP), When a plan is created with `controls_per_run = 2` and composition `{L1: 1, L2: 1}`, Then the plan's rule set is `1-2s (warning); 1-3s, 2-2s, R-4s, 4-1s, 10x` (04 L23, N=2).
- **AC-03.2** Given `controls_per_run = 3` with three levels, Then the rule set is `1-2s (warning); 1-3s, 2of3-2s, R-4s, 3-1s, 6x` (default mean rule 6x; 9x selectable).
- **AC-03.3** Given `controls_per_run = 4` with `{L1: 2, L2: 2}`, Then the rule set is the N=2/4 set with mean rule 10x by default and 8x/12x selectable.
- **AC-03.4** Given `controls_per_run` outside {2, 3, 4}, or a composition whose counts do not sum to N, or a mean rule not allowed for N, Then `400 common.validation_failed` naming the field.
- **AC-03.5** Given an active plan for (I1, K), When a second plan for (I1, K) is created, Then `409 quality.code_duplicate`.
- **AC-03.6** Given a plan change (new version), Then runs already evaluated keep the plan version they were evaluated with (shown on the run).

### US-04 Targets (manufacturer vs established)
- **AC-04.1** Given a `lab_manager` enters mean 100.0 and SD 2.0 with source `manufacturer` for (I1, K, lot L1/LOT-SYN-01), Then a `draft` target exists; after activation it is `active` from `effective_from`. A manual create with source `established` is rejected with `400 common.validation_failed` (`/source`): established targets come only from "establish from data" (AC-04.2).
- **AC-04.2** Given 25 accepted, non-excluded observations of that lot, When "establish from data" is run over them, Then a `draft` target with source `established`, `basis_n = 25`, mean = arithmetic mean and SD = sample SD (n − 1) of those values is created (decimal-only arithmetic and rounding per 02-TRD §7.6, 08 A17 D-54).
- **AC-04.3** Given fewer observations than the tenant setting `target_min_points` (default 20 [CONV]; the "≥20 runs" practice is UNVERIFIED, 01 §2.5), Then `422 quality.insufficient_qc_data` (CR-C9-002).
- **AC-04.4** Given SD ≤ 0, Then `400 common.validation_failed`.
- **AC-04.5** Given an active target T1, When T2 for the same key is activated with `effective_from = X`, Then T1 gets `effective_to = X` and status `superseded`, and observations before X keep T1's mean/SD snapshot (glossary "Target mean / SD": old points are evaluated against the targets in force at the time).
- **AC-04.6** Given an `active` target, When anyone tries to change its mean or SD, Then `409 common.immutable_record`.
- **AC-04.7** (Phase-1 history, 08 A17 D-60) Given `no_plan` observations of a pair older than `reprocess_window_days`, When the pair's plan is activated, Then they are re-classified by 02-TRD §6.3 rows 4–8 only; any that would be assigned become `late_unassigned`. They appear on the LJ chart and `no_target` ones can feed "establish from data", but no run, `quality.qc_run.rejected.v1` event or result hold is created from them.

### US-05 QC observation import
- **AC-05.1** Given C5 stored a QC result (instrument or manual) visible in `lab.v_pub_qc_result`, Then within 70 s (one-minute sweep + processing) one `quality.qc_observations` row exists for it; importing the same `qc_result_id` again creates nothing.
- **AC-05.2** Given `instruments.qc.received.v1` arrives, Then a sync job is enqueued for the tenant (debounced; an already queued or running sync absorbs the trigger without moving its start time) so the observation is imported within 15 s p95 of C5's commit [CONV target].
- **AC-05.5** Given 1,200 QC rows in `lab.v_pub_qc_result` with the same `created_at` second, When the sync runs, Then all 1,200 observations are imported in one cycle and the cursor ends at the last row's `(created_at, qc_result_id)`. Given one row that cannot be inserted (for example an unknown instrument), Then that row is skipped and counted as `import_error`, and the rows after it are imported.
- **AC-05.3** Given a QC row with no `analyte_id` (unmapped instrument code), Then status `unmapped_analyte`; with no numeric value, `non_numeric`; with no active plan, `no_plan`; with no active target, `no_target`; with the lot expired on the observation date, `lot_expired`; with `unit_code` different from the target's unit, `unit_mismatch`. None of these is evaluated.
- **AC-05.4** Given an observation whose `observed_at` is earlier than the start of the pair's latest evaluated run, Then status `late_unassigned`; it is charted as an unevaluated point and never changes an evaluated run.

### US-06 Westgard evaluation
- **AC-06.1** Every vector in 02-TRD §7.9 (V01–V32) produces exactly the listed outcome and fired rules in a unit test of `westgard.ts`.
- **AC-06.2** Given tenant `westgardMode = classic`, Then 4-1s, 3-1s and the n-x rules are evaluated only when a 1-2s warning fired in the current run (vectors V10c, V12c, V18c); given `modern`, they are evaluated independently (V10m, V12m, V18m).
- **AC-06.3** Given R-4s conditions split across two runs (V06), Then R-4s does not fire (within-run only, 04 L23).
- **AC-06.4** Given +3.5 SD and −0.6 SD in one run (V07), Then only 1-3s fires, not R-4s (glossary "R-4s").
- **AC-06.5** Given an observation exactly at +2.0 SD or +3.0 SD (V24a/b), Then it does not "exceed" that limit.
- **AC-06.6** Given the first observation of a run already violates 1-3s (V27), Then the run is rejected immediately without waiting for the other levels, and later members observed within `run_window_minutes` of the run are attached to that run without changing the outcome (08 A17 D-52). Test: assembly vector AS1 (02-TRD §7.3) — V27 followed by an L2 member within the window gives one run and one `quality.qc_run.rejected.v1`.
- **AC-06.7** Given a run collects fewer than N observations and no new member arrives within the plan's `run_window_minutes` (default 30 [CONV]), Then it is evaluated with outcome `incomplete` (when no rejection rule fires) or `rejected`.
- **AC-06.8** Given a run is rejected, Then exactly one `quality.qc_run.rejected.v1` is published in the same transaction with `analyte_ids = [K]`, `rules_violated`, `rule_mode`, `controls_per_run`, `run_at`, `hold_since` per 02-TRD §7.7 (vectors H1–H4), `rejected_at`; re-processing produces no second event (idempotency key `<qc_run_id>:rejected`).
- **AC-06.9** Given a run with only a 1-2s violation, Then outcome `accepted_warning` and no event (04 L23: warning only).

### US-07 Corrective actions and close-out
- **AC-07.1** Given a rejected run, When a technologist records a corrective action (coded action + text), Then an append-only corrective-action row exists with actor and time.
- **AC-07.2** Given a rejected run without any corrective action, When "close" is called, Then `409 quality.corrective_action_required`.
- **AC-07.3** Given a corrective action but no later accepted run (`accepted` or `accepted_warning`) of the same plan with `run_at > rejected run's run_at + run_window_minutes`, When "close" is called, Then `409 quality.rerun_required` (CR-C9-002; 08 A17 D-52). An accepted run that holds the remaining levels of the same QC event does not count.
- **AC-07.4** Given both, When "close" is called, Then the run status becomes `closed` with `closed_at`, and the UI shows "Patient results held by this failure stay on hold until released in Lab › Settings › QC holds" (C5 owns release, 03-IC §10.2 flags).
- **AC-07.5** Given an `accepted_warning` run, When a technologist acknowledges it with a comment, Then an acknowledgement row is stored and the run shows "Reviewed".

### US-08 Levey-Jennings chart
- **AC-08.1** Given plan (I1, K), level L1, lot LOT-SYN-01 and a date range ≤ 400 days [CONV], Then the chart shows one point per observation (value on y, observed time on x), horizontal lines at mean, ±1SD, ±2SD, ±3SD of the target in force at each point (step change when targets change), and never merges levels or lots on one line (glossary "Levey-Jennings chart").
- **AC-08.2** Points are distinguishable by text and shape, not colour alone: accepted, warning (1-2s), rejected (with rule codes), excluded, unevaluated (02-CV §14).
- **AC-08.3** Given the chart is open and a new observation is evaluated, Then it appears within 15 s (polling [CONV]).
- **AC-08.4** Given "z-score view", Then all levels of the plan are plotted in SD units on one chart as separate series (one per level and lot).
- **AC-08.5** A visually hidden data table with the same points is rendered (accessibility, 02-CV §14).

### US-09 QC status and `qcStatusFor`
- **AC-09.1** Given the timeline vectors S1–S8 in 02-TRD §7.8, Then `qcStatusFor` returns exactly the listed `status`, `lastInControlRunAt`, `currentRunId` and `violatedRules`.
- **AC-09.2** Given a time before any evaluated run → `no_qc_data` (03-IC §4.11 contract test 7); only a 1-2s warning on the governing run → `warning` (contract test 6).
- **AC-09.3** Given a rejected run that is not closed, Then status is `out_of_control` even if a newer run was accepted.
- **AC-09.4** Given the last accepted run is older than the plan's `qc_validity_hours` (default 24 [CONV]) at `at`, Then `no_qc_data`.
- **AC-09.5** Given patient results keep arriving (`instruments.result.received.v1`) for a planned pair whose QC is older than its validity, Then the status board shows "QC overdue" and the count of patient results since the last QC; the metric `lims_quality_qc_overdue_pairs` counts it.

### US-10 Auto-verification rule set (DSL as data)
- **AC-10.1** Given a pathologist creates a draft with a rule for analyte K: limits 3.5–5.1, allowed range flags `N`, Then the draft validates against the DSL schema (02-TRD §8.2) and is stored as version 1 `draft`.
- **AC-10.2** Given two rules with the same (analyte, instrument) key, or `low > high`, or a range flag other than N/L/H, Then `422 quality.rule_set_invalid` with `errors[]` pointing at the rule.
- **AC-10.3** Given a version not in `draft`, When it is edited, Then `409 quality.rule_set_invalid_transition`.

### US-11 Simulation before activation
- **AC-11.1** Given a version is moved to `simulating`, Then every `canAutoVerify` call also evaluates it in shadow mode and stores a `shadow` decision row; the decision returned to C5 never depends on the shadow version.
- **AC-11.2** Given fewer than `sim_min_days` (default 7 [CONV]) since simulation start or fewer than `sim_min_decisions` (default 100 [CONV]) shadow decisions, When activation is requested, Then `409 quality.simulation_incomplete`.
- **AC-11.4** Given a `simulating` version, When the simulation is stopped, Then the version becomes `stopped` (terminal, 08 A17 D-55): its definition and shadow rows are kept, no further shadow rows are written, and any later transition returns `409 quality.rule_set_invalid_transition`. A new draft can be created from it with `copy_from_version_id`.
- **AC-11.3** The simulation report shows: decisions evaluated, would-allow, would-deny by reason, and for would-allow results how many were later manually verified, plus a sample list (≤ 200) linking to the order's results in C5.

### US-12 Activation (four-eyes)
- **AC-12.1** Given the version author requests activation, Then `403 quality.self_activation_forbidden`.
- **AC-12.2** Given a different holder of `quality.autoverify.manage` at aal2, When they activate, Then the version becomes `active`, the previous active version becomes `retired`, and `access_log`/audit record the activation.
- **AC-12.3** Given a session at aal1, When any `quality.autoverify.manage` operation is called (create, replace draft, start/stop simulation, activate, retire, discard), Then `403 auth.mfa_required` (privileged permission, 04 A4).

### US-13 `canAutoVerify` decisions and audit
- **AC-13.1** Every vector A1–A14 in 02-TRD §8.5 returns exactly the listed decision and reasons.
- **AC-13.2** Given tenant `autoVerificationEnabled = false`, Then the decision is `deny` with `feature_disabled` regardless of rules (03-IC §4.11 invariant).
- **AC-13.3** Given an `active` (live) evaluation, Then exactly one `live` decision row exists per call with inputs, matched rule key, rule-set version, QC status and QC run id.
- **AC-13.4** Given `allow`, Then the returned `ruleSetVersion` equals `<rule_set_version_id>` of the active version.
- **AC-13.5** Given a call with no simulating version and either the tenant disabled or no active version, Then the decision is `deny` (`feature_disabled` or `rule_missing`) and is counted in `lims_quality_autoverify_short_circuit_total`; no row is written (DECISION D-AV-4).
- **AC-13.6** p95 `canAutoVerify` ≤ 10 ms and `qcStatusFor` ≤ 10 ms in-process (03-IC §4.11) at 10× seed volume.
- **AC-13.7** Given a user opens a decision's detail (#47, P3 inputs) or a simulation report (#42), Then one access-log row is written with action `autoverify_decision.view` or `autoverify_simulation.view` respectively (08 A17 D-53).

### US-14 TAT alerts
- **AC-14.1** Given test CBC with routine target 4 h, segment `within_lab`, and a received specimen, When 3 h 12 min (80 % [CONV]) elapse without a verified CBC result, Then a `warning` alert exists; at 4 h `breached`; at 6 h (150 % [CONV]) `escalated` (vectors T1–T4, 02-TRD §9.4).
- **AC-14.2** Given `lab.result.verified.v1` for that order item × test, Then the within-lab clock stops at `verified_at` and the alert leaves the open list. The event may lack `specimen_id` and `verified_by_membership_id` (08 A13 D-2); C9 handles it the same way.
- **AC-14.3** Given segment `total`, Then the clock starts at the order's `registered_at` from `reporting.v_pub_order_report_tat` (08 A17 D-59), or at the earliest specimen `ordered_at` when the view has no row for the order yet, with the basis stored in `start_basis`. It stops at a `reporting.report.released.v1` whose `order_item_ids` contains the item (or a `final` release without `order_item_ids`), so a final release of another report family does not stop it (vectors T12–T14, 02-TRD §9.4).
- **AC-14.4** Given the specimen is rejected and the test moves to a recollection specimen, Then a within-lab clock restarts at the new specimen's `received_at` with alert level reset; a total clock continues.
- **AC-14.5** Given a test without a TAT target for its priority, Then no clock and no alert.
- **AC-14.6** Given an alert, When a user with `quality.tat_alert.ack` acknowledges it with an optional note, Then the alert shows acknowledged-by/at; a later, higher level raises a new unacknowledged alert.
- **AC-14.7** A centre-scoped user sees only alerts of their centres (RLS `__tenant_centre`).
- **AC-14.8** Every TAT figure on screen names its segment ("Within lab: received → first verified result" / "Total: registration → report released") (glossary "TAT").

### US-15 QC summary view for MIS
- **AC-15.1** `quality.v_pub_qc_summary` returns per tenant × instrument × analyte × business date: runs, accepted_runs (accepted + accepted_warning), rejected_runs, warnings (accepted_warning), last_in_control_run_at, with exactly the 03-IC §6.7 columns.

## 6. Success metrics

| Metric | Target | Source |
|---|---|---|
| QC observation → evaluated outcome latency | p95 ≤ 15 s after C5 commit when triggered by event; ≤ 70 s via sweep [CONV] | `lims_quality_qc_eval_lag_seconds` |
| Rejected run → `quality.qc_run.rejected.v1` | same transaction (0 s) | event tests |
| Rule-engine correctness | 100 % of §7.9 vectors pass on every build | CI |
| `canAutoVerify` / `qcStatusFor` latency | p95 ≤ 10 ms each (03-IC §4.11) | `lims_quality_port_duration_seconds` |
| Auto-verify safety | 0 `allow` decisions with any reason present; 0 `allow` while tenant disabled | invariant test + nightly audit query |
| TAT alert timeliness | alert raised ≤ 90 s after crossing a threshold (60-s sweep [CONV]) | `lims_quality_tat_alert_lag_seconds` |
| Corrective-action completeness | 100 % of closed rejected runs have ≥ 1 corrective action (enforced) | service guard (#32) + DB trigger `quality.enforce_run_frozen` (05-SCHEMA §8) |

## 7. Phase

Phase 2 (04 §12). Until the C9 module exists, C0's phase stub answers `QualityPort` in every environment incl. staging/production (`deny`/`feature_disabled`, `no_qc_data`; C0 02-TRD §9, CR-C0-010 as modified by 08 R9 — stubs only deny/disable; 02-CV §8.2 exception list). C9's first PR (T-01) removes the stub from `phase-stubs.ts` (paired C0-0D PR) and registers C9's own `QualityPort` that returns exactly the stub results until T-13/T-16 replace each method (08 A17 P-20).

## 8. Product decisions

| ID | Decision | Rationale |
|---|---|---|
| D-AV-1 | Auto-verification replaces **only** technologist first verification (result transition R4). Pathologist approval (R6) is always a human action. Lab policy can only make auto-verification stricter (fewer rules, disabled analytes, QC warning not allowed); it cannot extend it to approval. | 00 C5 (two-step approval), 04 R1/R2, glossary "Auto-verification". |
| D-AV-2 | Critical results, delta failures and results without an instrument are never auto-verified; these exclusions are hard-coded, not rule options. | 01 §2.2 criteria; 03-IC §4.11 reasons. |
| D-AV-3 | One rule set per tenant, versioned; at most one `active` and one `simulating` version. | Simple resolution; no rule-set precedence to explain. |
| D-AV-4 | A `live` decision row is written whenever the tenant is enabled and an active version decided; a `shadow` row whenever a simulating version exists. Calls that end at `feature_disabled` or have no version to evaluate are counted in metrics only. | "Audit every auto-verify decision" without storing ~250k non-decisions/day (02-TRD §13 arithmetic). |
| D-QC-1 | Default Westgard mode = `classic` (C2's provisional default confirmed). | research/01 §2.5: 1-2s is "used as a warning rule to trigger careful inspection of the control data by the following rejection rules", and "in the **classic** multirule, 4-1s and 10x are evaluated only after a 1-2s warning has fired"; it asks for a per-lab flag with an explicit default. Per-lab switch to `modern` in C2 settings. |
| D-QC-2 | One QC run = one instrument × one analyte. `quality.qc_run.rejected.v1.analyte_ids` always has one element. | Glossary "Run"; precise holds. |
| D-QC-3 | QC holds are released in C5 by a human (`releaseQcHold`); C9 does not auto-release. | C5 02-TRD §6.1; no "accepted" event exists (CR candidate in 06 §6). |
| D-TAT-1 | Alerts are in-app only (alert board, badge, metrics → C1). | NotificationPort has no TAT purpose; C9 is not its consumer (01 §5.1). |

## 9. Dependencies (contracts only)

| Dependency | Kind | What C9 uses |
|---|---|---|
| C0 | platform | DDL (this 05-SCHEMA), OpenAPI `quality.yaml`, event schema `quality.qc_run.rejected.v1`, fakes, worker/API cores, UI kit |
| C2 `IdentityPort` | port | `assertRole`, `getActor` (caller only), `getTenantSettings` (`westgardMode`, `autoVerificationEnabled`, `timezone`, `retentionYears`) |
| C0 `ctx.core` | core API | `memberships.list`, `user` for other staff members' display names (08 A17 P-17) |
| C3 `CatalogPort` | port | `getTest` (analytes, unit, decimals; `tatTargetSegment` via CR-C3-001), `mapInstrumentCode` (plan warning) |
| C3 HTTP | HTTP (web) | `GET /v1/catalog/tests`, `GET /v1/catalog/tests/{test_id}` for pickers |
| C5 | views + events + port | `lab.v_pub_qc_result`, `lab.v_pub_pending_items`, `lab.v_pub_specimen_timeline`; events `lab.result.verified.v1`, `lab.specimen.status_changed.v1`; C5 consumes `quality.qc_run.rejected.v1` and calls `QualityPort` |
| C6 | event + view | `reporting.report.released.v1` (A3); `reporting.v_pub_order_report_tat` (`registered_at`, total-TAT start; TAT worker only — 08 A17 D-59, P-21) |
| C7 | events + HTTP (web) + view | `instruments.qc.received.v1`, `instruments.result.received.v1`; `GET /v1/instruments/instruments` for pickers; `instruments.v_pub_instrument_directory` (CR-C9-006 primary, CR-C12-005 merged — 08 §4.9: `tenant_id, instrument_id, centre_id, instrument_code, display_name, vendor, model, state, is_active`; consumers C8, C9, C12) |
| C8 | consumer of C9 | reads `quality.v_pub_qc_summary` |

## 10. Blocked items and defaults

| Blocker | Effect on C9 | Default built meanwhile |
|---|---|---|
| B2 (analyser models and official LIS manuals) | Which instruments mark QC, how control id/lot/level are sent, whether instrument time is sent (01 §2.5; 04 N6–N8 UNVERIFIED) | Control-ID maps with lot wildcard; manual QC entry in C5 as the fallback source; `observed_at` falls back to server `received_at` (02-TRD §6.2) |
| B3 (test list with ranges) | Real analytes/targets | Synthetic catalog and synthetic control materials (05-SCHEMA §9) |
| B14 (07-BLOCKERS: chunks C14, C5, C9 — auto-verify rule-set sign-off, 08 A17 D-57) | Who signs off auto-verify rule sets | Four-eyes activation by two holders of `quality.autoverify.manage`; nothing activates by default |
| B15 (legal retention; C9 listed per 08 A17 D-57) | Retention of QC records and decision audit | 5-year floor via tenant `retentionYears` (04 I8) |
