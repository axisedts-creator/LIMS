# C5 Lab Workflow — 02 Technical Requirements (TRD)

Status: DECISION, 2026-11-05. Names of tables, endpoints, events, permissions and error codes follow 03-IC and 02-CV verbatim. Anything 03-IC lacks is in §15 "Change requests raised" and is designed as if accepted (marked **(CR-C5-nnn)**).

---

## 1. Owned paths (01 §3)

| Path | Content |
|---|---|
| `services/api/src/modules/lab/` | API module (manifest, handlers, service, domain, repository, events, ports/LabPort.impl.ts, mappers, tests) |
| `services/worker/src/jobs/lab/` | worker manifest, consumers, tasks, cron |
| `apps/web/src/app/(staff)/lab/` | Next.js route segment (pages, loading/error) |
| `apps/web/src/features/lab/` | nav manifest, BFF server functions, components, hooks, forms, help, tests |
| `docs/manual/lab/` | user-manual pages |

C5 never edits `db/`, `contracts/`, `packages/*`, any `core/`. DDL in `05-SCHEMA.md` and the endpoint list in §5 are the specification C0 implements (01 §0).

## 2. Stack and pinned libraries

| Component | Version | Source |
|---|---|---|
| Node.js | 26.x LTS, exact patch pinned by C0 | 02-CV §1.1 |
| TypeScript, Fastify, Next.js (App Router) | C0 pins | 02-CV §1.1 |
| `fastify-openapi-glue` | 4.12.0 (mounted by core) | 04 T7 |
| Graphile Worker | 0.18.0 (via worker core) | 04 S10, T7 |
| PostgreSQL | 17 (`supabase/postgres:17.6.1.136`) | 04 D9 |
| `openapi-typescript` / `openapi-fetch` | 7.13.0 / 0.17.0 (generated client in `@lims/api-client-ts`) | 04 T7 |
| MSW | 3.0.3 (web tests) | 04 T7 |
| B.S. dates | only through `@lims/shared-ts/bsdate` (wraps `@remotemerge/nepali-date-converter` 1.2.7) | 04 D13 |
| UUIDv7, logger, errors, crypto, money | `@lims/shared-ts` | 02-CV §2.1 |
| Decimal + formula | `@lims/shared-ts/decimal`, `@lims/shared-ts/formula`, implemented once by C0-0A (08 R12a; CR-C5-002 merged into CR-C3-002). C5 has **no local parser** | 08 R12a |
| Barcode symbol rendering (Code 128 → SVG) | `@lims/ui` `BarcodeSymbol` (C0-0D kit component, 08 §4.6; value `^[A-Z0-9-]{1,32}$`, never logged); no C5-local encoder, no new dependency | 08 §4.6 (§4.6) |
| Charts (trend) | `@lims/ui` `TimeSeriesChart` with `referenceBand` (C0 04-UI-UX §2.5; 08 R22) | 02-CV §14 |

New third-party dependencies: **none**. (02-CV §15.1 table therefore empty.)

## 3. Internal architecture

### 3.1 Layers (02-CV §2.2)

```
handlers/<operationId>.ts      authz (IdentityPort.assertRole after object load) → service → mapper
service/
  specimen.service.ts          create from order, collect, dispatch, receive, reject, recollect, aliquot, store, discard, labels
  order.service.ts             lab order read model, items_changed/cancelled, status board, readiness
  result.service.ts            enter, recompute, verify, return, approve, amend, history, trend
  evaluation.service.ts        range flag, delta, critical (pure domain + port calls)
  ingest.service.ts            instrument apply pipeline (bulk + port replay), exceptions
  critical.service.ts          critical log + notifications
  worklist.service.ts          worklists, pending list, worksheets
  qc.service.ts                QC capture, holds
  config.service.ts            lab settings, delta rules, coded sets
  module-result.service.ts     submitModuleResult (A1)
domain/
  specimen.state.ts            transition table S1–S15 (03-IC §10.1) — pure
  result.state.ts              transition table R1–R8 (03-IC §10.2) — pure
  rollup.ts                    specimen roll-up from result statuses — pure
  barcode.ts                   pattern parser/renderer — pure
  flags.ts                     range/critical flag computation — pure
  delta.ts                     delta check — pure
  readiness.ts                 approved-set hash + completeness — pure
  formulaInputs.ts             input collection + provenance around @lims/shared-ts/formula (no local parser — 08 R12a)
  matching.ts                  ingest decision table — pure
repository/                    one file per table group; SQL only for schema `lab`; explicit tenant filter
events/publish.ts              typed publishers for the 7 lab events
ports/LabPort.impl.ts          LabPortV1
mappers/                       DTO allowlists per role
```

### 3.2 Transaction rules

- Every service use-case runs inside one `ctx.db.tx`. Events are published in the same transaction (outbox, 02-CV §7.3).
- Port implementation (`LabPort.impl.ts`) uses the caller's `ctx.tx` and never opens a transaction (02-CV §8.1).
- Row locking: specimen transitions `SELECT … FOR UPDATE` the specimen row; result transitions lock the result row; roll-up locks the specimen after results (fixed order: results by id ascending, then specimen) to avoid deadlocks [CONV].
- Optimistic concurrency: single-object state transitions require `If-Match` with the row `version`; mismatch → `409 common.version_conflict`; missing → `428 common.precondition_required`. These are exactly #4, #7, #9, #10, #11, #12, #13 (specimen), #27, #29, #30, #32 (result), #48 (settings), #51, #52 (delta rule) and #54 (tenant code row, when it exists; creating a new tenant code sends no `If-Match`). No other operation takes `If-Match`: creates, record-appends and one-shot actions (#14, #14a, #20, #37, #40, #41, #42, #44, #46, #50) and reads do not. Bulk endpoints (#5, #6, #8, #24, #28, #31) carry per-id `version` in the body instead of a header. (finding C5 #37)

### 3.3 State machines

Exactly 03-IC §10.1 and §10.2. Guards beyond 03-IC (all DECISION):

| Transition | Extra guard |
|---|---|
| S1 | barcode allocated in the same tx |
| S2 | `is_active = true` |
| S4 | `processing_centre_id` in actor's centre scope (or system); specimen `is_active`; from `collected`/`in_transit` only (never `ordered`) |
| S5 | ≥1 aliquot; each aliquot lists ≥1 test of the parent that is not `approved`/`cancelled`; aliquots copy `processing_centre_id`/`processing_branch_id` from the parent (08 A13 D-13) |
| S6 | first `resulted`-or-later result on the specimen, or host-query pick-up |
| S7–S9, S15 | computed by `rollup.ts` after any result transition; never called directly by handlers |
| S10 | consumer of `reporting.report.released.v1` only |
| S11 | reason code active in tenant set; from `ordered`, `collected`, `in_transit`, `received`, `aliquoted`, `in_process`, `resulted`, `verified` only (03-IC §10.1 "any pre-`approved`"); `stored`/`discarded`/`recollection_ordered` excluded |
| S12 | from `rejected` only; creates new specimen, which copies `processing_centre_id`/`processing_branch_id` from the rejected specimen (08 A13 D-13); at most one recollection per rejected specimen; the rejected specimen's order tests are re-pointed to the new specimen and **new** `pending` result rows are inserted (R1) — result rows are never re-pointed (08 A13 D-12). For a late recollection (#10 after a reject without recollection) the order tests re-pointed are those cancelled with `cancel_reason = 'specimen_rejected'` for that specimen; they get `cancelled_at`/`cancel_reason` cleared and their status recomputed (DECISION, needed by D-5 + AC-05.5); if none remains (all their items were removed by C4) → `409 lab.specimen_invalid_transition` |
| S13 | `received`…`reported`, location text required |
| S14 | from `stored`/`reported`/`rejected`/`recollection_ordered` (08 A13 D-15: the physical rejected tube); `discard_reason` required |
| R2/R3 | value valid for result type; not `approved`; calculated results only by the evaluator |
| R4 | not `on_hold`; delta/critical/unit-mismatch acknowledgement present when flagged (`lab.flag_ack_required`) |
| R5 | reason code from `lab` return reasons; system codes `input_changed` (formula input changed) and `module_resubmitted` (A1 resubmission on a `verified` result, 08 A13 D-7) |
| R6 | not `on_hold`; approver ≠ verifier (`lab.self_approval_forbidden`); critical acknowledgement rule (`lab.critical_ack_required`) when setting on |
| R7 | actor holds `lab.result.amend` else `lab.amend_requires_pathologist`; reason code required (`lab.amendment_reason_required`); value differs from current version |
| R8 | system only (order/item events, specimen rejection) |

Roll-up (`rollup.ts`): consider results with `specimen_id = s` and status ≠ `cancelled`. Let `min` = lowest of {pending < resulted < verified < approved}. If no such results → no roll-up (status stays). Else map `pending`→keep physical state (`received`/`aliquoted`/`in_process`), `resulted`→`resulted`, `verified`→`verified`, `approved`→`approved`. Moving up from `received`/`aliquoted` first passes through `in_process` (S6) — both transitions are emitted. Moving down (S15) only between `resulted`/`verified`/`approved`→lower roll-up; a specimen in `reported` never rolls down (an amendment keeps it `reported`). A specimen in `rejected`, `recollection_ordered`, `stored`, `discarded` never rolls.

`lab.order_tests.status` (denormalised for worklist/pending indexes, updated in the same tx as the change that affects it): `excluded`/`outsourced` fixed at creation; `cancelled` when the item is removed/order cancelled (`cancel_reason` `item_removed` / `order_cancelled` [CONV: labels only, no CHECK]), and when its specimen is rejected **without** recollection (`cancel_reason = 'specimen_rejected'`; its non-approved results go R8 `cancelled`; readiness excludes the test — 08 A13 D-5); else from the specimen and the test's non-cancelled results — specimen `ordered` → `awaiting_collection`; `collected`/`in_transit` → `awaiting_receipt`; received or later → lowest result status mapped `pending`→`in_process`, `resulted`→`resulted`, `verified`→`verified`, `approved`→`approved`. Rejected specimen with recollection → the order tests are re-pointed to the new specimen and follow it (S12). `reported_at` is set by the `reporting.report.released.v1` consumer for every `approved` order test of the items the release covers (§7.2).

## 4. Key algorithms

### 4.1 Specimen creation (consumer of `frontdesk.order.created.v1`)

1. Inbox dedupe (02-CV §7.4). Upsert `lab.orders` (stale-seq check on `aggregate.seq`).
2. `FrontdeskPort.getOrderSummary` → `registrationNo` snapshot. `FrontdeskPort.getPatientDemographics({ purpose: 'result_evaluation' })` (CR-C5-003, accepted in 08; fields `sex`, `ageAtOrder`, `birthOn`) → `patient_sex`, `patient_age_days` snapshot (age days = birthOn → registered_at if birthOn present, else years×365 + months×30 + days [CONV, documented approximation]).
3. `CatalogPort.resolveOrderables({ orderableIds, asOf: registered_at })` → tests, specimenRequirements.
4. For each item × test: insert `lab.order_tests` (department, workflow_type, priority, TAT target snapshot from `tatTargetSeconds`, status `awaiting_collection` or `excluded` for `narrative`; for outsourced (`item.outsourced` or workflow `outsourced`) status `outsourced`).
5. Tests with `TestDefinition.usesExistingMaterial = true` (CR-C11-009; add-on tests on existing material, e.g. IHC on an existing block) take part in no specimen requirement: their `order_tests` row has `uses_existing_material = true`, `specimen_id` NULL and status `in_process` (no collection/receipt step), and their results are created with `specimen_id` NULL (step 6); their `processing_centre_id`/`processing_branch_id` are copied from the order's received specimen (earliest received active specimen) when one exists, otherwise set in the transaction of the order's first S4 (08 A13 D-13); they are filled only through `submitModuleResult` or manual entry, never through the barcode-based ingest pipeline. For each specimen requirement with ≥1 non-excluded test: allocate barcode (§4.2), insert specimen `ordered` with `creation_key` (`<order_id>:<specimen_type_code>:<container_code|->`; items_changed additions `…:<items_version>`; recollection `recollect:<rejected_specimen_id>`; aliquot `aliquot:<parent_id>:<n>`) — a conflict means already created → skip — and emit S1. Snapshot `patient_sex`/`patient_age_days` onto the specimen (needed by host query under device RLS).
6. For each non-excluded, non-outsourced test: insert `pending` results (R1) for reportable analytes and formula-input analytes (`is_reportable` snapshot).
7. Commit.

### 4.2 Barcode allocation

- Pattern source: `IdentityPort.getTenantSettings({ keys: ['numbering'] }).numbering.barcodePattern`.
- Tokens supported by C5: `{yy}` (A.D. 2-digit year of `ctx.now()` in tenant timezone — `Asia/Kathmandu` in v1, 08 A13 P-15), `{seq:N}` (1 ≤ N ≤ 12), `{prefix}` (value from `TenantSettings.numbering.barcodePrefix`, `[A-Z0-9]{0,4}`, absent = empty — CR-C5-009 merged into CR-C2-008, 08 §4.12/§4.5; default pattern `{prefix}{yy}{seq:8}`, 08 A13 D-8: client shape `E1100001677` = prefix + yy + 8 digits), literal characters `[A-Z0-9]`. `{branch}`, `{centre}`, `{fy}`, `{fyl}` are **not** allowed in barcodes (DECISION: barcodes stay location-neutral so aliquots/recollections at another site keep the same series).
- Counter: `UPDATE lab.barcode_counters SET last_value = last_value + 1 … WHERE tenant_id = $1 RETURNING last_value` (insert row with 0 on first use, `ON CONFLICT DO NOTHING`). Scope = tenant (03-IC §9.3); never reset; not gapless (gaps allowed).
- Rendered value must match `^[A-Z0-9]{1,20}$` and `seq` must fit N digits; otherwise `LimsError('lab.barcode_pattern_invalid')` (**CR-C5-005**). Unique index `(tenant_id, barcode)` is the final guard (`lab.barcode_duplicate` on violation).
- Lock contention: at 1,500 specimens/day/lab [ASSUMPTION: ~3 containers per patient × 500 patients], peak hour 25% ⇒ 375/h ≈ one every 9.6 s per tenant — negligible.

### 4.3 Value evaluation (on every R2/R3 and amendment)

Where the output goes: for R2/R3 the outputs (flag, range snapshot, delta, critical) are written to the `lab.results` row; for R7 (amendment, incl. formula and A1 amendments) they are written **only** to the new `lab.result_versions` row, because the approved `lab.results` row is locked (05-SCHEMA lock trigger); at R6 the row's outputs are copied into `result_versions` v1. Mappers read the current version (`lab.v_result_current` `cur_*`) for approved rows (finding C5 #10).

1. Validate value against `AnalyteDefinition.resultType`: `numeric` → `DecimalString`, ≤ `decimals` fraction digits (missing decimals → ≤6); `ordinal`/`coded` → code must equal one of `AnalyteDefinition.ordinalSetValues[].code` (active values of `ordinalSetCode`, codes `^[A-Z0-9_+\-]{1,16}$` — 08 A13 D-9), else `lab.result_value_invalid`; `text` → ≤ 2,000 chars [CONV]; `attachment` → only via instrument attachment payload; `narrative` → rejected (`lab.result_value_invalid`).
2. Reference range: `CatalogPort.referenceRangeFor({ analyteId, sex, ageDays?, birthOn?, specimenTypeCode, at: specimen.collected_at ?? ctx.now() })`; `ageDays` from the `patient_age_days` snapshot; `birthOn` from `FrontdeskPort.getPatientDemographics({ purpose: 'result_evaluation' })`, read once per patient per transaction and passed when present (never stored, never cached beyond the request). Snapshot id/version/low/high/text/unit. `catalog.no_reference_range` → snapshot absent, flag absent (never fails the save).
   **Unknown age (08 A17.1, CR-C5-012 accepted):** when the snapshot has no age (`patient_age_days` NULL — C4 registration requires a date of birth or an age, so this is the exception path), C5 calls `referenceRangeFor` and `criticalLimitsFor` **without** `ageDays` (and without `birthOn`); C3 then matches only bands with no age bound (C3 02-TRD §7.3). If an age-unrestricted range band and an age-unrestricted critical band are found, flag and critical check run normally (steps 3–4). If either lookup finds nothing (`catalog.no_reference_range`, or `criticalLimitsFor` → `undefined`) while the age is unknown, the result is marked `range_unavailable_age_unknown = true` [CONV: C3 cannot tell "no critical set" from "only age-bounded critical bands", so C5 fails safe on either], it is **never auto-verified** (§4.5 step 11), and the result grid and the verification screen show "Age unknown — reference range and critical check not applied" (04-UI-UX §3.6, §3.8). The mark is recomputed on every evaluation (R2/R3/R7) and is false whenever the age is known. It does not block manual verification or approval.
3. Flag (`flags.ts`): numeric: `< critical.low` → `LL`; `> critical.high` → `HH`; else `< low` → `L`; `> high` → `H`; else `N`. Non-numeric: `A` if the code is in `critical.abnormalCodes`, or the range match has `normalCodes` and the code is not in them (`ReferenceRangeMatch.normalCodes`, 08 A13 D-9), or the user set the manual abnormal flag; else none. Comparison on exact decimals.
4. Critical: `CatalogPort.criticalLimitsFor(sameQuery)`; critical iff flag is `LL`/`HH` or code in `abnormalCodes` (direction `low`/`high`/`abnormal`). If critical and no log row exists for `(result_id, version_no, value_sha256_prefix16)` → insert `lab.critical_value_log`, emit `lab.critical_value.detected.v1`. If an existing open critical event's value is replaced by a non-critical value → set `value_changed_after_detection = true`.
5. Delta (`delta.ts`): active rule for the analyte effective at `ctx.now()`; previous result = latest `approved` result of the same `patient_id` and `analyte_id` with `unit_code` equal and `approved_at` within `window_seconds` before this specimen's `collected_at` (or now). `abs = |new − prev|`, `pct = abs / |prev| × 100` (prev = 0 → pct undefined). Fail if `abs > abs_threshold` (when set) or `pct > pct_threshold` (when set and defined). Store status, previous result id/value, abs, pct, rule id/version.
6. Formula dependents: for every calculated result in the same order item whose formula lists this analyte's code → recompute (§4.4).
7. QC hold: if an active `lab.qc_holds` row covers (instrument_id, analyte_id) → `on_hold = true`, `hold_id`.
8. Roll-up specimen.

### 4.4 Formula evaluation

Grammar and semantics: C3 02-TRD §7.1 as amended by 08 R12a, implemented by `@lims/shared-ts/formula` (C0-0A). No local parser. (C5's earlier ternary and `||`/`&&` are not part of the grammar — CR-C5-002 merged into CR-C3-002.) C5 calls `parseFormula(expression)` and `evaluateFormula(ast, inputs, { ageDays, ageYears, sex })` (signatures 08 §4.13) and runs the shared golden vectors `packages/fakes/contract-tests/formula.vectors.json`.

- Arithmetic `+ − × ÷` and comparisons run in exact decimal (≥ 28 significant digits, `@lims/shared-ts/decimal`); `sqrt`, `ln`, `log10`, `exp` and `pow` with a non-integer exponent are computed in IEEE-754 double, rounded to 15 significant digits and returned with `inexact: true`, which C5 stores in provenance (08 R12a).
- Division by zero or `invalid(reason)` → `not_computable` with that reason (`division_by_zero` / given code).
- Every IDENT must be in `inputAnalyteCodes`; an expression that fails to parse → `not_computable` reason `formula_unparseable`, metric `lims_lab_formula_errors_total`, warning log (no PHI) — C3 is the validator (`catalog.formula_invalid` is C3's code, not emitted by C5).
- Inputs: current value of the result with that analyte code in the **same order item**; must be `resulted`/`verified`/`approved`, numeric, and `unit_code` = input analyte's catalog `unitCode` (else `unit_mismatch`). Missing input → the library returns `{ok:false, reason:'missing_input:<CODE>'}`, which C5 maps to `calc_status = waiting_for_inputs` (never 0); `division_by_zero`, `domain_error` and `invalid(...)` reasons → `not_computable`.
- Output rounded half-up to the output analyte's `decimals`; stored as `DecimalString`; `origin = calculated`; `formula_provenance` JSON (expression, test revision, catalog revision, inputs[{analyte_code, result_id, version_no, value, unit_code}], evaluated_at, inexact).
- Cycles (a formula input that is itself calculated) are evaluated in topological order; a cycle → `not_computable` reason `formula_cycle`.

### 4.5 Instrument apply pipeline (`ingest.service.ts`; X2)

Input = `instruments.result.received.v1` payload (bulk path, system actor) or `InstrumentResultInput` (port path, caller actor). `InstrumentResultInput` is the payload camelCased field for field (08 A13 D-10: incl. `agentId`, `protocol`, `mappingStatus`, `unitRaw?`, `instrumentClockOffsetSeconds?`, `capturedAt?`, `processingKind?`, `sourceRecordId?`, `organism?`/`ast?`; `instrumentFlags?` absent = `[]`, `isRerun?` absent = `false`; `attachment?` port only), so both paths run the same steps, unit conversion included. Result-level key (04 N10) = `instrument_id:sample_barcode:instrument_analyte_code:(instrument_result_time|'none')`. The `lab.ingest_log` row takes `centre_id` from the payload `centre_id` / `centreId` and `processing_centre_id` from the matched specimen once step 4 finds one (08 R3).

| Step | Check | Outcome / action |
|---|---|---|
| 1 | `INSERT lab.ingest_log (tenant_id, result_key, …) ON CONFLICT DO NOTHING`; conflict → read stored outcome. If the stored outcome is `unmatched`/`rejected_state` **and** an `open` C5 exception exists for that key, the record is re-evaluated from step 2 (replay after a fix — CR-C7-011), the log row's outcome is updated and the exception is closed on success | `duplicate` (otherwise) |
| 2 | `record_kind ∈ {organism_id, ast}` (their `instrument_analyte_code` follows the C7 driver rule `ORG:<isolate>` / `AST:<isolate>:<antibiotic>:<method>` — 08 R13) | ignored by C5 (C10 consumes); log outcome `not_applicable` [CONV] |
| 3 | analyte unknown (`mapping_status = unmapped` or no `analyte_id`) → `CatalogPort.mapInstrumentCode(inbound)`; still unmapped | `unmatched`, exception `unmapped_code` |
| 4 | `lab.specimens` by `(tenant_id, barcode)` not found | `unmatched`, exception `unknown_barcode` |
| 5 | specimen `rejected`/`recollection_ordered`/`discarded` or `is_active = false` | `rejected_state`, exception `specimen_rejected` |
| 6 | specimen `ordered` → always `unmatched`, exception `specimen_not_received` (S4 from `ordered` is forbidden, 03-IC §10.1). Specimen `collected`/`in_transit` and `lab_settings.ingest_auto_receive = false` → `unmatched`, exception `specimen_not_received`; if true → perform S4 as system with `processing_centre_id` = event `centre_id`, then continue | as stated |
| 7 | no non-cancelled result on that specimen with the mapped `analyte_id` (prefer the mapped `test_id`) | `unmatched`, exception `analyte_not_ordered` |
| 8 | target `approved` | `rejected_state` with `reasonCode: 'result_locked'`, exception `result_locked` (value unchanged; 04 R1). Never throws `lab.result_locked` (CR-C5-008) |
| 9 | target `verified` | `unmatched`, exception `result_already_verified` (technologist decides to return + apply) |
| 10 | unit: if mapping has `unitConversion` and `unit_raw` / `unitRaw` matches `fromUnitRaw` → value × factor (both paths, 08 A13 D-10); else if `unit_code` ≠ analyte unit → store as received, `unit_mismatch = true`, flag evaluation skipped, exception `unit_mismatch` but value applied [DECISION: technologist must resolve before verify; verify blocked with `lab.flag_ack_required` until acknowledged]. A verify (#27/#28) with `unit_mismatch` in `acknowledged_flags` resolves the open `unit_mismatch` exception of that result (resolution `assigned`, resolver = verifier) in the same transaction (finding C5 #42) | `applied` (with open exception) |
| 11 | apply R2/R3 (`origin = instrument`, `instrument_id`, raw flags mapped via `flagMap`, append `lab.result_observations`), evaluation §4.3; then, when `LIMS_LAB_AUTOVERIFY_HOOK_ENABLED=true`, the result is not on hold and has no unit mismatch, call `QualityPort.canAutoVerify` for **every** instrument-origin save, independent of the tenant `autoVerificationEnabled` switch, and auto-verify (R4, `mode: auto`) only on `allow` (CR-C9-004). A result with `range_unavailable_age_unknown = true` is never auto-verified: C5 does not call `canAutoVerify` for it (08 A17.1) | `applied`, or `held` if a QC hold covers it |
| 12 | close matching open exceptions with same `result_key` (port path) | — |

`attachment` records attach `{bucket, object_path, sha256, mime_type}` to the result (stored in `lab.result_attachments`); object path first segment must equal `ctx.tenantId` else `unmatched` reason `attachment_tenant_mismatch` (defence against a mis-bound device — REQ-SEC-121).

### 4.6 Label printing (DECISION)

01, 03-IC and 04 do not decide the printing mechanism or symbology (03-IC §9.3: "label symbology chosen in C5 TRD").

| Option | Verdict | Rationale |
|---|---|---|
| Browser print of an HTML page with inline SVG Code 128, `@page` sized to the label | **Phase 1 choice** | No new component on lab PCs; works with any label printer that has an OS driver (ASSUMPTION — validate per site); fits server-only BFF (04 S4); no foreign service |
| ZPL (or other printer language) sent through the C7 bridge agent | Deferred | Bridge agent is C7's and has no print capability in its contract; needs a C7 CR; printer languages are vendor-specific (UNVERIFIED per model) |
| PDF via C6 renderer | Rejected | renderer is for reports; adds render latency to the front-desk path |

- Rendering component: `@lims/ui` `BarcodeSymbol` (Code 128 SVG; 08 §4.6, requested by C11, used by C5). C5 passes the barcode value and the module width; the component owns the encoding.
- Symbology: **Code 128** (DECISION: encodes the `[A-Z0-9]{1,20}` barcode alphabet; commonly read by laboratory analysers' tube readers — ASSUMPTION, confirm per analyser under B2). The standard's document number is not cited in this research set (UNVERIFIED reference); the kit component is tested by C0 against a golden table; C5's acceptance test confirms a reference scanner reads printed labels.
- Interface (`apps/web/src/features/lab/components/labels/LabelRenderer.ts`):

```ts
export interface LabelData {           // from printSpecimenLabels response
  specimenId: string; barcode: string; patientName: string; ageSex: string; registrationNo: string;
  specimenTypeCode: string; containerCode?: string; collectedOn?: string; testCodes: readonly string[];
  moreTests: number; urgent: boolean; copies: number;
}
export interface LabelRenderer { readonly format: 'html_svg' | 'zpl'; render(labels: readonly LabelData[], size: { widthMm: number; heightMm: number }): string }
export const htmlSvgRenderer: LabelRenderer;   // Phase 1
// 'zpl' renderer: not implemented; selecting it in lab settings is rejected by validation until a C7 CR exists.
```
- Flow (08 A13 D-4): C4 calls #14a `requestOrderLabelPrint` (readiness only — no counter, no access log; `409 common.version_conflict` with detail until the specimens exist) and, when C4's `frontdesk.label_autoprint` is on, opens `staff.lab.order_labels` in a print frame after `200`. The label page uses only #14a (to wait for readiness when opened before the specimens exist) and #14 `printSpecimenLabels`, whose response carries `label_copies_default` and the label size; it needs neither #15 nor #47. The page always calls `window.print()` once after render. #14 is the only operation that increments `label_print_count` and writes access-log `specimen_label.print` (one row per specimen). There is no C5 auto-print setting (`lab_settings.auto_print_labels` deleted).
- Size: `lab_settings.label_width_mm` (default 50) × `label_height_mm` (default 25) [CONV]; quiet zones ≥ 10 module widths [CONV]; module width computed to fit width; minimum bar height 8 mm [CONV]. If the barcode cannot fit at ≥ 0.25 mm module width, render a warning "Label too small for this barcode" instead of a degraded symbol.

### 4.7 Readiness (`readiness.ts`)

- Approved set = for each result with `is_reportable` and status `approved` in non-excluded, non-outsourced, non-cancelled `order_tests` (an order test cancelled because its specimen was rejected without recollection is excluded — 08 A13 D-5): `result_id:current_version_no`. Hash = SHA-256 hex of the set sorted ascending, joined by `\n` (03-IC §4.5 fake spec, same as `approvedSetHash`).
- Complete if every such item test has all reportable results approved. Partial if `partialReleaseAllowed` and ≥1 department has all its items approved and the department's set ≠ last emitted for that department.
- Emit when the computed (completeness, set) differs from `lab.order_readiness.last_emitted_hash`; `contains_amendment` = any version_no ≥ 2. `aggregate.seq` = `readiness_seq + 1`. Evaluated after every approve/amend transaction for the order.

## 5. HTTP endpoints (spec for `contracts/openapi/lab.yaml`)

All: prefix `/v1/lab`, security `bearerJwt` (called via BFF), `tags: [lab]`, `x-rate-limit-tier: general` (04 §4: 10 req/s/user, burst 20), problem+json errors, `additionalProperties: false`, no `null` on the wire. Common errors on every operation (not repeated): `common.validation_failed`, `common.not_found`, `auth.unauthenticated`, `auth.forbidden`, `common.rate_limited`, `common.internal`. Actions additionally: `common.version_conflict`, `common.precondition_required` (the latter only on the `If-Match` operations of §3.2). `common.validation_failed` is always HTTP `400` (08 A13 P-1). Idempotency column: R = required (every POST that creates state, incl. master-data creates — 08 A13 P-8), O = optional, none = `x-idempotency: none` with the justification given in the row (02-CV §4.5). Bulk bodies max 200 ids (02-CV §4.1). Bulk bodies carry `items[{id, version}]` instead of `ids` (per-id optimistic concurrency); CR-C5-011 asks the lead to allow this form in 02-CV §4.1 (finding C5 #25). Lists: cursor pagination `limit` default 50 max 200. Conditional permissions are checked in the handler with `IdentityPort.assertRole` after loading the target and are written `+ <code> when <condition>` (08 A13 P-10).

### 5.1 Specimens

| # | Method + path | operationId | Permission | Request | Response | Extra error codes | Idem |
|---|---|---|---|---|---|---|---|
| 1 | POST `/specimens/lookup` | `lookupSpecimenByBarcode` | `lab.specimen.read` (roles incl. `front_desk`, `phlebotomist` — 08 A13 D-4; RLS keeps centre scope) | `oneOf`: `{ barcode: string ^[A-Z0-9]{1,20}$ }` \| `{ registration_no: string ^[A-Z0-9]{1,40}$ }` (body, never URL — P2) | barcode → `SpecimenDto`; registration_no → `{ data: SpecimenDto[] }` (all visible specimens of that order) | — (unknown barcode → 404 `common.not_found`; unknown registration no → `200 { data: [] }`) | O |
| 2 | GET `/specimens` | `listSpecimens` | `lab.specimen.read` | query `order_id`, `status` (csv), `centre_id`, `processing_centre_id`, `priority`, `received_at_from/_to`, `is_active` (default true), `sort` ∈ {`-created_at`, `received_at`, `-received_at`}, `cursor`, `limit` | `{ data: SpecimenDto[], page }` | `common.invalid_cursor` | — |
| 3 | GET `/specimens/{specimen_id}` | `getSpecimen` | `lab.specimen.read` | — | `SpecimenDetailDto` (+ transitions, tests, results summary) | — | — |
| 4 | POST `/specimens/{specimen_id}/collect` | `collectSpecimen` | `lab.specimen.collect` | `{ collected_at?: IsoUtc (≤ now, ≥ now−72h [CONV]) }` | `SpecimenDto` | `lab.specimen_invalid_transition`, `lab.specimen_inactive` | O |
| 5 | POST `/specimens/bulk-collect` | `bulkCollectSpecimens` | `lab.specimen.collect` | `{ items: [{ id, version }] ≤200 }` | `{ results: [{ id, outcome: ok|error, code?, specimen? }] }` | per-id codes as #4 | R |
| 6 | POST `/specimens/bulk-dispatch` | `bulkDispatchSpecimens` | `lab.specimen.collect` | `{ items: [{ id, version }] }` | per-id outcomes (→ `in_transit`) | per-id `lab.specimen_invalid_transition` | R |
| 7 | POST `/specimens/{specimen_id}/receive` | `receiveSpecimen` | `lab.specimen.receive` | `{ processing_centre_id: Uuid }` | `SpecimenDto` | `lab.specimen_not_receivable`, `lab.specimen_invalid_transition`, `lab.specimen_inactive` | O |
| 8 | POST `/specimens/bulk-receive` | `bulkReceiveSpecimens` | `lab.specimen.receive` | `{ processing_centre_id, items: [{ id, version }] }` | per-id outcomes | as #7 | R |
| 9 | POST `/specimens/{specimen_id}/reject` | `rejectSpecimen` | `lab.specimen.reject` | `{ reason_code: Code (x-coded-set: lab.rejection_reasons), comment?: ≤500, recollection_required: boolean }` | `{ specimen: SpecimenDto, recollection_specimen?: SpecimenDto }` | `lab.rejection_reason_required`, `lab.specimen_invalid_transition` | R (creates the recollection specimen — 08 A13 P-8) |
| 10 | POST `/specimens/{specimen_id}/recollect` | `requestRecollection` | `lab.specimen.reject` | `{}` | `{ specimen, recollection_specimen }` | `lab.specimen_invalid_transition` | R |
| 11 | POST `/specimens/{specimen_id}/aliquots` | `createAliquots` | `lab.specimen.receive` | `{ aliquots: [{ specimen_type_code?: Code, test_ids: Uuid[] ≥1 }] 1..10 [CONV] }` | `{ parent, aliquots: SpecimenDto[] }` | `lab.specimen_invalid_transition` | R |
| 12 | POST `/specimens/{specimen_id}/store` | `storeSpecimen` | `lab.specimen.receive` (DECISION) | `{ location: string ≤120 }` | `SpecimenDto` | `lab.specimen_invalid_transition` | O |
| 13 | POST `/specimens/{specimen_id}/discard` | `discardSpecimen` | `lab.specimen.receive` (DECISION) | `{ discard_reason: string ≤200 }` | `SpecimenDto` | `lab.specimen_invalid_transition` | O |
| 14 | POST `/specimens/labels` | `printSpecimenLabels` | `lab.specimen.label_print` | `{ order_id?: Uuid, specimen_ids?: Uuid[] ≤200, copies?: 1..5 }` exactly one of order_id/specimen_ids; `copies` absent = `label_copies_default` | `{ labels: LabelDataDto[], errors: [{ id, code }], size: { width_mm, height_mm }, label_copies_default: 1..5 }` — the only operation that increments `label_print_count`/`last_label_printed_at` and writes access-log `specimen_label.print` (one row per specimen, 08 A13 D-4/D-11) | per-id `lab.specimen_inactive` | O |
| 14a | POST `/orders/{order_id}/label-prints` | `requestOrderLabelPrint` (CR-C4-010, accepted in 08) | `lab.specimen.label_print` | `{}` (DECISION: readiness only, so no `copies`; copies come from #14) | `200 { order_id, specimens: [{ specimen_id, barcode, outcome: ready\|inactive }], labels_route: 'staff.lab.order_labels' }` — readiness call only: no counter, no access log (08 A13 D-4) | `409 common.version_conflict` with detail "specimens not created yet" when the order's `lab.orders` row or specimens do not exist yet (C4 retries every 1 s up to 10 s; a retry needs no key); no dedicated error code (08 Addendum A2.10) | none (`x-idempotency: none`, justification "read-like readiness check; no state written" — 08 A13 D-4) |

### 5.2 Orders, status board

| # | Method + path | operationId | Permission | Request | Response | Extra codes |
|---|---|---|---|---|---|---|
| 15 | GET `/orders/{order_id}` | `getLabOrder` | `lab.specimen.read` | — | `LabOrderDto` (specimens, order tests with status) | — |
| 16 | GET `/orders/{order_id}/results` | `listOrderResults` | `lab.result.read` | query `department_id?` | `{ order, items: [{ order_item_id, test, results: ResultDto[] }] }` | — |
| 17 | GET `/status-board` | `getStatusBoard` | `lab.status_board.read` | query `centre_id?`, `registered_at_from` (required), `registered_at_to` (≤ 7 days span [CONV]), `board_status` csv ∈ {collected, in_lab, ready, printed, waiting}, `cursor`, `limit` | `{ data: [{ order_id, registration_no, patient_display (name, age/sex), centre_id, board_status, rejected_specimens, last_released_at?, priority }], page }` | — |

### 5.3 Worklists, pending, worksheets

| # | Method + path | operationId | Permission | Request | Response | Idem |
|---|---|---|---|---|---|---|
| 18 | GET `/worklist-items` | `listWorklistItems` | `lab.worklist.read` | query `department_id?`, `instrument_id?`, `priority?`, `status` csv ∈ {in_process, resulted, verified} (default in_process,resulted), `processing_centre_id?`, `sort` ∈ {`priority_received` (default), `received_at`}, cursor/limit | `{ data: WorklistItemDto[] }` — order_test row + specimen barcode, registration no, patient display, test code, priority, received_at, result counts | — |
| 19 | GET `/pending-items` | `listPendingItems` | `lab.worklist.read` | query `department_id?`, `item_status` csv ∈ {awaiting_collection, awaiting_receipt, in_process, resulted, verified}, `priority?`, `centre_id?`, `over_target?: boolean`, cursor/limit | `{ data: PendingItemDto[] }` incl. `age_seconds`, `age_anchor` ∈ {registered, received}, `tat_target_seconds?` | — |
| 20 | POST `/worksheets` | `createWorksheet` | `lab.worksheet.manage` (CR-C5-004) | `{ title: ≤80, centre_id?: Uuid (must be in actor scope, else `403 auth.forbidden`; default = `processing_centre_id` of the first row), department_id?, instrument_id?, order_test_ids: Uuid[] 1..200 }`; no `centre_id` and the first row has no processing centre → `400 common.validation_failed` path `/centre_id` | `WorksheetDto`; `worksheets.processing_centre_id` = that of the first row; each `worksheet_items` row copies the worksheet's `centre_id`/`processing_centre_id` (finding C5 #43, #20) | R |
| 21 | GET `/worksheets` | `listWorksheets` | `lab.worklist.read` | query `created_at_from/_to`, `department_id`, cursor/limit | list | — |
| 22 | GET `/worksheets/{worksheet_id}` | `getWorksheet` | `lab.worklist.read` | — | `WorksheetDto` with rows | — |

### 5.4 Results

| # | Method + path | operationId | Permission | Request | Response | Extra codes | Idem |
|---|---|---|---|---|---|---|---|
| 23 | GET `/results/{result_id}` | `getResult` | `lab.result.read` | — | `ResultDto` (+ evaluation detail, provenance) | — | — |
| 24 | POST `/results/bulk-enter` | `bulkEnterResults` | `lab.result.enter` | `{ entries: [{ result_id, version, value_numeric?: DecimalString, value_text?: ≤2000, ordinal_code?: string ^[A-Z0-9_+\-]{1,16}$ (one of `AnalyteDefinition.ordinalSetValues[].code`, 08 A13 D-9), manual_abnormal?: boolean, comment_codes?: Code[] ≤10, comment_text?: ≤1000 }] 1..200 }` (exactly one value field unless only comments change) | `{ results: [{ result_id, outcome: ok|error, code?, result?: ResultDto }], recomputed: ResultDto[] }` | per-row `lab.result_value_invalid`, `lab.result_locked`, `lab.result_invalid_transition`, `common.version_conflict` | R |
| 25 | GET `/results/{result_id}/history` | `getResultHistory` | `lab.result.read` | query `limit` 1..20 default 5 | `{ data: [{ result_id, approved_at, value, unit_code, flag, version_no }] }` | — | — |
| 26 | GET `/patients/{patient_id}/analytes/{analyte_id}/trend` | `getAnalyteTrend` | `lab.result.read` | query `limit` 1..50 default 50 | `{ points: [...], reference_band?: { low?, high?, unit_code } }` | — | — |
| 27 | POST `/results/{result_id}/verify` | `verifyResult` | `lab.result.verify` | `{ acknowledged_flags?: ('delta'|'critical'|'unit_mismatch'|'instrument_flag')[] }` | `ResultDto` | `lab.result_invalid_transition`, `lab.result_on_hold`, `lab.flag_ack_required` (CR) | O |
| 28 | POST `/results/bulk-verify` | `bulkVerifyResults` | `lab.result.verify` | `{ items: [{ id, version, acknowledged_flags? }] }` | per-id outcomes | per-id as #27 | R |
| 29 | POST `/results/{result_id}/return` | `returnResult` | `lab.result.verify` (floor; both default holders — `lab_technologist`, `pathologist` — have it, 03-IC §11; no either-or form, 08 A13 P-10) | `{ reason_code: Code (x-coded-set: lab.return_reasons), comment?: ≤500 }` | `ResultDto` | `lab.result_invalid_transition` | O |
| 30 | POST `/results/{result_id}/approve` | `approveResult` | `lab.result.approve` (privileged) | `{}` | `ResultDto` | `lab.result_invalid_transition`, `lab.result_on_hold`, `lab.self_approval_forbidden`, `lab.critical_ack_required`, `auth.mfa_required` | O |
| 31 | POST `/results/bulk-approve` | `bulkApproveResults` | `lab.result.approve` | `{ items: [{ id, version }] }` | per-id outcomes | per-id as #30 | R |
| 32 | POST `/results/{result_id}/amend` | `amendResult` | `lab.result.amend` (privileged) | `{ value_numeric? \| value_text? \| ordinal_code? (as #24), comment_codes?, comment_text?, amendment_reason_code: Code (x-coded-set: lab.amendment_reasons), amendment_reason_text?: ≤500 }` | `ResultDto` (with new version) | `lab.amend_requires_pathologist`, `lab.amendment_reason_required`, `lab.result_value_invalid`, `lab.result_invalid_transition`, `auth.mfa_required` | R |
| 33 | GET `/results/{result_id}/versions` | `listResultVersions` | `lab.result.read` | — | `{ data: ResultVersionDto[] }` | — | — |
| 34 | GET `/verification-queue` | `listVerificationQueue` | `lab.result.read` | query `stage` ∈ {verify, approve} (required), `department_id?`, `priority?`, `flagged_only?: boolean`, cursor/limit | list of results with order/specimen context | — | — |

The amendment reason codes `module_phase_progression`, `module_preliminary_update` (08 A17 D-61) and `supplementary_report` (08 R1 seeds) are reserved for `LabPort.submitModuleResult`; `amendResult` (#32) refuses them with `400 common.validation_failed` (path `/amendment_reason_code`; 08 A13 P-1), and the amendment dialog does not offer them.

`lab.result.amend` handler: if `assertRole` throws `auth.forbidden` for `lab.result.amend`, the handler maps it to `403 lab.amend_requires_pathologist` (00 C6 wording); `auth.mfa_required` passes through.

### 5.5 Critical values

| # | Method + path | operationId | Permission | Request | Response | Idem |
|---|---|---|---|---|---|---|
| 35 | GET `/critical-values` | `listCriticalValues` | `lab.critical_value.read` | query `status` ∈ {open, notified, closed}, `detected_at_from/_to`, `centre_id?`, cursor/limit | list (result value included — staff authz) | — |
| 36 | GET `/critical-values/{critical_event_id}` | `getCriticalValue` | `lab.critical_value.read` | — | detail + notifications + `referrer_display_name?` (resolved server-side with `CatalogPort.getReferrer({ referrerId, purpose: 'display' })`; absent when the order has no referrer — technologists/pathologists do not hold `catalog.referrer.read`, finding C5 #45) | — |
| 37 | POST `/critical-values/{critical_event_id}/notifications` | `logCriticalNotification` | `lab.critical_value.log_notification` | `{ notified_party_kind ∈ {referrer, clinician, ward, patient, other}, notified_party_name: 1..120, contact_method ∈ {phone, sms, in_person, whatsapp, other}, contact_detail?: ≤60, notified_at: IsoUtc (≤ now+5 min clock skew [CONV]), outcome ∈ {reached, not_reached, left_message}, read_back_confirmed: boolean, read_back_text?: ≤300, comment?: ≤500 }`; `read_back_text` (1..300) required when `read_back_confirmed = true` → else `400 common.validation_failed` path `/read_back_text` (mirrors `critical_notifications__readback__ck`) | `CriticalNotificationDto` | R |

Critical-event lifecycle (`lab.critical_value_log.status`; finding C5 #36): `open` at detection (§4.3 step 4) → `notified` in the transaction of the first notification (#37) with `outcome = reached` and `read_back_confirmed = true`, which also sets `first_confirmed_notification_at`; other notifications are appended without a status change → `closed` (`closed_at`) when the result is approved (R6) or cancelled (R8), from `open` or `notified`. An amendment (R7) that is critical creates a new event row (`open`) for the new version (the dedupe key includes the version); because its result is already approved, that row goes `open → closed` at its first confirmed notification [CONV: no later approval exists to close it]; earlier rows stay as they are. A value replaced before verification keeps its row with `value_changed_after_detection = true` (status unchanged until approval/cancel closes it).

### 5.6 Instrument exceptions

| # | Method + path | operationId | Permission | Request | Response | Idem |
|---|---|---|---|---|---|---|
| 38 | GET `/ingest-exceptions` | `listIngestExceptions` | `lab.result.read` | query `status` ∈ {open, resolved, discarded} default open, `reason` csv, `instrument_id?`, cursor/limit | list | — |
| 39 | GET `/ingest-exceptions/{exception_id}` | `getIngestException` | `lab.result.read` | — | detail incl. raw value/flags | — |
| 40 | POST `/ingest-exceptions/{exception_id}/assign` | `assignIngestException` | `lab.result.enter` | `{ result_id: Uuid }` (must be same tenant; analyte must equal mapped analyte or the user confirms `override_analyte: true`) | `{ exception, outcome, result? }` | R |
| 41 | POST `/ingest-exceptions/{exception_id}/reapply` | `reapplyIngestException` | `lab.result.enter` | `{}` | `{ exception, outcome }` | O |
| 42 | POST `/ingest-exceptions/{exception_id}/discard` | `discardIngestException` | `lab.result.enter` | `{ reason_code: Code (x-coded-set: lab.exception_discard_reasons), comment?: ≤300 }` | exception | O |

### 5.7 QC capture and holds

| # | Method + path | operationId | Permission | Request | Response | Idem |
|---|---|---|---|---|---|---|
| 43 | GET `/qc-results` | `listQcResults` | `lab.qc.capture` | query `instrument_id?`, `analyte_id?`, `instrument_result_time_from/_to`, cursor/limit | list | — |
| 44 | POST `/qc-results` | `captureQcResult` | `lab.qc.capture` | `{ centre_id: Uuid (must be in actor scope, else `403 auth.forbidden`), instrument_id, analyte_id, control_id_raw ≤64, control_lot_raw? ≤64, control_level? ≤16, value_numeric: DecimalString, unit_code?, instrument_result_time: IsoUtc }` | `QcResultDto` | R |
| 45 | GET `/qc-holds` | `listQcHolds` | `lab.result.read` | query `status` ∈ {active, released} | list | — |
| 46 | POST `/qc-holds/{hold_id}/release` | `releaseQcHold` | `lab.qc_hold.release` (CR-C5-004, privileged); extra code `auth.mfa_required` | `{ comment: 1..500 }` | hold | O |

#44 server-set columns (finding C5 #2): `source = 'manual'`, `entered_by_membership_id` = actor, `value_raw` = canonical text of `value_numeric` (the `DecimalString` as received), `received_at = ctx.now()`, `idempotency_key = 'manual:<qc_result_id>'` (the new row id), `mapping_status` NULL. `instrument_id` on #44 is validated only as a UUID: C5 cannot read `instruments` tables (R1). DECISION: C5 stores it as given and validates only format; C9 (Phase 2) treats unknown instrument ids as data errors. Flagged for CR if C7 exposes a port (06 §6). (The UI picker lists instruments from C7 E23 — 08 A13 D-14 — so users normally pick a known id.)

### 5.8 Configuration

| # | Method + path | operationId | Permission | Request | Response | Idem |
|---|---|---|---|---|---|---|
| 47 | GET `/settings` | `getLabSettings` | `lab.worklist.read` | — | `LabSettingsDto` | — |
| 48 | PUT `/settings` | `updateLabSettings` | `lab.config.manage` (CR, privileged); extra code `auth.mfa_required` | full mutable subset (§9.1) with `If-Match` | `LabSettingsDto` | O |
| 49 | GET `/delta-check-rules` | `listDeltaCheckRules` | `lab.result.read` | query `analyte_id?`, `is_active?` | list | — |
| 50 | POST `/delta-check-rules` | `createDeltaCheckRule` | `lab.config.manage` (privileged); extra code `auth.mfa_required` | `{ analyte_id, window_seconds 3600..31536000, abs_threshold?: DecimalString (> 0), pct_threshold?: DecimalString (> 0 and ≤ 1000), unit_code: Code, effective_from?: IsoUtc }` (≥1 threshold; the exclusive minimum 0 is checked in the handler — JSON Schema 3.0/3.1 common subset — and a violation is `400 common.validation_failed` with the field path, mirroring `delta_check_rules__abs__ck`/`__pct__ck`, finding C5 #27) | rule (version 1) | R |
| 51 | POST `/delta-check-rules/{rule_id}/versions` | `versionDeltaCheckRule` | `lab.config.manage` (privileged); extra code `auth.mfa_required` | as #50 minus analyte_id | rule (version n+1; previous gets `effective_to`) | R |
| 52 | POST `/delta-check-rules/{rule_id}/deactivate` | `deactivateDeltaCheckRule` | `lab.config.manage` (privileged); extra code `auth.mfa_required` | `{}` | rule | O |
| 53 | GET `/coded-sets/{set_name}` | `listLabCodedSet` | `lab.specimen.read` | path `set_name` ∈ {rejection_reasons, return_reasons, amendment_reasons, exception_discard_reasons} | `{ data: [{ code, display, sort_order, is_active, source: global|tenant }] }` | — |
| 54 | PUT `/coded-sets/{set_name}/codes/{code}` | `upsertLabCode` | `lab.config.manage` (privileged); extra code `auth.mfa_required` | `{ display: 1..120, sort_order: int, is_active: boolean }` | code | O |

### 5.9 DTO field allowlists (mappers, REQ-SEC-081)

| DTO | Fields | Role notes |
|---|---|---|
| `SpecimenDto` | id, version, barcode, order_id, registration_no, specimen_type_code, container_code, status, priority, centre_id, processing_centre_id, parent_specimen_id, replaces_specimen_id, is_active, collected_at, in_transit_at, received_at, rejected_at, rejection_reason_code, collection_barcode_unverified, label_print_count, tests [{test_id, test_code}] | `rejection_comment` only in `SpecimenDetailDto` for holders of `lab.specimen.reject` |
| `ResultDto` | id, version, order_id, order_item_id, specimen_id, test_id, analyte_id, analyte_code, status, origin, value_numeric, value_text, ordinal_code, unit_code, flag, reference_range_snapshot, range_unavailable_age_unknown (08 A17.1), delta {status, prev_value, abs, pct, prev_at}, critical {is_critical, critical_event_id}, calc {status, reason, provenance}, comment_codes, comment_text, on_hold, qc_review_required, unit_mismatch, instrument_id, instrument_flags, current_version_no, verified_at/by, approved_at/by, amendment | front_desk/centre roles never receive ResultDto (no `lab.result.read`). For `approved` rows, value, unit, flag, `reference_range_snapshot`, `range_unavailable_age_unknown`, `delta` and `critical` come from the current version (`lab.v_result_current` `cur_*`, finding C5 #10) |
| `patient_display` | full_name, age_sex, patient_code | from FrontdeskPort (`lab_display` purpose, CR-C5-003) — never stored by C5 |

## 6. Ports

### 6.1 Implemented: `LabPort` (03-IC §4.5 + 08 §4.14 additions; consumers += C4, C17)

```ts
getOrderResults(ctx, { orderId, scope: 'approved' | 'all_visible' }): Promise<OrderResults>;
getPendingTestsForBarcode(ctx, { instrumentId, barcode }): Promise<{ specimenId; priority; patient: { sex; ageDays? };
  tests: readonly { orderItemId; testId; analyteIds: readonly Uuidv7[] }[] }>;
ingestInstrumentResult(ctx, input: InstrumentResultInput): Promise<{ outcome: 'applied'|'duplicate'|'unmatched'|'rejected_state'|'held';
  resultId?; specimenId?; reasonCode? }>;
holdResultsSince(ctx, { instrumentId, analyteIds, since, qcRunId, reasonCode }): Promise<{ heldResultIds; reviewFlaggedResultIds }>;
submitModuleResult(ctx, input: SubmitModuleResultInput): Promise<SubmitModuleResultOutput>;
// added by 08 §4.14 (R1, R11):
//   SubmitModuleResultInput += amendment?: { reasonCode: Code; reasonText?: string /* ≤ 500, P3 */ }
//   ResultView += moduleRef?: { module: 'micro' | 'anatomic'; entityId; versionNo };  OrderResults.specimens[].barcode? (scope 'approved' only, P2)
getOrderItemProcessingState(ctx, { orderId }): Promise<readonly { orderItemId; removable: boolean; reasonCode?;
  processingStatus: 'not_started' | 'in_progress' | 'reported' | 'cancelled' }[]>;   // 08 A13 D-5
listPendingForInstrument(ctx, { instrumentId, receivedSince?, limit? /* ≤ 200 */, cursor? }):
  Promise<Page<{ specimenId; barcode; priority; patient: { sex; ageDays? }; tests: readonly { orderItemId; testId; analyteIds }[] }>>;
lookupSpecimens(ctx, input: SpecimenSelector): Promise<readonly SpecimenRef[]>;
  // SpecimenSelector = { barcode } | { specimenIds /* 1..200 */ } | { orderId; statuses? }
getAnalyteHistory(ctx, { patientId, analyteIds /* 1..100 */, before, since?, limitPerAnalyte /* 1..10 */, excludeOrderId?, includeLegacy? /* default false */ }):
  Promise<{ series: readonly { analyteId; points: readonly AnalyteHistoryPoint[] }[] }>;
```

| Method | Behaviour in C5 | Errors |
|---|---|---|
| `getOrderResults` | `approved`: latest version of approved reportable results only; `all_visible`: every non-cancelled result; asserts `lab.result.read` for `all_visible` (`auth.forbidden` otherwise, contract test 2). Returns `approvedSetHash` computed by `readiness.ts`. | `common.not_found` |
| `getPendingTestsForBarcode` | lookup by `(tenant, barcode)` under caller RLS (device → its centre, see 05-SCHEMA §3); requires `received`…`resulted` (and `lab_settings.host_query_requires_received = true` default; when false also `collected`/`in_transit`); returns order tests with ≥1 `pending`/`resulted` result whose analyte has an outbound map for `instrumentId` (cached, §10); performs S6 pick-up (status `in_process`) when specimen is `received`/`aliquoted`; `patient.ageDays` from snapshot | `lab.specimen_not_found`, `lab.specimen_not_receivable` |
| `ingestInstrumentResult` | §4.5 pipeline under caller ctx; approved target → `rejected_state` with `reasonCode: 'result_locked'`, never throws `lab.result_locked` (contract test 8; JSDoc fixed per CR-C5-008); a key stored as `unmatched`/`rejected_state` with an open exception is re-evaluated on replay and the exception closed on success (CR-C7-011, contract case 21) | `common.not_found` only for malformed tenant references |
| `holdResultsSince` | insert `lab.qc_holds` `ON CONFLICT (tenant_id, qc_run_id) DO NOTHING`; on first insert: `UPDATE results SET on_hold = true, hold_id` where instrument_id/analyte in list, status ∈ {resulted, verified}, `coalesce(instrument_result_time, resulted_at) >= since`; approved → `qc_review_required = true`; status `pending` results not affected (they have no value); hold stays `active` (new results for the pair arrive `held`) until `releaseQcHold`. Replays return the stored id lists. | — |
| `submitModuleResult` | per 03-IC §4.5 A1 semantics as changed by 08 A13 D-7: the submission creates/updates the `lab.results` row of the order item with `origin: 'module'`; that row holds `payloadRef` (`module_payload_*`) and `summaryText` (`module_summary_text`); `result_versions` rows are created only at approval (R6) and amendment (R7); output `versionNo` = `results.current_version_no` after the call (1 until first approval; n+1 for an amendment). A submission on a `pending`/`resulted` result is R2/R3; on a `verified` result C5 performs a system R5 (`reason_code = module_resubmitted`, verification row kind `returned`, mode `system`) followed by R3 in one transaction (verification cleared, result `resulted`). It validates test `workflowType ∈ {microbiology, anatomic, molecular}` else `lab.module_result_invalid`; idempotent on `idempotencyKey` (stored in `lab.module_submissions`); stale `payloadRef.versionNo` → `lab.module_result_stale`; approved result → amendment path (R7; needs `lab.result.amend` else `lab.result_locked`): `input.amendment` is **required** when the target result is `approved` (missing → `lab.amendment_reason_required`) and ignored otherwise; `reasonCode` must be an active code of `lab.v_amendment_reasons` (global + tenant); guards (08 R1, extended by 08 A17 D-61): `module_phase_progression` only when `payloadRef.module = 'micro'`, `reportPhase = 'final'` and the approved version being replaced was a `preliminary` submission (`results.module_report_phase`); `module_preliminary_update` only when `payloadRef.module = 'micro'`, `reportPhase = 'preliminary'` and the approved version being replaced was a `preliminary` submission (D-61; `lab.result.amend` still required, R1 unchanged); `supplementary_report` only when `payloadRef.module = 'anatomic'`; otherwise `lab.module_result_invalid`; the reason code/text go to `lab.result_versions.amendment_reason_*` and to `lab.result.amended.v1.amendment_reason_code`; `isCritical` → critical log + event (direction `abnormal`) | `lab.module_result_invalid`, `lab.result_locked`, `lab.result_invalid_transition`, `lab.module_result_stale`, `lab.amendment_reason_required` |
| `getOrderItemProcessingState` | for C4's item-removal guard (CR-C4-003) and C4's derived order status (03-IC §10.4, 08 A13 D-5); callers holding `frontdesk.order.read` or `frontdesk.order.edit`, or system; no PHI. Per order item: `removable` = no **non-rejected** specimen linked to the item has `received_at`, and no non-cancelled result of the item has status `resulted`/`verified`/`approved`; otherwise `removable: false` with `reasonCode` (first match): `'specimen_received'` when a non-rejected specimen of the item is received (D-5), else `'result_entered'` when a result of the item is `resulted` or later (08 A17.2 — covers existing-material items, which have no specimen) [CONV: precedence when both apply]. `processingStatus` (first match): `cancelled` = every `order_test` of the item is `cancelled`; `reported` = every non-cancelled `order_test` has `reported_at` (S10 consumer, §7.2); `not_started` = no specimen of the item received **and** no non-cancelled result of the item beyond `pending` (08 A17.2); otherwise `in_progress` | `common.not_found` |
| `listPendingForInstrument` | worklist download (CR-C7-005; BLOCKED B2 per instrument): received specimens of the device's centre with ≥ 1 `pending` result mapped outbound for `instrumentId`; excludes approved/cancelled; cursor page | `auth.forbidden` (non-device/system) |
| `lookupSpecimens` | no side effects; caller RLS. Users need `lab.specimen.read`; the `{orderId}` form is also allowed with `homecollection.visit.read` (C17 checks the assignment); system: tenant-wide; device: refused (`auth.forbidden`). Unknown/invisible → omitted. An old barcode of a recollected specimen resolves only to the old specimen (CR-C10-003 + CR-C17-002) | `auth.forbidden`, `common.validation_failed` (> 200 ids) |
| `getAnalyteHistory` | approved results only, latest version, `approvedAt ∈ [since, before)`, newest first, RLS-scoped; unknown patient → empty series; points carry `source: 'lis'`; `includeLegacy` is reserved (C18, DEFER B4) and returns no `legacy` points until C18 data exist (CR-C14-002) | `common.validation_failed` |

Contract cases (08 §4.14 additions to 03-IC §4.5 cases 1–20): (21) replay of an unmatched key after the fix → `applied`; (22) approved target + `amendment` → event carries the code; (23) approved target without `amendment` → `lab.amendment_reason_required`; `module_phase_progression` from `anatomic` → `lab.module_result_invalid`; (24) `approved` scope returns `specimens[].barcode`; (25) module result returns `moduleRef`; (26) `lookupSpecimens` omits other-tenant ids / old barcode resolves to the old specimen; (27) `{orderId}` form with `homecollection.visit.read`; (28) `getAnalyteHistory` never returns another patient's results; (29) `listPendingForInstrument` excludes approved/cancelled; (30) `getOrderItemProcessingState`: received specimen → `removable: false`. Added by 08 A13: (31) item whose only specimen is rejected without recollection → `removable: true`, `processingStatus: 'cancelled'` (D-5); (32) all items reported → `reported` (D-5); (33) `submitModuleResult` on a `verified` result → `resulted`, verification cleared (D-7); (34) `versionNo` = 1 before approval, n+1 after amendment (D-7). Added by 08 A17 D-61 (03-IC §4.5 numbering): (35) micro `preliminary` submission over an approved `preliminary` version with `amendment.reasonCode = 'module_preliminary_update'` → version n+1 and `lab.result.amended.v1` carries the code; (36) the same code with `reportPhase = 'final'`, or from `anatomic` → `lab.module_result_invalid`. C5-local cases for 08 A17.2 (not numbered in 03-IC yet): (A17.2-a) an existing-material item (no specimen) with a `resulted` result → `removable: false`, `reasonCode: 'result_entered'`, `processingStatus: 'in_progress'`; (A17.2-b) an item with no received specimen and only `pending` results → `removable: true`, `processingStatus: 'not_started'`.

### 6.2 Consumed

| Port | Methods | Notes |
|---|---|---|
| `CatalogPort` | `getTest` (incl. `usesExistingMaterial`; `AnalyteDefinition.ordinalSetValues` — 08 A13 D-9), `resolveOrderables`, `referenceRangeFor`, `criticalLimitsFor`, `mapInstrumentCode`, `resolveCommentCodes({codes, departmentId?, asOf?})` (C3 shape, CR-C5-001 merged into CR-C3-001; the comment picker uses C3's HTTP list `listCommentCodes`, not a port method), `getReferrer({ referrerId, purpose: 'display' })` (#36 referrer name) | in-process cache keyed `(tenant, method, input, catalogRevision)`; invalidated by `catalog.changed.v1` |
| `FrontdeskPort` | `getOrderSummary`, `getPatientDemographics` (purposes `result_evaluation`, `lab_display`, `label_print`), `getPatientDemographicsBatch` (CR-C5-003) | never cached beyond the request (PHI) |
| `IdentityPort` | `assertRole`, `getActor` (display names on verifications), `getTenantSettings` (`numbering` incl. `barcodePrefix`, `partialReleaseAllowed`, `autoVerificationEnabled`, `timezone`) | |
| `QualityPort` | `canAutoVerify` | only when `LIMS_LAB_AUTOVERIFY_HOOK_ENABLED=true`, for every instrument-origin save (not on hold, no unit mismatch), independent of the tenant switch — the decision (incl. `feature_disabled` when the tenant switch is off) is C9's (CR-C9-004); `allow` → R4 with `mode: auto`, actor system. Phase 1: flag false; in production the port is the phase stub (`deny` [`feature_disabled`], 02-CV §8.2, 08 R9) |

C5 does **not** call `NotificationPort` in Phase 1 (DECISION): clinician alerts are dispatched by C6 from `lab.critical_value.detected.v1`, recollection contact by C4 from `lab.specimen.rejected.v1`; calling it too would double-send.

## 7. Events

### 7.1 Produced (payloads exactly 03-IC §3.7–3.13)

| Event | Exact trigger in C5 | Idempotency key |
|---|---|---|
| `lab.specimen.status_changed.v1` | every specimen transition S1–S15 incl. roll-ups and new aliquot/recollection rows (one per specimen per transition) | `<specimen_id>:<to_status>:<specimen_version>` |
| `lab.specimen.rejected.v1` | commit of S11 (in addition to status_changed) | `<specimen_id>:rejected` |
| `lab.result.verified.v1` | R4 (manual or auto) | `<result_id>:verified:<result_version_no>:<result_row_version>` |
| `lab.result.approved.v1` | R6 (`result_version_no` = 1) | `<result_id>:approved:1` |
| `lab.result.amended.v1` | R7 (incl. formula-dependent amendments and A1 amendments) | `<result_id>:amended:<new_version_no>` |
| `lab.order.ready_for_report.v1` | §4.7 after approve/amend | `<order_id>:ready:<approved_set_hash>` |
| `lab.critical_value.detected.v1` | §4.3 step 4; A1 `isCritical` | `<result_id>:critical:<result_version_no>:<value_sha256_prefix16>` |

`value_sha256_prefix16` = first 16 hex chars of SHA-256 over the canonical value string (`n:<decimal>` / `o:<code>` / `t:<text>`) [CONV]. `processing_branch_id` and `order_item_ids` are always filled when known.

Conditionally absent fields (08 A13 P-5 / D-2, 03-IC §3.9): `lab.result.verified.v1` omits `specimen_id` iff the result has no specimen (`TestDefinition.usesExistingMaterial`, CR-C11-009) and carries `verified_by_membership_id` iff `mode = manual` (absent for `mode = auto`). The schema expresses the mode rule with `if`/`then`/`else`; the producer test covers a specimen-less result and an auto-verified result (both validate).

Consumers added by 08 A13 D-6: C4 consumes `lab.specimen.status_changed.v1` with `to_status = recollection_ordered` (late recollection via #10, after a rejection without recollection) and upserts its `recollection_required` order flag; C5 still emits no second `lab.specimen.rejected.v1` (AC-05.5).

### 7.2 Consumed

| Event | Handler (`services/worker/src/jobs/lab/consumers/<event>.ts`) | Idempotency / ordering |
|---|---|---|
| `frontdesk.order.created.v1` | §4.1 | inbox; order seq |
| `frontdesk.order.items_changed.v1` | unknown order → build the `lab.orders` row from `getOrderSummary` + `getPatientDemographics({ purpose: 'result_evaluation' })` (for `patient_sex`, `patient_age_days`), with `collection_mode` NULL (not in `OrderSummary`; filled when `order.created` arrives); added items → order_tests/results (attach to an active specimen with same type+container in `ordered`…`in_process`, else S1); removed → R8 + `order_tests.status = cancelled`; specimen with no active tests and not received → `is_active = false` | inbox; ignore if `items_version` ≤ stored |
| `frontdesk.order.cancelled.v1` | R8 for all non-approved results; inactivate un-received specimens; `lab.orders.lab_status = 'cancelled'` (unknown order → build the row as for `items_changed`, then cancel) | inbox |
| `instruments.result.received.v1` | §4.5 (system actor) | inbox + result-level key |
| `instruments.qc.received.v1` | insert `lab.qc_results` (source instrument) `ON CONFLICT (tenant_id, idempotency_key) DO NOTHING` | inbox + envelope `idempotency_key` |
| `catalog.changed.v1` | invalidate caches ≤ revision (an unknown `entity_type` — enum `x-extensible`, 08 R13 — invalidates all); if `entity_type = instrument_code_map` → enqueue `lab.reapply_unmapped_exceptions` | inbox |
| `quality.qc_run.rejected.v1` | `holdResultsSince({ instrumentId, analyteIds, since: hold_since, qcRunId, reasonCode: 'qc_run_rejected' })` | inbox + qc_run_id |
| `homecollection.collection.synced.v1` | per collection: S2 + S3 (§PRD AC-03.2); skip specimens not in `ordered` (log outcome); the optional `booking_id` (present iff the visit has `kind = 'booking'`, 08 A19 D-120, 03-IC §3.23) is tolerated and ignored — C5 matches specimens by barcode/specimen id only | inbox + client_mutation_id |
| `reporting.report.released.v1` (A8) | insert `lab.report_releases` (`report_kind` stored as received, no closed CHECK — 08 A13 P-4); then one rule (finding C5 #4, = PRD AC-18.3, 06 T-27): `final` / `amended` / `addendum` / any unknown value (02-CV §7.2: treated as `amended`) → S10 for the `approved` specimens of the payload's `order_item_ids` (all items of the order when the field is absent), and `order_tests.reported_at` for the `approved` order tests of those items; `partial` → the same, but only for the listed `order_item_ids` (absent → no change); `preliminary` → release recorded, no S10, no `reported_at`, board "Printed (preliminary)" | inbox; ignore older `version_no` for same report |

All consumers: max 10 attempts, built-in backoff, dead letter (02-CV §7.5); duplicate-delivery and stale-seq tests mandatory (02-CV §11.4).

## 8. Background jobs

| Task id | Trigger | Behaviour | Retries |
|---|---|---|---|
| `evt.lab.<event>` (9) | fan-out | §7.2 | 10 |
| `lab.reapply_exceptions_for_specimen` | enqueued in the receive tx (`job_key = specimen_id`) | re-run §4.5 for open exceptions with that barcode and reason ∈ {specimen_not_received, unknown_barcode} | 10 |
| `lab.reapply_unmapped_exceptions` | enqueued by catalog consumer (`job_key = tenant:revision`) | re-run §4.5 for open `unmapped_code` exceptions (≤500 per run [CONV], re-enqueue if more) | 10 |

No crontab in Phase 1 (pending ages are computed on read).

## 9. Configuration

### 9.1 Per tenant (`lab.lab_settings`, edited via #48)

| Key | Type | Default | Meaning |
|---|---|---|---|
| `label_width_mm` / `label_height_mm` | int 20..100 / 10..60 | 50 / 25 [CONV] | label size |
| `label_copies_default` | int 1..5 | 1 [CONV] | copies per specimen |
| `label_renderer` | `html_svg` | `html_svg` | only value allowed until a ZPL CR exists |
| `host_query_requires_received` | bool | true | host query only for received specimens |
| `ingest_auto_receive` | bool | false | instrument result on un-received specimen auto-receives |
| `critical_notification_blocks_approval` | bool | true | AC-13.5 |
| `recollection_default` | bool | true | pre-ticks "Recollect" on reject |
| `delta_check_enabled` | bool | true | master switch |
| `history_days` | int 30..3650 | 730 [CONV] | horizon for previous results / trend |

`auto_print_labels` is removed (08 A13 D-4): C4's `frontdesk.label_autoprint` decides whether the label page is opened after registration, and the label page always prints after render.

### 9.2 Global env (`config.ts`, `LIMS_LAB_*`)

| Env | Default | Purpose |
|---|---|---|
| `LIMS_LAB_AUTOVERIFY_HOOK_ENABLED` | `false` | Phase-2 switch for `QualityPort.canAutoVerify` |
| `LIMS_LAB_CATALOG_CACHE_MAX_ENTRIES` | `20000` [CONV] | LRU size per process |
| `LIMS_LAB_LABEL_WAIT_SECONDS` | `15` [CONV] | label page wait for specimens (web) |
| `LIMS_LAB_WORKLIST_MAX_ROWS` | `500` [CONV] | hard cap per worklist response set (cursor beyond) |

## 10. Performance targets

Inputs: 04 §14 (ASSUMPTION rows) — results 15,000–25,000/day/lab, analyser messages 1,500–3,000/day/lab, peak hour 25%, N = 10 labs, ~60 concurrent staff/lab.

| Path | Arithmetic | Target |
|---|---|---|
| Result applies (all origins) | 25,000 × 25% = 6,250/h/lab ≈ 1.74/s; × 10 labs ≈ 17.4/s | consumer throughput ≥ 35 results/s sustained (2× peak) [CONV]; `ingestInstrumentResult` ≤ 50 ms in-process (03-IC §4.5) |
| Event-to-applied lag | — | p95 ≤ 5 s from C7 commit to result `resulted` [CONV] |
| Host query | analyser waits "within ~seconds" (01 §3.1) | `getPendingTestsForBarcode` p95 ≤ 300 ms (03-IC §4.5) with warm code-map cache (20 analytes × cached lookup) |
| Specimen creation | orders 500 patients/day/lab; peak 125/h/lab; × 10 = 1,250/h ≈ 0.35/s | p95 ≤ 5 s from order commit to labels available [CONV] |
| Worklist / pending list | 15–25k results/day ⇒ open set < 25k rows/lab; partial indexes (REQ-ARCH-023) | p95 ≤ 300 ms for a page of 50 [CONV] |
| Bulk enter 200 rows | — | p95 ≤ 2 s incl. evaluation [CONV] |
| `getOrderResults` | 100 results | ≤ 80 ms (03-IC §4.5) |
| `holdResultsSince` | 1,000 results | ≤ 500 ms (03-IC §4.5) |
| `submitModuleResult` | — | ≤ 50 ms (03-IC §4.5) |
| API request rate | 6–12 req/s/lab (04 §14) | covered by general tier |

Load test uses the C0 seed generator at 1× and 10× (05-DoD §3.5).

## 11. Observability

Logs (02-CV §9): every handler/task logs ids only — never barcode, registration no, values, names, comments (02-CV §9.2). Ingest logs include `result_key_sha256` (hash, not the key — it contains the barcode).

| Metric | Type | Labels |
|---|---|---|
| `lims_lab_specimen_transitions_total` | counter | `to_status` |
| `lims_lab_specimen_creation_lag_seconds` | histogram | — |
| `lims_lab_results_ingested_total` | counter | `outcome` (applied/duplicate/unmatched/rejected_state/held/not_applicable) |
| `lims_lab_ingest_exceptions_open` | gauge | `reason`, `tenant_id` |
| `lims_lab_ingest_exception_age_seconds` | histogram | `reason` |
| `lims_lab_ingest_exception_oldest_open_age_seconds` | gauge (refreshed by the API process every 60 s [CONV]) | `reason`, `tenant_id` |
| `lims_lab_critical_unnotified_oldest_age_seconds` | gauge (refreshed every 60 s [CONV]; 0 when none open) | `tenant_id` |
| `lims_lab_result_transitions_total` | counter | `to_status`, `origin` |
| `lims_lab_critical_detected_total` | counter | `direction` |
| `lims_lab_critical_unnotified_open` | gauge | `tenant_id` |
| `lims_lab_formula_errors_total` | counter | `reason` |
| `lims_lab_host_query_duration_seconds` | histogram | `outcome` |
| `lims_lab_readiness_emitted_total` | counter | `completeness` |
| `lims_lab_barcode_alloc_failures_total` | counter | `reason` |

#### Alert rules for C1 (08 A13 P-14)

C5 keeps the rule file in its own path, `services/worker/src/jobs/lab/ops/lab.rules.yml` [CONV], and C1 wires it into `infra/` through **CR-C5-010** (§15). C1 adds only `team` and `runbook_url` (C1 02-TRD §11.3). Thresholds: open critical value 30 min [CONV; 01 §2.2 cites CLSI GP47 bands only as reference, not a default]; others [CONV].

| Alert | expr | for | severity | route (C1 receiver) |
|---|---|---|---|---|
| `LabCriticalValueUnnotified` | `max by (tenant_id) (lims_lab_critical_unnotified_oldest_age_seconds) > 1800` | 1m | page | `oncall-email` |
| `LabIngestExceptionStale` | `max by (tenant_id, reason) (lims_lab_ingest_exception_oldest_open_age_seconds) > 86400` | 5m | warn | `ops-digest-email` |
| `LabConsumerDeadLetter` | `increase(lims_core_dead_letters_total{task=~"(evt\\.)?lab\\..*"}[5m]) > 0` | 0m | page | `oncall-email` |
| `LabHostQuerySlow` | `histogram_quantile(0.95, sum by (le) (rate(lims_lab_host_query_duration_seconds_bucket[5m]))) > 0.3` | 15m | warn | `ops-digest-email` |
| `LabBarcodeAllocationFailure` | `increase(lims_lab_barcode_alloc_failures_total[5m]) > 0` | 0m | page | `oncall-email` |

#### CI jobs for C0-0A (08 A13 P-14)

None: C5 has no gate script of its own; its tests run in the standard module jobs.

#### Access log (08 A13 P-3 / D-11)

Audit: data changes via C0 triggers (04 D11). Every `ctx.audit.access` call, as operation → `action` → `entityType` [CONV: entityType names]; all six actions are in the 08 A13 D-11 seed (03-IC §13.1 / 08 §4.4 / C0 `audit.g_cs_access_actions`) and no other action is used by C5:

| Operation | `action` | `entityType` / `entityId` |
|---|---|---|
| #14 `printSpecimenLabels` (one row per specimen printed) | `specimen_label.print` | `specimen` / specimen id |
| #16 `listOrderResults` | `lab_result.view` | `order` / order id |
| #25 `getResultHistory`, #26 `getAnalyteTrend` | `lab_result_history.view` | `result` / result id (#25); `patient` / patient id (#26) |
| #36 `getCriticalValue`; #35 `listCriticalValues` (one row per call, no `entityId`, `detail.count` [CONV], because the list shows values) | `critical_value.view` | `critical_value` / critical event id (#36) |
| #22 `getWorksheet` (the worksheet page is the print view, 03-APP-FLOW §3.6) | `worksheet.print` | `worksheet` / worksheet id |
| #39 `getIngestException` (raw values) | `ingest_exception.view` | `ingest_exception` / exception id |

## 12. Error codes used

From 03-IC §8: `lab.specimen_not_found`, `lab.specimen_invalid_transition`, `lab.specimen_not_receivable`, `lab.rejection_reason_required`, `lab.barcode_duplicate`, `lab.result_invalid_transition`, `lab.result_locked`, `lab.result_value_invalid`, `lab.result_on_hold`, `lab.formula_inputs_missing` (returned only by `getResult` evaluation detail, not as an HTTP failure), `lab.self_approval_forbidden`, `lab.amend_requires_pathologist`, `lab.amendment_reason_required`, `lab.module_result_invalid`, `lab.module_result_stale`, `lab.critical_ack_required`, plus `common.*`/`auth.*`. New (CR-C5-005, accepted in 08 §4.2): `lab.barcode_pattern_invalid`, `lab.specimen_inactive`, `lab.flag_ack_required`. `lab.amendment_reason_required` is also returned by `submitModuleResult` (08 R1).

## 13. Test strategy

| Layer | What | Fakes |
|---|---|---|
| Unit | `specimen.state.ts` every allowed + forbidden example (03-IC §10.1 list), `result.state.ts`, `rollup.ts`, `barcode.ts` (patterns, overflow, charset), `flags.ts` boundaries (equal to limit = not flagged [DECISION: strict < / >]), `delta.ts`, `readiness.ts` hash vs fake spec, formula use through `@lims/shared-ts/formula` (shared vectors G1–G10 + C5 additions: Friedewald, A/G ratio, NLR; division by zero; `missing_input` → `waiting_for_inputs`; `inexact` flag — 08 R12a), mappers allowlists (Code 128 encoding is tested by the `BarcodeSymbol` kit component) | none |
| Integration | services + repos + RLS on migrated PG17 with seed tenants A/B; age-unknown evaluation (08 A17.1): `patient_age_days` NULL → ports called without `ageDays`; an age-unrestricted band → normal flag/critical; none → `range_unavailable_age_unknown = true` and `QualityPort.canAutoVerify` is not called (spy) | CatalogPort, FrontdeskPort, IdentityPort, QualityPort fakes from `@lims/fakes` |
| Contract — HTTP | every operation request/response validated against `lab.yaml`; one test per `x-error-codes` entry | — |
| Contract — port | `runLabPortContract` (03-IC §4.5 cases 1–20 + 08 cases 21–30 + 08 A13 cases 31–34 + 08 A17 D-61 cases 35–36 + C5-local A17.2-a/b, §6.1) on the real impl | other ports faked |
| Contract — events | each produced payload validates; each consumer: 03-IC example, unknown extra fields, duplicate `event_id`, stale `aggregate.seq` | — |
| Probes | §07-SECURITY §5 | — |
| Web | component tests with MSW 3.0.3; keyboard-only flows for receive, grid, verify | Prism/MSW from spec |
| E2E (nightly) | register → labels → collect → receive → instrument result (simulated event) → verify → approve → ready → release (C6 fake/real) → status "Printed"; reject → recollect; amend | compose stack |

## 14. Dependencies table (02-CV §15.1)

None added.

## 15. Change requests raised

> Status per `program/08-CR-REGISTER.md` (2026-11-06). CR texts below are kept as history.

| CR | Status |
|---|---|
| CR-C5-001 | MERGED in 08 into CR-C3-001 — `searchCommentCodes` not a port method: UI picker uses C3 HTTP list. |
| CR-C5-002 | MERGED in 08 into CR-C3-002 — C5 local grammar (ternary, \|\|/&&) dropped. |
| CR-C5-003 | ACCEPTED in 08 |
| CR-C5-004 | ACCEPTED in 08 |
| CR-C5-005 | ACCEPTED in 08 |
| CR-C5-006 | ACCEPTED in 08 |
| CR-C5-007 | ACCEPTED in 08 |
| CR-C5-008 | ACCEPTED in 08 |
| CR-C5-009 | MERGED in 08 into CR-C2-008 |
| 08 Addendum A2/A3 | 08 Addendum A2/A3 applied 2026-11-06 — A2.10: label-print-before-specimens conflict stays `409 common.version_conflict` with a detail message (§5 op 14a); no dedicated code. No other A2/A3 item affects C5. |
| CR-C5-010 | ACCEPTED in 08 A17.3 — C1 wires `services/worker/src/jobs/lab/ops/lab.rules.yml` (§11 "Alert rules for C1"); 08 §3 register row by the program sweep |
| CR-C5-011 | ACCEPTED in 08 A17.3 — 02-CV §4.1 allows bulk bodies `items[{id, version}]` (02-CV text by the program sweep) |
| CR-C5-012 | ACCEPTED in 08 A17.3 (= A17.1) — `RangeQuery.ageDays` optional; applied in the final sweep (§4.3 step 2, §4.5 step 11; C3 implements the matching) |
| Review fix pass | Review fix pass 2026-11-06 — review/C5-lab-workflow.md + 08 Addendum A13 applied (P-1, P-3, P-4, P-5, P-8, P-10, P-14, P-15; D-2, D-4, D-5, D-6, D-7, D-8, D-9, D-10, D-11, D-12, D-13, D-14, D-15). |
| Final sweep 2026-11-06 — second touch applied | Final sweep 2026-11-06 — second touch applied (`review/_triage-batch4.md` §(g) C5 group, plus the C5 halves of 08 A17.1/A17.2). **D-61**: seed `module_preliminary_update` ("Updated preliminary report") in `amendment_reasons`; `submitModuleResult` guard (micro, `reportPhase = 'preliminary'`, replacing an approved `preliminary` version; else `lab.module_result_invalid`); refused by `amendResult` #32 and not offered in the amend dialog; contract cases (35)–(36) (§5.4, §6.1, §13; 05-SCHEMA §2; PRD AC-17.5; 03-APP-FLOW §2.10; 04-UI-UX §3.6; 06 T-24; 07 S-21). **D-106 / CR-C16-022**: `lab.v_pub_specimen_timeline` appends `replaces_specimen_id`, `specimen_version` (05-SCHEMA §4 DDL + note; PRD AC-20.3; 06 §5). **CR-C7-014**: route `staff.lab.ingest_exceptions` noted (§15 CR-C5-007; 04-UI-UX §1; 06 T-23). **D-120**: optional `booking_id` on `homecollection.collection.synced.v1` tolerated (§7.2; PRD AC-03.2a; 06 T-09). **08 A17.2**: `getOrderItemProcessingState` — `not_started` also needs no result beyond `pending`; `removable: false` with `reasonCode: 'result_entered'` [CONV precedence] (§6.1; PRD AC-05.10; 06 T-24). **08 A17.1** (C5 half; needed so this TRD no longer states `ageDays` is required): ports called without `ageDays` when age is unknown; `range_unavailable_age_unknown` mark (new column on `results`/`result_versions`, `cur_*` in `v_result_current`), never auto-verified, screen text "Age unknown — reference range and critical check not applied" (§4.3, §4.5, §5.9, §13; 05-SCHEMA §3; PRD AC-08.8; 03-APP-FLOW E23; 04-UI-UX §3.6/§3.8; 06 T-12, T-16). CR statuses CR-C5-010/011/012 updated to ACCEPTED (08 A17.3). SQL changed (view + two columns + view column) loaded and checked on scratch PostgreSQL 16. |

**08 Addenda applied (08 A25 P-60: one row per addendum A1–A29; final check 2026-11-06)**

| Addendum | Status for C5 |
|---|---|
| A1 | not applicable |
| A2 | applied 2026-11-06 — A2.10 (TRD, PLAN) |
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
| A13 | applied 2026-11-06 — P-1, P-2, P-3, P-4, P-5, P-6, P-7, P-8, P-9, P-10, P-11, P-12, P-14, P-15, D-2, D-4, D-5, D-6, D-7, D-8, D-9, D-10, D-11, D-12, D-13, D-14, D-15 (PRD, TRD, AF, UI, SCH, PLAN, SEC) |
| A14 | not applicable |
| A15 | not applicable |
| A16 | applied 2026-11-06 — A16.2 (TRD) |
| A17 | applied 2026-11-06 — D-61, A17.1, A17.2, A17.3 (PRD, TRD, AF, UI, SCH, PLAN, SEC) |
| A18 | not applicable |
| A19 | applied 2026-11-06 — D-106, D-120 (PRD, TRD, SCH, PLAN) |
| A20 | not applicable |
| A21 | not applicable |
| A22 | not applicable |
| A23 | not applicable |
| A24 | not applicable |
| A25 | not applicable |
| A26 | not applicable |
| A27 | not applicable |
| A28 | not applicable |
| A29 | not applicable |



Template per `program/04-CHANGE-REQUESTS.md` §2. All designed as if accepted.

### CR-C5-001: `CatalogPort.resolveCommentCodes`
- From C5 → C0-0C (port) + C3 (implements). Type: port. Blocking: no (fake) — task T-18.
- Problem: US-10 (AC-10.1/10.2) — C5 must expand short codes server-side and store the library text; `CatalogPort` has no comment-code method; `catalog.changed.v1` already lists `comment_code`.
- Proposed: `resolveCommentCodes(ctx, input: { codes: readonly Code[]; asOf?: IsoUtc }): Promise<readonly { code: Code; text: string; version: number; isActive: boolean }[]>` — unknown codes omitted; plus `searchCommentCodes(ctx, { prefix: string; limit?: number })` for the UI picker. Fake: seeded codes incl. `HYPO`, `ANISO`. Contract tests: unknown omitted; inactive returned with `isActive false`; asOf returns older text.
- Backward compatible: yes (additive). Security: P0 (no PHI).

### CR-C5-002: Shared formula grammar + rational decimal in `@lims/shared-ts`
- From C5 → C0-0A (shared-lib); C3 must validate with the same parser. Type: shared-lib. Blocking: no (C5 keeps a local copy in `domain/formula/` until merged).
- Problem: US-09 — `AnalyteDefinition.formula.expression` has no defined grammar; C3 validates (`catalog.formula_invalid`) and C5 evaluates; two grammars would diverge.
- Proposed: `@lims/shared-ts/formula` (`parse`, `validate(expr, inputCodes)`, `evaluate(ast, inputs: Record<Code, DecimalString>) → { ok, value: Rational, inexact } | { ok: false, reason }`) with the grammar in §4.4 and `@lims/shared-ts/decimal` (BigInt rational, half-up rounding). Golden tests shared.
- Backward compatible: yes.

### CR-C5-003: FrontdeskPort purposes and batch read
- From C5 → C0-0C + C4. Type: port. Blocking: no.
- Problem: C5 needs sex/age for range and critical evaluation (US-12/13) and names on worklists/status board (US-07/18); existing purposes do not describe these uses (`instrument_host_query` has the right fields but the wrong purpose; REQ-SEC-081 purpose binding).
- Proposed: add `DemographicsPurpose` values `result_evaluation` (sex, ageAtOrder, birthOn) and `lab_display` (fullName, sex, ageAtOrder, patientCode); add `getPatientDemographicsBatch(ctx, { patientIds: readonly Uuidv7[] /* ≤200 */; purpose }): Promise<readonly PatientDemographics[]>` (missing/invisible ids omitted). Fake + contract tests: field allowlist per purpose; cross-tenant ids omitted.
- Backward compatible: yes (enum extension + new method). Security: PHI P2 returned only for authorised purposes.

### CR-C5-004: Permission codes
- From C5 → C0-0C (`contracts/permissions.yaml`). Type: api. Blocking: no (fake IdentityPort accepts configured codes).
- Proposed entries:
  - `{ code: lab.worksheet.manage, privileged: false, roles: [lab_technologist, lab_manager] }` — create worksheets (US-07).
  - `{ code: lab.config.manage, privileged: true, roles: [lab_manager, pathologist] }` — lab settings, delta rules, coded sets (US-12, IS-27).
  - `{ code: lab.qc_hold.release, privileged: true, roles: [lab_manager, pathologist] }` — release QC holds (IS-23).
- Security: privileged entries require aal2 (04 A4).

### CR-C5-005: Error codes
- From C5 → C0-0C (`contracts/errors.yaml`). Type: api.
- `{ code: lab.barcode_pattern_invalid, http: 500, owner: C5, title: "Barcode numbering configuration invalid", meaning: "Rendered barcode violates [A-Z0-9]{1,20} or counter overflow" }`
- `{ code: lab.specimen_inactive, http: 409, owner: C5, title: "Specimen inactive", meaning: "Order cancelled or test removed; specimen not usable" }`
- `{ code: lab.flag_ack_required, http: 409, owner: C5, title: "Flag acknowledgement required", meaning: "Delta/critical/unit/instrument flag must be acknowledged before verification" }`

### CR-C5-006: `reporting.report.released.v1` optional `order_item_ids`
- From C5 → C0-0C + C6 (producer agrees). Type: event (additive optional field).
- Problem: S10 (03-IC §10.1) needs to know which order items a **partial** release covers; the payload has no item list (AC-18.3).
- Proposed: `"order_item_ids": { "type": "array", "maxItems": 200, "items": Uuidv7 }` optional. Until merged: partial releases do not move specimens to `reported`.

### CR-C5-007: Routes
- From C5 → C0-0C (`contracts/routes.yaml`). Type: api.
- `- { id: staff.lab.order_labels, origin: staff_web, path: /lab/orders/{order_id}/labels, owner: C5, permission: lab.specimen.label_print }` — C4's registration page opens it after save (US-02; C4 owns that page, so the label screen must be C5's).
- `- { id: staff.lab.ingest_exception, origin: staff_web, path: /lab/ingest-exceptions/{exception_id}, owner: C5, permission: lab.result.read }` — C7 message screen links to the matching exception.
- List route (CR-C7-014, accepted in 08 A16.2): `- { id: staff.lab.ingest_exceptions, origin: staff_web, path: /lab/ingest-exceptions, owner: C5, permission: lab.result.read }` — the "Instrument exceptions" list screen (04-UI-UX §1, §3.10); C7 links to it with `@lims/shared-ts/routes`. C5 implements the page; the `contracts/routes.yaml` row is added by the 03-IC §7 / 08 §4.3 sweep.

### CR-C5-008: Documentation clarifications (lead / C0-0C)
- 02-CV §4.1 example `GET /v1/lab/specimens?barcode=…` puts a lab-linked identifier in a URL, conflicting with REQ-SEC-098 and 02-CV §9.2; C5 uses `POST /v1/lab/specimens/lookup`. Ask the lead to change the example.
- `LabPort.ingestInstrumentResult` JSDoc says it throws `lab.result_locked`; contract test (8) expects outcome `rejected_state`. C5 implements the contract test; ask C0 to align the JSDoc.

### CR-C5-009: Barcode prefix value
- From C5 → C0-0C + C2. Type: port (TenantSettings).
- Problem: the default barcode pattern `{prefix}{yy}{seq:7}` (03-IC §9.3) uses `{prefix}`, but `TenantSettings.numbering` carries patterns only, not prefix values.
- Proposed: `numbering.barcodePrefix?: string` (`[A-Z0-9]{0,4}`); until merged, `{prefix}` in a barcode pattern is rejected and tenants put the literal in the pattern.
- (History. Merged into CR-C2-008; the default pattern is now `{prefix}{yy}{seq:8}` — 08 A13 D-8 — and `{prefix}` is supported.)

### CR-C5-010: C5 alert rules (08 A13 P-14)
- From C5 → C1. Type: alert. Blocking: no.
- Proposed: C1 includes `services/worker/src/jobs/lab/ops/lab.rules.yml` (the five rules of §11 "Alert rules for C1", thresholds verbatim) in its Prometheus rule set, adding `team` and `runbook_url` (`infra/runbooks/lab.md#<alert>`). Replaces the C5 row of C1 02-TRD §11.3 "Imported rules".

### CR-C5-011: Bulk body form `items[{id, version}]` (finding C5 #25)
- From C5 → lead (02-CV §4.1). Type: docs.
- Problem: 02-CV §4.1 shows bulk bodies as `{ "ids": [...] }`; C5 bulk transitions need a per-id `version` for optimistic concurrency.
- Proposed: 02-CV §4.1 allows `{ "items": [{ "id", "version", … }] }` (≤ 200) as the bulk form for state transitions.

### CR-C5-012: Optional `RangeQuery.ageDays` (finding C5 #39)
- From C5 → C0-0C + C3. Type: port.
- Problem: `RangeQuery.ageDays` is required, so C5 cannot ask for a reference range or critical limits when the patient's age is unknown (03-APP-FLOW E23); today C5 skips both lookups and the result has no flag and no critical check.
- Proposed: `ageDays?: number`; when absent, C3 returns only age-agnostic bands/limits or `catalog.no_reference_range`. Contract case: age absent → age-agnostic band.
