# C10 Microbiology — 02 Technical Requirements (TRD)

Status: DECISION, 2026-11-06. Names of tables, endpoints, events, permissions and error codes follow 03-IC and 02-CV verbatim. Everything 03-IC lacks is in §15 "Change requests raised" and is designed as if accepted (marked **(CR-C10-nnn)**). Labels as in 01-PRD.

---

## 1. Owned paths (01 §3)

| Path | Content |
|---|---|
| `services/api/src/modules/micro/` | API module: manifest, handlers, service, domain, repository, mappers, tests |
| `services/worker/src/jobs/micro/` | worker manifest, consumers, tasks, cron |
| `apps/web/src/app/(staff)/micro/` | Next.js route segment (pages, `loading.tsx`, `error.tsx`) |
| `apps/web/src/features/micro/` | nav manifest, BFF server functions, components, hooks, forms, help, tests |
| `docs/manual/micro/` | user-manual pages |

C10 never edits `db/`, `contracts/`, `packages/*`, any `core/`. `05-SCHEMA.md` and §5 below are the specification C0 implements (`contracts/openapi/micro.yaml`, DDL, policies).

## 2. Stack and pinned libraries

| Component | Version | Source |
|---|---|---|
| Node.js | 26.x LTS, exact patch pinned by C0 | 02-CV §1.1 |
| TypeScript, Fastify, Next.js (App Router), test runner, browser automation | C0 pins | 02-CV §1.1 |
| `fastify-openapi-glue` | 4.12.0 (mounted by core) | 04 T7 |
| Graphile Worker | 0.18.0 (via worker core) | 04 S10, T7 |
| PostgreSQL | 17 (`supabase/postgres:17.6.1.136`) | 04 D9 |
| `openapi-typescript` / `openapi-fetch` | 7.13.0 / 0.17.0 (generated `@lims/api-client-ts`) | 04 T7 |
| MSW / Prism | 3.0.3 / 5.16.0 (tests, mocks) | 04 T7 |
| UUIDv7, logger, errors, crypto, B.S. dates, routes | `@lims/shared-ts` (B.S. via `bsdate`, wrapping `@remotemerge/nepali-date-converter` 1.2.7) | 02-CV §1.1, 04 D13 |
| Decimal comparison | `@lims/shared-ts/decimal` (C0-0A; 08 R12a — CR-C5-002 merged into CR-C3-002); until C0-0A ships it, `services/api/src/modules/micro/domain/decimal.ts` (BigInt scaled 10⁶, compare/parse only) and switch when it ships | DECISION |
| CSV parsing (breakpoint import) | **in-house** RFC 4180 subset parser in `services/worker/src/jobs/micro/csv/` (≈150 lines, no dependency) | DECISION: avoids a new dependency for one internal format |
| JSON Schema validation of snapshots | ajv instance provided by the API core (the same ajv fastify-openapi-glue uses) | 02-CV §4.7 |
| Upload + storage | core API `ctx.uploads.accept` (writes the object itself: `bucket` + `objectPath` are options — no separate `put`) and `ctx.storage.read` (C0-0D; 08 R12b, §4.13 — CR-C10-008 merged into CR-C2-011) with bucket `micro-imports`; CSV accepted with `allow: ['text/csv']`, `scan: 'not_applicable'` (UTF-8, no NUL; never rendered) | — |

New third-party dependencies: **none** (02-CV §15.1 table empty).

## 3. Internal architecture

### 3.1 Layers (02-CV §2.2)

```
handlers/<operationId>.ts          load object (RLS) → IdentityPort.assertRole(permission, centreId) → service → mapper
service/
  culture.service.ts               create/cancel from events, setup, plates, observations, reopen, cancel, reconciliation
  isolate.service.ts               create (numbering), identify, describe, withdraw, panel assignment
  ast.service.ts                   bulk record, preview interpretation, instrument upsert
  report.service.ts                snapshot build + LabPort.submitModuleResult (one tx)
  instrument-record.service.ts     store, resolve, map, apply, assign, ignore
  breakpoint.service.ts            import create, activate/retire/discard, lookup for suggestions
  config.service.ts                coded sets, protocols, panels, vocab maps, instrument defaults, settings
  chain.service.ts                 LabPort reads (status of the micro result line)
domain/
  culture.state.ts                 culture state table (03-APP-FLOW §2.1) — pure
  isolate.state.ts                 isolate state table — pure
  breakpoint-set.state.ts          set lifecycle — pure
  ast-value.ts                     raw value parser (§4.3) — pure
  interpretation.ts                category/standard/restriction validation (§4.4) — pure
  breakpoint-eval.ts               band evaluation (§4.5) — pure
  selection.ts                     protocol and panel precedence (§4.2) — pure
  snapshot.ts                      report snapshot + summary text builder (§4.6) — pure
  schedule.ts                      next read due / final due (§4.1) — pure
  decimal.ts                       (until C0-0A ships `@lims/shared-ts/decimal`, 08 R12a)
repository/
  cultures.repo.ts  plates.repo.ts  observations.repo.ts  isolates.repo.ts  ast.repo.ts
  reports.repo.ts   instrument-records.repo.ts  breakpoints.repo.ts  config.repo.ts  codedsets.repo.ts
mappers/  culture.dto.ts isolate.dto.ts ast.dto.ts report.dto.ts instrument-record.dto.ts breakpoint.dto.ts config.dto.ts
events/   publish.ts                (empty: C10 produces no events — 01 §5.1)
ports/    (none: C10 implements no port)
```

Worker (`services/worker/src/jobs/micro/`):

```
index.ts                                      WorkerManifest (§8)
consumers/lab.specimen.status_changed.v1.ts   → culture.service.onSpecimenStatusChanged
consumers/instruments.result.received.v1.ts   → instrument-record.service.onInstrumentResult
tasks/micro.breakpoint_import_validate.ts
tasks/micro.reconcile_chain_status.ts
tasks/micro.refresh_metrics.ts
tasks/micro.purge_instrument_records.ts      (08 A17 D-65)
csv/parser.ts  csv/breakpoint-file.ts         (pure; unit-tested)
cron.ts
```

Web (`apps/web/src/features/micro/`): `nav.manifest.ts`, `server/<operationId>.server.ts` (one per micro operation used, plus `lookupSpecimenByBarcode.server.ts`, `getSpecimen.server.ts`, `getPatient.server.ts`, `listLabCodedSet.server.ts` which call C5/C4 operations through the core API proxy with the user's session), `components/`, `forms/`, `hooks/`, `help/`, `__tests__/`.

### 3.2 Manifest

```ts
// services/api/src/modules/micro/index.ts
export const manifest: ModuleManifest = {
  name: 'micro',
  openapi: 'contracts/openapi/micro.yaml',
  handlers,                // every operationId of §5
  ports: {},               // C10 owns no port (01 §5.1)
  produces: [],            // C10 produces no event (01 §5.1)
};
```

## 4. Domain rules

### 4.1 Schedule (`schedule.ts`)

- `planted_at` from `setupCulture` (default `ctx.now()`; must be ≤ now and ≥ now − 72 h [CONV]).
- `next_read_due_at` = `planted_at + h` for the smallest `h` in `read_schedule_hours` such that `planted_at + h` > latest `plate_read.observed_at` (or > `planted_at` if none); NULL when the schedule is exhausted.
- `final_due_at` = `planted_at + final_no_growth_hours` (protocol) else `settings.default_final_no_growth_hours`.
- `hours_since_planting` on observations = `(observed_at − planted_at)` in hours, 2 decimals.
- "Read overdue" = status ∈ {incubating, growth_detected} and `next_read_due_at < now`.

### 4.2 Selection precedence (`selection.ts`)

Plating protocol (current versions, `is_active`): key (test_id + specimen_type_code) > (test_id, any type) > (any test, specimen_type_code) > (any, any). Keys are unique per tenant among active keys (`plating_protocol_keys__tenant_id_key__p_uq`), so there is no tie; a create/version whose `applies_to` key is already used by another protocol → `409 micro.code_duplicate` (§12). No match → caller supplies plates; schedule from settings.

AST panel (current versions, `is_active`), given isolate organism `o`, its group `g` (from `v_organisms`), culture site `s`: (o, s) > (o, any) > (g, s) > (g, any) > (any organism, s) > (any, any). Tie-break when several current panels share the winning level: lowest `code`, then lowest `id` [CONV: deterministic and needs no extra index; review m#29]. No match → `assignAstPanel` requires `ast_panel_id`; otherwise `400 common.validation_failed` path `/ast_panel_id` (08 A13 P-1).

### 4.3 AST raw value (`ast-value.ts`)

Input string is NFC-normalised and trimmed; stored unchanged in `raw_value` (≤ 32).

| Method | Grammar (after trim) | Parsed |
|---|---|---|
| `mic` | `^(<=|>=|≤|≥|<|>|=)?\s*([0-9]{1,6}(\.[0-9]{1,6})?)(\s*/\s*[0-9]{1,6}(\.[0-9]{1,6})?)?$` | `raw_qualifier` (`≤`→`<=`, `≥`→`>=`, none→`=`), `raw_numeric` = first number (the second number of a combination such as `8/4` is kept only in `raw_value`), `unit_code = ug_ml` |
| `zone_diameter` | `^(<=|>=|≤|≥|<|>|=)?\s*([0-9]{1,3}(\.[0-9]{1,2})?)$`, value ≤ 100 [CONV] | as above, `unit_code = mm` |
| `other` | any 1..32 chars | no numeric, no unit |

Failure → per-entry `micro.ast_value_invalid` (CR-C10-005). Qualifiers are never dropped ("≤0.25" is not 0.25 — 06-GLOSSARY "MIC").

### 4.4 Interpretation validation (`interpretation.ts`)

For an entry with a `category_code`:
1. `standard` ∈ {CLSI, EUCAST, ECOFF} and `standard_version` (1..32) present, else `micro.ast_standard_required`.
2. `(standard, category_code)` ∈ `g_cs_ast_interpretations` with `is_active`, else `micro.ast_category_not_allowed`.
3. If `g_ast_category_restrictions(standard, antibiotic_code)` exists, `category_code ∈ allowed_codes`, else `micro.ast_category_not_allowed` (CLSI colistin/polymyxin B → I/R only — 04 D14).
4. No code path compares categories across standards (06-GLOSSARY "CLSI vs EUCAST").

0. A `category_code` requires a `raw_value` (in the entry or already stored on the row), else per-entry `micro.ast_value_invalid` (review #11; DB CHECK `ast_results__category_needs_value__ck`).

Entries without a category are stored (raw value only) and block final submission when reportable.

### 4.5 Breakpoint suggestion (`breakpoint-eval.ts`, `breakpoint.service.lookup`)

Preconditions: `settings.manual_ast_standard = S` is set; method `zone_diameter` with `zone_suggestion_enabled`, or `mic` with `mic_suggestion_enabled` (default false — KEEP-LATER, 01 §2.3); `other` never.

1. **Set**: `breakpoint_sets` with `standard = S`, status ∈ {active, retired}, `effective_from ≤ t < coalesce(effective_to, +∞)`, `t = ctx.now()`. None → `{ suggestion: 'none', reason: 'no_active_set' }`.
2. **Row**: rows of that set with `antibiotic_code`, `method`; `qualifier_code` equal to the request's `qualifier_code` (rows with a qualifier never match a request without one). Rank: scope `organism` with code = isolate organism (3) > `group` with code = organism's group (2) > `any` (1); within the same rank, `specimen_site_code` = culture site beats NULL. Rows with a different non-NULL site are excluded (04 L24 site dimension UNVERIFIED — kept in the key). None → `reason: 'no_row'`.
3. **Interval** of the true value from the parsed entry: `=` → [v, v]; `<=` → [0, v]; `<` → [0, v); `>=` → [v, +∞); `>` → (v, +∞).
4. **Band**: the unique band whose interval (NULL bound = unbounded; inclusivity flags respected) contains the whole value interval. None → `reason: 'indeterminate'` (gap, or qualifier interval spanning bands).
5. Output `{ suggestion: { category_code, standard: S, standard_version: set.standard_version, breakpoint_set_id, breakpoint_band_id } }`. Never persisted by preview; persisted only by `recordAstResults` when the client sends `accept_suggestion: true` with the same `breakpoint_band_id`, which the server re-evaluates (mismatch → per-entry `code: common.validation_failed`, `path: /entries/<n>/breakpoint_band_id`; M12).

Decimal comparisons are exact (scaled BigInt), never IEEE floats.

### 4.6 Report snapshot (`snapshot.ts`)

Built inside `submitCultureReport` from the current working rows:

- `isolates[]`: isolates with `status = identified`, `is_reportable`, ordered by `isolate_seq`; keys `seq, organism_code, organism_display` (display from `v_organisms` at submit time), `growth_text` (05-SCHEMA §6 rule).
- `ast[]`: rows of those isolates with `is_reportable`, `report_visibility = shown`, `category_code` and `raw_value` present (the CHECK makes the second implied; review #11); keys per 05-SCHEMA §6; `antibiotic_display` snapshotted.
- Size guard (review m#28): when the snapshot would hold more than 20 isolates or more than 600 AST rows (05-SCHEMA §6 `maxItems`, DB CHECK), the submission fails with `422 micro.report_incomplete` and `errors[]` (`path: /isolates` or `/ast`, `code: too_many_items`) before ajv runs; ajv failure therefore stays a programming error.
- `culture_summary_text`: client-supplied (1..4000) or generated [CONV]: line 1 `Final: <outcome display>` or `Preliminary report`; then `Gram stain: <latest gram_stain finding_text>` if any; then `Isolate <seq>: <organism display>[ — <growth_text>]` per snapshot isolate; for a preliminary with no isolate and latest read `no_growth`: `No growth after <floor(hours_since_planting)> h`. Lines joined with `\n`; truncated to 4000 with `…`.
- `submission_kind`: `ast_panel` if `ast[]` non-empty, else `organism` if `isolates[]` non-empty, else `structured` (03-IC §4.5 `kind`).
- `flag`: final → `culture_outcomes.result_flag`; preliminary → `A` if `isolates[]` non-empty or any `plate_read` with `indicates_growth`, else `N`.
- `is_critical`: from the request (UI pre-ticks it when any snapshot organism has `is_alert = true`).
- `version_kind`: `initial` (first version), `amendment` (an `amendment` object is sent to C5 — culture `amending`, or C5 result `approved`, including the automatic `module_phase_progression` / `module_preliminary_update` reasons of §4.7), else `update`.
- Validated with ajv against the 05-SCHEMA §6 schemas before insert; failure = `500 common.internal` (programming error, logged without content).

### 4.7 Submission transaction (`report.service.submit`)

```
ctx.db.tx(async (tx) => {
  culture = cultures.repo.lockForUpdate(tx, id)               // SELECT … FOR UPDATE; If-Match on culture.version
  guard state + completeness (03-APP-FLOW §2.1 C6/C7, PRD AC-09/10)
  chain = LabPort.getOrderResults({ orderId, scope: 'all_visible' })  → micro result line status (§7.1)
  amendment = needs? (culture.amending || chain.status === 'approved') → { reasonCode, reasonText? } required:
              amending                                                          → culture.amendment_reason_code / _text
              !amending && approved && last approved phase = preliminary && new phase = final       → auto 'module_phase_progression'
              !amending && approved && last approved phase = preliminary && new phase = preliminary → auto 'module_preliminary_update'
                                                                                                       (08 A17 D-61)
              // C5 guards (08 R1 + D-61): module_phase_progression only for payloadRef.module = 'micro', reportPhase = 'final';
              // module_preliminary_update only for module = 'micro', reportPhase = 'preliminary'; both only when the approved
              // version being replaced was a 'preliminary' submission; otherwise lab.module_result_invalid.
              // C7 (amending → preliminary) stays forbidden (409 micro.culture_invalid_transition).
              // "last approved phase" = report_versions.report_phase of the row whose version_no = chain.moduleRef.versionNo
              // (ResultView.moduleRef, 03-IC §4.5 — the approved payloadRef)
  vNo = culture.current_report_version_no + 1
  snap = buildSnapshot(...); validate(snap)
  out = LabPort.submitModuleResult(ctx, {
          orderItemId: culture.order_item_id, kind: snap.submission_kind, reportPhase,
          payloadRef: { module: 'micro', entityId: culture.id, versionNo: vNo },
          summaryText: snap.culture_summary_text, flag: snap.flag, isCritical: snap.is_critical,
          submittedAt: ctx.now(), idempotencyKey: `micro:${culture.id}:${vNo}`,
          amendment /* CR-C10-001 (08 R1): { reasonCode, reasonText? }; omitted when the target is not approved */ })
  report_versions.insert({ …snap, version_no: vNo, lab_result_id: out.resultId, lab_result_version_no: out.versionNo,
                           // out.versionNo = results.current_version_no (1 until first approval; n+1 after an amendment — 08 A13 D-7)
                           amendment_reason_code: amendment?.reasonCode, amendment_reason_text: amendment?.reasonText,   // review #35
                           lab_status_at_submit: out.status, lab_replayed: out.replayed, signed_by_membership_id: actor.membershipId,
                           signed_at: ctx.now() })
  cultures.update(current_report_version_no = vNo, last_report_phase, status per C6/C7/C9, outcome_code (final), version+1)
  culture_transitions.insert(...) when status changes
  audit.access(...) not needed (write audited by trigger)
})
```

Any `LimsError` from the port propagates (08 A17 P-23: the handler rethrows the original `LimsError` and never constructs it; C5 codes pass through: `lab.result_locked` 409, `lab.result_invalid_transition` 409, `lab.module_result_invalid` 422, `lab.module_result_stale` 409, `lab.amendment_reason_required` 422, `auth.mfa_required` 403) and the whole transaction rolls back (02-CV §8.1: ports run in the caller's transaction).

Report label (08 R1 + A17 D-61, C6 report-kind rule): sections whose amendment reason is `module_phase_progression` or `module_preliminary_update` do not by themselves make the report "Amended" (a final prints "Final", an updated preliminary prints "Preliminary"); any other amendment reason after a released version prints "Amended".

### 4.8 Instrument record handling (`instrument-record.service`)

1. Store (consumer): insert `instrument_records` with `ON CONFLICT (tenant_id, idempotency_key) DO NOTHING` (event `idempotency_key` = 04 N10 result-level key); conflict → done. Stored fields = the 05-SCHEMA §8 columns: `event_id`, `idempotency_key`, `instrument_message_id`, `instrument_id`, `centre_id`, `sample_barcode`, `record_kind`, `instrument_analyte_code`, `isolate_seq` (payload `organism.isolate_seq`/`ast.isolate_seq`), `organism_code_raw`, `organism_code` (mapped, when present), `antibiotic_code_raw`, `antibiotic_code` (mapped, when present), `method`, `raw_value`, `interpretation_raw`, `standard`, `standard_version`, `instrument_result_time`, `received_at`, `is_rerun` (review m#24). `mapping_status`, `processing_kind`, `instrument_flags`, `protocol` are not stored (C10 re-derives mapping from the stored mapped codes and its own vocabulary maps).
2. Resolve specimen: if `LabPort.lookupSpecimens` is enabled (CR-C10-003, accepted in 08 §4.14; feature flag `LIMS_MICRO_SPECIMEN_LOOKUP_PORT` until C5 ships it), call `{ barcode: sample_barcode }`; 1 result → `specimen_id`; else `pending_match` (`match_reason`: `lookup_unavailable`, `unknown_barcode`).
3. Resolve culture: non-cancelled cultures of that specimen; 0 → `pending_match` (`no_culture`), >1 → `pending_match` (`multiple_cultures`). Culture `final_submitted` → `late_after_final`.
4. Map vocabulary: if the stored mapped `organism_code`/`antibiotic_code` (from the event) exists in `v_organisms`/`v_antibiotics`, that wins; else `instrument_vocab_maps(instrument_id, kind, code_raw)`; else `needs_mapping`. Because the mapped code is stored, a deferred `assign`/`apply` (step 7) gives the same outcome as an immediate apply (review m#24).
5. Apply organism: isolate number = the `<isolate_seq>` segment of `instrument_analyte_code` (`ORG:<n>` / `AST:<n>:<antibiotic_code_raw>:<method>`, C7 driver rule, 08 R13; the payload's `isolate_seq` carries the same value); a number > 99 → `pending_match` with `match_reason = isolate_seq_out_of_range` (DB limit `isolates__seq__ck`; review m#28); isolate = (specimen, that number or 1 when absent and the culture has ≤ 1 isolate); absent → create with that seq and `counter = greatest(counter, seq)`; isolate `pending_id` → identify (`organism_source = instrument`); same organism → no-op; different organism with `organism_source = manual` → `conflict` (`organism_differs`).
6. Apply AST: isolate as in 5 (absent → `pending_match` `isolate_missing`); upsert `(isolate, antibiotic, method)`: none → insert (`source = instrument`, `off_panel` if not in panel); existing `source = instrument` → replace when incoming `instrument_result_time` ≥ stored (else, for an older rerun: `match_status = ignored`, `ignore_reason_code = duplicate`); existing `source = manual` with a value → `conflict` (`manual_value_exists`). Standard: payload `standard` ∈ {CLSI, EUCAST, ECOFF} → `standard_source = instrument_payload`; else instrument default → `instrument_default`; else `unknown`. Category: `interpretation_raw` upper-cased equals a code of that standard → `category_code`, `interpretation_source = instrument`; else NULL.
7. `assign`/`apply` endpoints run steps 3–6 with the user's choice; `resolution = use_instrument` overwrites a conflicting manual value/organism (audited); `keep_existing` → `ignored` (`kept_manual`).
8. Expiry (08 A17 D-65): whenever `match_status` becomes `applied` or `ignored`, the same UPDATE sets `expires_at = now() + TenantSettings.retention.rawInstrumentYears years` (read once per request/job through `IdentityPort.getTenantSettings({ keys: ['retention'] })`, §7.1).

The 04 N10 key does not include the isolate: two isolates with the same antibiotic and timestamp would collide **unless the driver encodes the isolate in `instrument_analyte_code`** — required of the C7 ID/AST driver by CR-C10-007 (accepted, 08 R13; 04 N10 unchanged). C10 parses the composite code; a code that does not match `ORG:<n>` / `AST:<n>:<code>:<method>` is treated as an isolate number absent.

## 5. HTTP endpoints (spec for `contracts/openapi/micro.yaml`)

All: prefix `/v1/micro`, security `bearerJwt` (via BFF), `tags: [micro]`, `x-rate-limit-tier: general` (04 §4: 10 req/s/user, burst 20), problem+json, `additionalProperties: false`, no `null` on the wire, cursor pagination (`limit` default 50, max 200). Common errors on every operation (not repeated): `common.validation_failed`, `common.not_found`, `auth.unauthenticated`, `auth.forbidden`, `common.rate_limited`, `common.internal`; actions additionally `common.version_conflict`, `common.precondition_required`. **`If-Match`** (review m#16) is required on M3, M5, M8–M11, M17, M18, M20–M22, M24 (when the code exists), M27, M28, M31, M32, M35, M36, M38 (when the row exists), M40, M46–M48 — the version of the path object (culture, plate, isolate, instrument record, code row, protocol, panel, vocabulary map, AST default, settings, breakpoint set). It is **not** used on creates under a culture (M4, M6, M7, M14: the culture row is locked `FOR UPDATE` in the transaction instead, so parallel creates serialise without `version_conflict` — 06 T-09), on M12 (per-entry `version` on existing AST rows), on M26, M30, M34, M42 (new objects) or on M13. Idempotency column: **R** required, **O** optional (02-CV §4.5; 08 A13 P-8: required on every POST that creates state, including action POSTs that insert child rows). Permission codes marked (CR) are in CR-C10-004.

### 5.1 Cultures

| # | Method + path | operationId | Permission | Request | Response | Extra codes | Idem |
|---|---|---|---|---|---|---|---|
| M1 | GET `/cultures` | `listCultures` | `micro.culture.read` | query `status` csv, `specimen_id`, `order_id`, `centre_id`, `received_at_from`/`_to`, `read_overdue` bool, `has_open_instrument_records` bool, `updated_at_from`, `include_total` bool (count capped at 10,000 [CONV]; partial-index count), `sort` ∈ {`received_at`, `-received_at`, `next_read_due_at`, `-updated_at`}, `cursor`, `limit` | `{ data: CultureSummaryDto[], page }` (+ `page.total` when `include_total`) | `common.invalid_cursor` | — |
| M2 | GET `/cultures/{culture_id}` | `getCulture` | `micro.culture.read` | — | `CultureDetailDto` | — | — |
| M3 | POST `/cultures/{culture_id}/setup` | `setupCulture` | `micro.culture.work` | `{ plating_protocol_id?: Uuid, specimen_site_code?: Code, planted_at?: IsoUtc, plates?: [{ media_code: Code, incubation_text?: ≤120 }] 1..12 }` (plates required when no protocol resolves) | `CultureDetailDto` | `micro.culture_invalid_transition` | **R** (creates plates; P-8) |
| M4 | POST `/cultures/{culture_id}/plates` | `addCulturePlate` | `micro.culture.work` | `{ media_code, incubation_text?, parent_plate_id?, source_isolate_id?, planted_at? }` | `PlateDto` | `micro.report_final_locked`, `micro.culture_invalid_transition` | R |
| M5 | POST `/cultures/{culture_id}/plates/{plate_id}/discard` | `discardCulturePlate` | `micro.culture.work` | `{}` | `PlateDto` | as M4 | O |
| M6 | POST `/cultures/{culture_id}/observations` | `recordCultureObservation` | `micro.culture.work` | `{ kind: plate_read|gram_stain|microscopy|other, plate_id?, growth_code?: Code, quantity_text?: ≤80, finding_text?: 1..2000, observed_at?: IsoUtc, corrects_observation_id? }` | `{ observation: ObservationDto, culture: CultureSummaryDto }` | as M4 | R |
| M7 | POST `/cultures/{culture_id}/isolates` | `createIsolate` | `micro.culture.work` | `{ plate_id?, colony_description?: ≤500, quantity_text?: ≤80, organism_code?: Code }` | `IsolateDto` | `micro.organism_code_unknown`, as M4 | R |
| M14 | POST `/cultures/{culture_id}/report-versions` | `submitCultureReport` | `micro.culture.work` | `{ report_phase: preliminary|final, outcome_code?: Code (final: required), culture_summary_text?: 1..4000, comments_text?: ≤4000, is_critical: boolean, early_final_reason?: 1..500 }` | `ReportVersionDto` (201) | `micro.report_incomplete` (incl. the §4.6 size guard), `micro.ast_standard_required`, `micro.culture_invalid_transition`, `micro.amendment_reason_required`; pass-through `lab.result_locked`, `lab.result_invalid_transition`, `lab.module_result_invalid`, `lab.module_result_stale`, `lab.amendment_reason_required`, `auth.mfa_required` | **R** |
| M15 | GET `/cultures/{culture_id}/report-versions` | `listCultureReportVersions` | `micro.culture.read` | — | `{ data: ReportVersionSummaryDto[] }` | — | — |
| M16 | GET `/cultures/{culture_id}/report-versions/{version_no}` | `getCultureReportVersion` | `micro.culture.read` | path `version_no` int ≥1 | `ReportVersionDto` | — | — |
| M17 | POST `/cultures/{culture_id}/reopen` | `reopenCulture` | `micro.culture.work` | `{ amendment_reason_code: Code (x-coded-set: lab.amendment_reasons), amendment_reason_text?: ≤500 }` — validated by C5 at submission; C10 checks format only (08 A17 D-62). The UI/BFF offers C5's `amendment_reasons` (global + tenant, `listLabCodedSet`) minus the system codes `module_phase_progression`, `module_preliminary_update`, `supplementary_report`. An invalid code surfaces at M14 as pass-through `422 lab.module_result_invalid` and the culture stays `amending` | `CultureDetailDto` | `micro.amendment_reason_required`, `micro.culture_invalid_transition` | O |
| M18 | POST `/cultures/{culture_id}/cancel` | `cancelCulture` | `micro.culture.work` | `{ reason_code: Code (x-coded-set: micro.culture_cancel_reasons; not the system codes), comment?: ≤500 }` | `CultureSummaryDto` | `micro.culture_invalid_transition` (any submitted version, unless C5 status is `cancelled`) | O |

### 5.2 Isolates and AST

| # | Method + path | operationId | Permission | Request | Response | Extra codes | Idem |
|---|---|---|---|---|---|---|---|
| M8 | POST `/isolates/{isolate_id}/identify` | `identifyIsolate` | `micro.culture.work` | `{ organism_code: Code }` | `IsolateDto` | `micro.organism_code_unknown`, `micro.isolate_invalid_transition`, `micro.report_final_locked` | O |
| M9 | POST `/isolates/{isolate_id}/describe` | `describeIsolate` | `micro.culture.work` | `{ colony_description?: ≤500, quantity_text?: ≤80, is_reportable: boolean, plate_id? }` (full replace of these fields; omitted optional = cleared) | `IsolateDto` | as M8 | O |
| M10 | POST `/isolates/{isolate_id}/withdraw` | `withdrawIsolate` | `micro.culture.work` | `{ reason_code: Code (x-coded-set: micro.isolate_withdraw_reasons), comment?: ≤500 }` | `IsolateDto` | `micro.isolate_invalid_transition`, `micro.report_final_locked` | O |
| M11 | POST `/isolates/{isolate_id}/ast-panel` | `assignAstPanel` | `micro.culture.work` | `{ ast_panel_id?: Uuid, method?: mic|zone_diameter|other }` | `IsolateDto` (with `ast[]`) | `micro.isolate_invalid_transition` (not identified), `micro.report_final_locked` | **R** (creates pending AST rows; P-8) |
| M12 | POST `/isolates/{isolate_id}/ast-results/bulk-record` | `recordAstResults` | `micro.culture.work` | `{ entries: [{ antibiotic_code: Code, method, raw_value?: 1..32, category_code?: ≤8, standard?: CLSI|EUCAST|ECOFF, standard_version?: 1..32, accept_suggestion?: boolean, breakpoint_band_id?: Uuid, qualifier_code?: Code, is_reportable?: boolean, add_to_isolate?: boolean, version?: int }] 1..60 [CONV] }` | `{ results: [{ antibiotic_code, method, outcome: ok|error, code?, path?: JsonPointer, ast_result?: AstResultDto }] }` (per-entry; partial success committed) | per entry: `micro.ast_value_invalid` (syntax/range, or a category without a raw value — §4.4 rule 0), `micro.ast_standard_required`, `micro.ast_category_not_allowed`, `micro.antibiotic_not_in_panel`, `common.validation_failed` (suggestion mismatch, §4.5 step 5), `common.version_conflict`; whole request: `micro.report_final_locked` | **R** |
| M13 | POST `/isolates/{isolate_id}/ast-results/interpret` | `previewAstInterpretation` | `micro.culture.work` | `{ entries: [{ antibiotic_code, method, raw_value, qualifier_code? }] 1..60 }` | `{ results: [{ antibiotic_code, method, suggestion?: { category_code, standard, standard_version, breakpoint_set_id, breakpoint_band_id }, reason?: no_active_set|no_row|indeterminate|disabled|value_invalid }] }` | — | none (no state) |

### 5.3 Instrument records

| # | Method + path | operationId | Permission | Request | Response | Extra codes | Idem |
|---|---|---|---|---|---|---|---|
| M19 | GET `/instrument-records` | `listMicroInstrumentRecords` | `micro.culture.read` | query `match_status` csv (default open statuses), `culture_id`, `instrument_id`, `received_at_from`/`_to`, `sort` ∈ {`-received_at`, `received_at`}, cursor/limit | `{ data: InstrumentRecordDto[], page }` | `common.invalid_cursor` | — |
| M20 | POST `/instrument-records/{record_id}/assign` | `assignMicroInstrumentRecord` | `micro.culture.work` | `{ culture_id: Uuid, isolate_seq?: 1..99, resolution?: use_instrument|keep_existing }` (`isolate_seq` chooses an existing or new isolate number for this record — §13) | `InstrumentRecordDto` | `micro.instrument_record_conflict`, `micro.report_final_locked` | **R** (may create an isolate / AST row; P-8) |
| M21 | POST `/instrument-records/{record_id}/apply` | `applyMicroInstrumentRecord` | `micro.culture.work` | `{ resolution?: use_instrument|keep_existing }` | `InstrumentRecordDto` | as M20 | **R** (may create an isolate / AST row; P-8) |
| M22 | POST `/instrument-records/{record_id}/ignore` | `ignoreMicroInstrumentRecord` | `micro.culture.work` | `{ reason_code: Code (x-coded-set: micro.record_ignore_reasons), comment?: ≤300 }` (stored in `instrument_records.ignore_comment`) | `InstrumentRecordDto` | `micro.instrument_record_conflict` (already applied) | O |

### 5.4 Configuration

| # | Method + path | operationId | Permission | Request | Response | Idem |
|---|---|---|---|---|---|---|
| M23 | GET `/coded-sets/{set_name}` | `listMicroCodedSet` | `micro.culture.read` (08 A17 D-64; `lab_manager` holds it) | path `set_name` ∈ {organisms, organism_groups, antibiotics, media, specimen_sites, growth_codes, culture_outcomes, isolate_withdraw_reasons, culture_cancel_reasons, record_ignore_reasons, ast_interpretations}; query `include_inactive` bool, `q` (prefix ≤ 40, for organism/antibiotic search) | `{ data: [{ code, display, sort_order, is_active, source: global|tenant, …set extras }] }` (`ast_interpretations` adds `standard`) | — |
| M24 | PUT `/coded-sets/{set_name}/codes/{code}` | `upsertMicroCode` | `micro.config.manage` (CR) | `{ display: 1..200, sort_order: int, is_active: boolean, …extras of the set }` (`ast_interpretations` not allowed → `403 auth.forbidden`) | code row | O |
| M25 | GET `/plating-protocols` | `listPlatingProtocols` | `micro.culture.read` (D-64) | query `include_superseded` bool, `is_active` | `{ data: PlatingProtocolDto[] }` | — |
| M26 | POST `/plating-protocols` | `createPlatingProtocol` | `micro.config.manage` | `{ code, display: 1..120, read_schedule_hours: int[1..10] ascending 1..720, final_no_growth_hours: 1..720, requires_gram_stain: boolean, default_specimen_site_code?, media: [{ media_code, incubation_text? }] 1..12, applies_to: [{ test_id?, specimen_type_code? }] 0..50 }` | `PlatingProtocolDto` (201); code already used, or an `applies_to` key already used by another active protocol → `409 micro.code_duplicate` | R |
| M27 | POST `/plating-protocols/{protocol_id}/versions` | `versionPlatingProtocol` | `micro.config.manage` | as M26 minus `code` | new version (previous gets `superseded_at`); `applies_to` key clash → `409 micro.code_duplicate` | R |
| M28 | POST `/plating-protocols/{protocol_id}/deactivate` | `deactivatePlatingProtocol` | `micro.config.manage` | `{}` | `PlatingProtocolDto` | O |
| M29 | GET `/ast-panels` | `listAstPanels` | `micro.culture.read` (D-64) | query `include_superseded`, `organism_code`, `organism_group_code` | `{ data: AstPanelDto[] }` | — |
| M30 | POST `/ast-panels` | `createAstPanel` | `micro.config.manage` | `{ code, display: 1..120, organism_code?, organism_group_code?, specimen_site_code?, default_method, antibiotics: [{ antibiotic_code, method?, is_reported_default }] 1..60 (order = sort order) }` | `AstPanelDto` (201); code already used → `409 micro.code_duplicate` | R |
| M31 | POST `/ast-panels/{panel_id}/versions` | `versionAstPanel` | `micro.config.manage` | as M30 minus `code` (`display: 1..120`) | new version | R |
| M32 | POST `/ast-panels/{panel_id}/deactivate` | `deactivateAstPanel` | `micro.config.manage` | `{}` | `AstPanelDto` | O |
| M33 | GET `/instrument-vocab-maps` | `listInstrumentVocabMaps` | `micro.culture.read` (D-64) | query `instrument_id`, `kind`, `is_active`, cursor/limit | page of `VocabMapDto` | — |
| M34 | POST `/instrument-vocab-maps` | `createInstrumentVocabMap` | `micro.config.manage` | `{ instrument_id, kind: organism|antibiotic, code_raw: 1..64, local_code: Code }` | `VocabMapDto` (201); duplicate active key → `409 micro.code_duplicate` | R |
| M35 | PUT `/instrument-vocab-maps/{map_id}` | `updateInstrumentVocabMap` | `micro.config.manage` | `{ local_code }` | `VocabMapDto` | O |
| M36 | POST `/instrument-vocab-maps/{map_id}/deactivate` | `deactivateInstrumentVocabMap` | `micro.config.manage` | `{}` | `VocabMapDto` | O |
| M37 | GET `/instrument-ast-defaults` | `listInstrumentAstDefaults` | `micro.culture.read` (D-64) | — | `{ data: [{ instrument_id, standard, standard_version, version }] }` | — |
| M38 | PUT `/instrument-ast-defaults/{instrument_id}` | `putInstrumentAstDefault` | `micro.config.manage` | `{ standard: CLSI|EUCAST|ECOFF, standard_version: 1..32 }` (create or replace; `If-Match` only when it exists) | row | O |
| M39 | GET `/settings` | `getMicroSettings` | `micro.culture.read` (D-64) | — | `MicroSettingsDto` (defaults when no row) | — |
| M40 | PUT `/settings` | `updateMicroSettings` | `micro.config.manage` | `{ manual_ast_standard?: CLSI|EUCAST, zone_suggestion_enabled, mic_suggestion_enabled, default_final_no_growth_hours: 1..720, early_final_requires_reason, recent_window_days: 1..31 }` (`unset: ["manual_ast_standard"]` to clear) | `MicroSettingsDto` | O |

Instrument ids (`instrument_id`) are validated by the composite FK to `instruments.instruments` (insert fails → mapped to `400 common.validation_failed` path `/instrument_id`; 08 A13 P-1).

### 5.5 Breakpoint sets

| # | Method + path | operationId | Permission | Request | Response | Extra codes | Idem |
|---|---|---|---|---|---|---|---|
| M41 | GET `/breakpoint-sets` | `listBreakpointSets` | `micro.culture.read` (one `x-permission`, 02-CV §4.12; same rule as D-64 [CONV: every `micro.breakpoint.manage` role also holds `micro.culture.read`, and technologists need the active set's version for the AST grid]) | query `standard`, `status` csv, cursor/limit (sort `-created_at`) | page of `BreakpointSetDto` | — | — |
| M42 | POST `/breakpoint-sets` | `createBreakpointImport` | `micro.breakpoint.manage` (CR, **privileged**) | `multipart/form-data`: part `metadata` (JSON `{ standard, standard_version: 1..32, title: 1..120, licence_attestation_text: 20..500, intended_effective_from?: IsoUtc }`), part `file` (`text/csv`, ≤ 5 MiB = 5,242,880 bytes [CONV]); `intended_effective_from` is stored in `breakpoint_sets.intended_effective_from` | `BreakpointSetDto` (201, `status = uploaded`) | `micro.breakpoint_import_invalid` (not UTF-8 text / NUL bytes / duplicate sha256), `common.payload_too_large`, `common.unsupported_media_type`, `auth.mfa_required` | **R** |
| M43 | GET `/breakpoint-sets/{set_id}` | `getBreakpointSet` | as M41 | — | `BreakpointSetDto` | — | — |
| M44 | GET `/breakpoint-sets/{set_id}/issues` | `listBreakpointImportIssues` | `micro.breakpoint.manage` | query `severity`, cursor/limit (sort line_no) | page of `{ line_no?, severity, code, field?, message }` | — | — |
| M45 | GET `/breakpoint-sets/{set_id}/rows` | `listBreakpointRows` | `micro.breakpoint.manage` | query `antibiotic_code`, `organism_code`, cursor/limit | page of `{ id, line_no, organism_scope, organism_code?, antibiotic_code, method, specimen_site_code?, qualifier_code?, bands: [{ id, band_no, category_code, lower_value?: DecimalString, lower_inclusive, upper_value?: DecimalString, upper_inclusive, note? }] }` | — | — |
| M46 | POST `/breakpoint-sets/{set_id}/activate` | `activateBreakpointSet` | `micro.breakpoint.manage` | `{ effective_from?: IsoUtc (≥ now − 60 s [CONV]; default = the set's `intended_effective_from` when it is set and not earlier than now − 60 s, else now [CONV: honours the importer's stated start without back-dating]) }` | `BreakpointSetDto` | `micro.breakpoint_set_invalid_transition`, `micro.breakpoint_four_eyes_required`, `auth.mfa_required` | O |
| M47 | POST `/breakpoint-sets/{set_id}/retire` | `retireBreakpointSet` | `micro.breakpoint.manage` | `{}` | `BreakpointSetDto` | `micro.breakpoint_set_invalid_transition`, `auth.mfa_required` | O |
| M48 | POST `/breakpoint-sets/{set_id}/discard` | `discardBreakpointSet` | `micro.breakpoint.manage` | `{}` | `BreakpointSetDto` | `micro.breakpoint_set_invalid_transition` | O |
| M49 | GET `/breakpoint-import-template` | `downloadBreakpointTemplate` | `micro.breakpoint.manage` | — | `200 text/csv` (header line + two comment lines, **no values**), `Content-Disposition: attachment; filename="breakpoint-template.csv"`, `Cache-Control: no-store` | — | — |

### 5.6 DTO field allowlists (mappers, REQ-SEC-081)

| DTO | Fields |
|---|---|
| `CultureSummaryDto` | id, version, status, order_id, order_item_id, specimen_id, patient_id, centre_id, test_id, test_code, test_name (CatalogPort, request-memoised), specimen_type_code, specimen_site_code?, outcome_code?, received_at, planted_at?, next_read_due_at?, final_due_at?, is_read_overdue, current_report_version_no, last_report_phase?, chain_cancelled, open_instrument_record_count, barcode? (only from `barcode_snapshot`) |
| `CultureDetailDto` | Summary + suggested_protocol? `{ id, code, version_no, display }` (only in `awaiting_setup`, 02-TRD §4.2), protocol? `{ id, code, version_no, display, read_schedule_hours, final_no_growth_hours, requires_gram_stain }`, plates: PlateDto[], observations: ObservationDto[], isolates: IsolateDto[], transitions: `[{ from_status?, to_status, reason_code?, occurred_at, actor_display }]`, report_versions: ReportVersionSummaryDto[], amendment_reason_code?, amendment_reason_text?, cancel_reason_code?, lab_result? `{ result_id, status, version_no, verified_at?, approved_at? }` (only when the viewer holds `lab.result.read`), permissions_hint `{ can_amend_approved: boolean }` (viewer holds `lab.result.amend`) |
| `PlateDto` | id, version, plate_no, media_code, incubation_text?, parent_plate_id?, source_isolate_id?, planted_at, status |
| `ObservationDto` | id, kind, plate_id?, growth_code?, quantity_text?, finding_text?, observed_at, hours_since_planting?, recorded_by_display, corrects_observation_id?, is_corrected (another observation corrects it) |
| `IsolateDto` | id, version, isolate_seq, status, organism_code?, organism_display?, organism_source?, identified_at?, colony_description?, quantity_text?, is_reportable, withdraw_reason_code?, ast_panel? `{ id, code, version_no, display }`, ast_method?, ast: AstResultDto[] |
| `AstResultDto` | id, version, antibiotic_code, antibiotic_display, method, raw_value?, raw_qualifier?, raw_numeric? (DecimalString), unit_code?, category_code?, standard?, standard_version?, standard_source?, interpretation_raw?, interpretation_source?, breakpoint_set_id?, suggestion_overridden, source, instrument_id?, instrument_result_time?, is_reportable, report_visibility, off_panel, panel_sort_order?, entered_at? |
| `ReportVersionSummaryDto` | version_no, report_phase, version_kind, outcome_code?, flag, is_critical, signed_by_display, signed_at, lab_status_at_submit, amendment_reason_code? |
| `ReportVersionDto` | Summary + culture_summary_text, isolates, ast, comments_text?, early_final_reason?, amendment_reason_text?, lab_result_id, lab_result_version_no |
| `InstrumentRecordDto` | id, version, record_kind, instrument_id, instrument_message_id, sample_barcode (P2 — staff with `micro.culture.read` only; never logged), isolate_seq?, organism_code_raw?, antibiotic_code_raw?, method?, raw_value?, interpretation_raw?, standard?, standard_version?, instrument_result_time?, received_at, is_rerun, match_status, match_reason?, culture_id?, isolate_id?, ast_result_id?, organism_code?, antibiotic_code? (mapped codes from the event), ignore_reason_code?, ignore_comment?, expires_at? |
| `BreakpointSetDto` | id, version, standard, standard_version, title, licence_attestation_text, status, file_sha256, file_bytes, row_count, band_count, error_count, warning_count, intended_effective_from?, effective_from?, effective_to?, imported_by_display, created_at, activated_by_display?, activated_at?, retired_at? |
| `PlatingProtocolDto`, `AstPanelDto`, `VocabMapDto`, `MicroSettingsDto` | all columns of the table except tenant_id/created_by/updated_by; child lists inline; `applies_to` for protocols |

`*_display` names (08 A17 P-17, D-47): membership ids (`signed_by_membership_id` → `signed_by_display`, `recorded_by_membership_id` → `recorded_by_display`) → `ctx.core.memberships.list(tx, { membershipIds, activeOnly: false })` batched per request (≤ 200 ids per call); user ids (`created_by` → `actor_display` of transitions and `imported_by_display`, `activated_by` → `activated_by_display`) → `ctx.core.user(ctx, { userId })`. Both memoised per request; an id that is not returned shows as `—`. `IdentityPort.getActor` returns only the caller and `IdentityPort.getSignatories` is reserved for report signatures, so neither is used here; `core.memberships` is never read directly.

## 6. Configuration keys

| Key | Scope | Default | Meaning |
|---|---|---|---|
| `LIMS_MICRO_IMPORT_MAX_BYTES` | global env | 5242880 [CONV] | breakpoint CSV size cap (≤ core 15 MB cap) |
| `LIMS_MICRO_IMPORT_MAX_LINES` | global env | 20000 [CONV] | data lines per file |
| `LIMS_MICRO_IMPORT_TIMEOUT_MS` | global env | 60000 [CONV] | validation job parse timeout |
| `LIMS_MICRO_SPECIMEN_LOOKUP_PORT` | global env | `false` | use `LabPort.lookupSpecimens` (CR-C10-003, accepted in 08) once C5 implements it |
| `LIMS_MICRO_RECONCILE_BATCH` | global env | 200 [CONV] | cultures per tenant per reconciliation run |
| `LIMS_MICRO_BFF_LOOKUP_CONCURRENCY` | web env | 8 [CONV] | parallel C5 `getSpecimen` calls when barcodes are not snapshotted |
| `micro.settings.*` | per tenant (DB) | see 05-SCHEMA §8 | standard for suggestions, flags, no-growth hours, early-final reason, recent window |
| `TenantSettings.timezone` | per tenant (IdentityPort) | `Asia/Kathmandu` | display of times |

## 7. Ports

### 7.1 Consumed (signatures verbatim from 03-IC §4)

```ts
// LabPort (C5)
getOrderResults(ctx, { orderId, scope: 'approved' | 'all_visible' }): Promise<OrderResults>;
submitModuleResult(ctx, input: SubmitModuleResultInput): Promise<SubmitModuleResultOutput>;
lookupSpecimens(ctx, input: SpecimenSelector): Promise<readonly SpecimenRef[]>;   // CR-C10-003 (08 §4.14); C10 uses the {barcode} and {specimenIds} selectors only
// CatalogPort (C3)
getTest(ctx, { testId, asOf?, requireActive? }): Promise<TestDefinition>;
// IdentityPort (C2)
assertRole(ctx, { permission, centreId?, branchId? }): Promise<void>;
getActor(ctx): Promise<ActorProfile>;
getTenantSettings(ctx, { keys: ['timezone', 'retention'] }): Promise<Pick<TenantSettings, 'timezone' | 'retention'>>;   // retention.rawInstrumentYears (08 A17 D-65)
// ctx.core (C0 02-TRD §6.8, widened by 08 A17 D-47) — staff display names
ctx.core.memberships.list(tx, { membershipIds, activeOnly: false }): Promise<readonly { membershipId; displayName; roleCodes; allCentres; isActive }[]>;
ctx.core.user(ctx, { userId }): Promise<…>;   // display name for created_by / activated_by
```

| Use | Call | Notes |
|---|---|---|
| Item → test (consumer) | `getOrderResults({ orderId, scope: 'all_visible' })` → `items[].{orderItemId, testId}`; `getTest({ testId })` → `workflowType === 'microbiology'` | system actor needs `lab.result.read` (declared in worker manifest). Catalog result memoised per job |
| Micro result line status | `getOrderResults(all_visible)` → item with `orderItemId = culture.order_item_id` → `results[]` where `origin === 'module'`; status/versionNo/approvedAt | detail page (viewer with `lab.result.read`), submission (§4.7), reconciliation job |
| Hand-off | `submitModuleResult` | §4.7; `analyteId` omitted (C3 seeds one module-result analyte per micro test — 03-IC §4.5; C3 AC-02.3) |
| Barcode → specimen; barcode snapshot | `lookupSpecimens` (CR-C10-003) | behind `LIMS_MICRO_SPECIMEN_LOOKUP_PORT` |
| Permission hints | `getActor().permissions` includes `lab.result.amend` / `lab.result.read` | for `permissions_hint` and the `lab_result` block |
| Raw-instrument retention | `getTenantSettings({ keys: ['retention'] })` → `retention.rawInstrumentYears` | §4.8 step 8 `expires_at` (D-65) |
| Staff display names | `ctx.core.memberships.list` / `ctx.core.user` | §5.6 (D-47) |

C10 calls no `FrontdeskPort` (not in its 01 §6 dependency row). Patient names are shown by the BFF via C4's HTTP `getPatient` under the user's own `frontdesk.patient.read` (C10 stores ids only).

### 7.2 Implemented

None.

## 8. Events

### 8.1 Produced

None (01 §5.1 lists no `micro.*` event). The chain events (`lab.result.*`, `lab.critical_value.detected.v1`) are produced by C5 as a consequence of `submitModuleResult`.

### 8.2 Consumed

```ts
// services/worker/src/jobs/micro/index.ts
export const manifest: WorkerManifest = {
  module: 'micro',
  systemPermissions: ['micro.culture.read', 'micro.culture.work', 'lab.result.read'],   // 02-CV §2.3 (field name per C0's WorkerManifest type)
  tasks: {
    'micro.breakpoint_import_validate': breakpointImportValidate,
    'micro.reconcile_chain_status': reconcileChainStatus,
    'micro.refresh_metrics': refreshMetrics,
    'micro.purge_instrument_records': purgeInstrumentRecords,   // 08 A17 D-65
  },
  subscriptions: {
    'lab.specimen.status_changed.v1': onSpecimenStatusChanged,      // A4
    'instruments.result.received.v1': onInstrumentResult,           // 01 §5.1 consumer C10
  },
  crontab: cron,
};
```

| Event | Handler behaviour | Idempotency / ordering |
|---|---|---|
| `lab.specimen.status_changed.v1` | `to_status = received`: candidate items = the `order_item_ids` elements whose test is microbiology. **When `order_item_ids` is absent** (review #12): the micro items of `order_id` whose `TestDefinition.specimenTypeCodes` contains the event's `specimen_type_code`; if `OrderResults.specimens` (same `getOrderResults` call) holds more than one specimen of the order with that `specimen_type_code` whose status is not `rejected`, the item cannot be placed: create nothing, increment `lims_micro_unmapped_received_total` (alert §11) and finish. For each candidate item `I`: **aliquot** (`parent_specimen_id = P` set): if a culture for `(I, P)` exists — still `awaiting_setup` → re-point its `specimen_id` to the aliquot and set `last_specimen_seq` = the aliquot event's `aggregate.seq` (audited; review m#17); otherwise nothing changes except `lims_micro_aliquot_after_setup_total` — and **no** culture is ever created for `(I, aliquot)` (review m#18); if no culture for `(I, P)` exists, the aliquot is treated as a normal received specimen. Otherwise create the culture (creation key) with `centre_id` = event `centre_id`. Snapshot `barcode` via CR-C10-003 when enabled (no processing-centre snapshot — 08 A17 D-63). After creating, enqueue nothing else; open `pending_match` instrument records for the same barcode are re-tried in the same transaction when the barcode is known. `to_status = rejected`: cancel non-reported cultures of the specimen (`specimen_rejected`). Other statuses: update `last_specimen_seq` only. Every child row written later copies `centre_id` from its culture (05-SCHEMA §1). | inbox on `event_id`; per culture `aggregate.seq` > `last_specimen_seq` else ignore; creation key unique |
| `instruments.result.received.v1` | `record_kind ∈ {organism_id, ast}` → §4.8 steps 1–6; other kinds → inbox only | inbox on `event_id`; `instrument_records__key__uq` on the 04 N10 key; at-least-once, unordered (rerun ordering by `instrument_result_time`) |

Both consumers run with `max_attempts = 10` (02-CV §7.5) and write nothing external.

## 9. Background jobs

| Task | Trigger / schedule | Behaviour | Retries |
|---|---|---|---|
| `micro.breakpoint_import_validate` | enqueued by `createBreakpointImport` (`job_key = set_id`) | status `uploaded` → `validating` on the first attempt; on a retry the status is already `validating` and is **not** updated again (the guard has no `validating → validating`; review m#20) and nothing is deleted, because rows/bands/issues are inserted only in the final transaction; read file via `ctx.storage.read('micro-imports', path)`; parse (§9.1) under `LIMS_MICRO_IMPORT_TIMEOUT_MS`; validate; in one transaction insert rows, bands, issues, counts and set `validated`/`invalid` | 3 [CONV]; final failure → set `invalid` with issue `file.processing_failed` (dead-letter per 02-CV §7.5) |
| `micro.reconcile_chain_status` | cron `17 2 * * *` (daily 02:17 UTC [CONV]), `tenantScope: 'per_tenant'` (08 A13 P-6: one job per tenant under that tenant's claims for the `micro` system actor) | for up to `LIMS_MICRO_RECONCILE_BATCH` active cultures older than 24 h: group by order, `LabPort.getOrderResults(all_visible)`; micro line `cancelled` → culture `cancelled` (`order_item_cancelled`) if no submitted version, else `chain_cancelled = true` | 5 |
| `micro.refresh_metrics` | cron `*/5 * * * *`, `tenantScope: 'per_tenant'` (P-6) | per tenant gauges: cultures by status, reads overdue, open instrument records by status | 1 (next run supersedes) |
| `micro.purge_instrument_records` | cron `43 3 * * *` (daily 03:43 UTC [CONV]), `tenantScope: 'per_tenant'` (P-6), system actor | 08 A17 D-65: `DELETE FROM micro.instrument_records r WHERE r.tenant_id = $1 AND r.expires_at < now() AND NOT EXISTS (SELECT 1 FROM micro.ast_results a WHERE a.tenant_id = r.tenant_id AND a.instrument_record_id = r.id)` under policy `instrument_records__delete__tenant_centre` (05-SCHEMA §8); batches of 1,000 rows [CONV]; counter `lims_micro_instrument_records_purged_total` | 3 |

Crontab lives in `cron.ts` (REQ-ARCH-042).

### 9.1 Breakpoint CSV format (DECISION [CONV])

- UTF-8 (BOM stripped; invalid UTF-8 or NUL byte → `file.encoding_invalid`), RFC 4180 quoting, `,` separator, LF or CRLF. Blank lines ignored; lines starting with `#` are comments.
- Header (exact, in order): `organism_scope,organism_code,antibiotic_code,method,specimen_site_code,qualifier_code,category_code,lower_value,lower_inclusive,upper_value,upper_inclusive,note`.
- One **band** per line. Lines sharing the first six columns form one row; `band_no` = order of appearance (≤ 6). `organism_scope ∈ {organism, group, any}` (`any` ⇒ empty `organism_code`). `method ∈ {mic, zone_diameter}`. Empty `specimen_site_code`/`qualifier_code` = any. Values `^[0-9]{1,8}(\.[0-9]{1,6})?$` or empty (unbounded); `*_inclusive ∈ {true,false}` (empty = `true`). `note` ≤ 200.
- Issue codes (error unless (w)): `file.encoding_invalid`, `file.header_mismatch`, `file.empty`, `file.too_many_rows`, `file.parse_timeout`, `file.quote_unbalanced`, `file.processing_failed`, `row.column_count`, `row.scope_invalid`, `row.organism_unknown`, `row.group_unknown`, `row.antibiotic_unknown`, `row.method_invalid`, `row.site_unknown`, `row.qualifier_invalid`, `row.category_invalid` (not a code of the set's standard), `row.category_restricted`, `row.value_invalid`, `row.bounds_missing`, `row.bounds_order`, `row.bands_overlap`, `row.too_many_bands`, `row.note_too_long`, `row.code_inactive` (w), `row.gap_between_bands` (w), `row.key_split` (w: same key appears non-contiguously). Messages name the field, never echo cell content beyond 40 chars.
- Template (M49) = header + `# One line per interpretive band; see the user manual.` + `# This file must contain only breakpoint data your laboratory is licensed to use.`

## 10. Performance targets

Capacity basis (04 §14, ASSUMPTION): 500 patients/day/lab, N = 10 labs, peak hour = 25 % of daily volume, ≈ 50 writes/s system-wide derived, 250 writes/s headroom. Micro share is **unknown** (client question 01 §7 Q6) → ASSUMPTION: ≤ 10 % of patients have a micro test → ≤ 50 cultures/day/lab; design margin ×10 → **500 cultures/day/lab**.

| Quantity | Arithmetic | Result |
|---|---|---|
| Cultures/day (10 labs, margin) | 500 × 10 | 5,000 |
| Requests per culture | setup 1 + reads 3 + observations 1 + isolate 1.5 + identify 1.5 + panel 1.5 + AST bulk 2 + reports 2 + detail views 10 ≈ 23.5 → round 25 [ASSUMPTION] | 125,000/day |
| Peak-hour request rate | 125,000 × 0.25 / 3600 | ≈ 8.7 req/s (≈ 3.5 % of the 250 writes/s headroom even if all were writes) |
| Instrument records/day/lab | 500 cultures × 30 % growth × 1.2 isolates × (1 ID + 20 AST) [ASSUMPTION] | ≈ 3,780 (same order as 04 §14 analyser messages 1,500–3,000) |
| Instrument records peak/s (10 labs) | 37,800 × 0.25 / 3600 | ≈ 2.6 events/s |

| Operation | p95 target [CONV] | Note |
|---|---|---|
| `listCultures` (50 rows) | ≤ 150 ms | partial indexes §9 of 05-SCHEMA; test names from memoised CatalogPort |
| `getCulture` | ≤ 250 ms | includes one `LabPort.getOrderResults` (≤ 80 ms budget, 03-IC §4.5) |
| `recordAstResults` (60 entries) | ≤ 300 ms | single transaction, batched inserts |
| `previewAstInterpretation` (60 entries) | ≤ 200 ms | one set + one rows query, in-memory evaluation |
| `submitCultureReport` | ≤ 400 ms | port ≤ 50 ms (03-IC §4.5) + snapshot |
| consumer per event | ≤ 100 ms p95; queue lag ≤ 60 s at peak | |
| breakpoint validation | 20,000 lines ≤ 30 s | timeout 60 s |

Validated by the load test on the 1× and 10× seed (05-DoD §3.5).

## 11. Observability

Logs (02-CV §9): ids and codes only. **Never logged:** barcodes (`sample_barcode`, `barcode_snapshot`), organism or antibiotic codes linked to a culture, raw values, categories, free texts (findings, comments, summaries), CSV content. Consumer logs include `event_id`, `idempotency_key_sha256` (hash of the key, which contains a barcode). Logger denylist additions for this module (review #13: every P2/P3 column of 05-SCHEMA §7 plus request field names): `sample_barcode`, `barcode`, `barcode_snapshot`, `raw_value`, `raw_numeric`, `raw_qualifier`, `finding_text`, `culture_summary_text`, `summaryText`, `comments_text`, `comment`, `colony_description`, `quantity_text`, `incubation_text`, `media_code`, `growth_code`, `outcome_code`, `organism_code`, `organism_code_raw`, `antibiotic_code`, `antibiotic_code_raw`, `category_code`, `interpretation_raw`, `isolates`, `ast`, `amendment_reason_text`, `reasonText`, `early_final_reason`, `cancel_comment`, `withdraw_comment`, `ignore_comment`, `licence_attestation_text`, `specimen_type_code`, `specimen_site_code`.

| Metric | Type | Labels |
|---|---|---|
| `lims_micro_cultures_created_total` | counter | `tenant_id` |
| `lims_micro_cultures_by_status` | gauge | `tenant_id`, `status` |
| `lims_micro_reads_overdue` | gauge | `tenant_id` |
| `lims_micro_report_versions_total` | counter | `tenant_id`, `phase`, `kind` |
| `lims_micro_submit_failures_total` | counter | `error_code` |
| `lims_micro_instrument_records_total` | counter | `tenant_id`, `record_kind`, `match_status` (at first evaluation) |
| `lims_micro_instrument_records_open` | gauge | `tenant_id`, `match_status` |
| `lims_micro_breakpoint_imports_total` | counter | `outcome` (validated/invalid) |
| `lims_micro_suggestions_total` | counter | `outcome` (suggested/none_reason) |
| `lims_micro_specimen_rejected_after_report_total` | counter | — |
| `lims_micro_aliquot_after_setup_total` | counter | — |
| `lims_micro_unmapped_received_total` | counter | `tenant_id` (received event without `order_item_ids` that could not be placed — §8.2) |
| `lims_micro_instrument_records_purged_total` | counter | `tenant_id` |

Alerts (registered with C1): `lims_micro_instrument_records_open{match_status=~"pending_match|needs_mapping|conflict"} > 50` for 24 h [CONV]; consumer dead letters (`lims_core_dead_letters_total{task=~"evt.micro.*"}` > 0); `micro.breakpoint_import_validate` dead letter; `lims_micro_submit_failures_total{error_code="common.internal"}` rate > 0 for 15 min; `increase(lims_micro_unmapped_received_total[1h]) > 0` (a micro specimen received without a culture — review #12).

## 12. Error codes used

From 03-IC §8: `micro.organism_code_unknown`, `micro.ast_standard_required`, `micro.antibiotic_not_in_panel`, `micro.report_final_locked`; pass-through from LabPort: `lab.result_locked`, `lab.result_invalid_transition`, `lab.module_result_invalid`, `lab.module_result_stale`, `lab.amendment_reason_required`; plus `common.*`, `auth.*`. New (CR-C10-005): `micro.culture_invalid_transition`, `micro.isolate_invalid_transition`, `micro.ast_value_invalid`, `micro.ast_category_not_allowed`, `micro.report_incomplete`, `micro.amendment_reason_required`, `micro.instrument_record_conflict`, `micro.breakpoint_import_invalid`, `micro.breakpoint_set_invalid_transition`, `micro.breakpoint_four_eyes_required`, `micro.code_duplicate`.

SQLSTATE mapping (review #7, m#29; 08 A13 P-1):
- `P0001` message `immutable_row` raised by `<t>__final_lock` (`isolates`, `ast_results`, `culture_plates`, `culture_observations`) → `409 micro.report_final_locked`;
- `P0001` message `culture_invalid_transition` raised by `micro.cultures_guard` → `409 micro.culture_invalid_transition`;
- `P0001` raised by `micro.breakpoint_sets_guard` → `409 micro.breakpoint_set_invalid_transition`;
- any other `P0001 immutable_row` on a micro table → `409 common.immutable_record`;
- `23505` on `cultures__creation_key__uq` inside consumers → treated as success; `23505` on `plating_protocols__tenant_id_code__p_uq`, `ast_panels__tenant_id_code__p_uq`, `plating_protocol_keys__tenant_id_key__p_uq` or `instrument_vocab_maps__tenant_id_key__p_uq` → `409 micro.code_duplicate`;
- `23503` on instrument FKs → `400 common.validation_failed` (path `/instrument_id`).

Port codes (`lab.*`) propagate unchanged (08 A17 P-23): the handler rethrows the original `LimsError` and lists the code in `x-error-codes`.

## 13. Security-relevant implementation rules

- Object first, then permission with the object's `centre_id` (02-CV §10.1): every handler loads the culture/isolate/record/set through RLS; not visible → `404 common.not_found`.
- Body ids must belong to the path object (`plate_id`, `parent_plate_id`, `source_isolate_id`, `corrects_observation_id` within the same culture; `ast_panel_id` current or the isolate's own) else `400 common.id_mismatch`.
- Server is the authority for `version_no`, `status`, `signed_by`, `standard_source`, `interpretation_source` — never accepted from the client (02-CV §4.7). `isolate_seq` is never accepted on create (M7); M20 accepts it only to choose an existing or new isolate number for an instrument record (review m#27).
- Breakpoint management is privileged (aal2) and four-eyes on activation (07-SECURITY §3).
- `access_log` via `ctx.audit.access({action, entityType, entityId?, outcome, detail?})` (CR-C10-010, codes per 08 §4.4 / 03-IC §13.1). Every call, as operation → `action` → `entityType` (08 A13 P-3) [CONV: entityType names]; no other action is used by C10:

| Operation | `action` | `entityType` / `entityId` |
|---|---|---|
| M2 `getCulture` | `culture.view` | `micro_culture` / culture id |
| M42 `createBreakpointImport` | `breakpoint_set.import` | `micro_breakpoint_set` / set id |
| M46 `activateBreakpointSet` | `breakpoint_set.activate` | `micro_breakpoint_set` / set id |
| M47 `retireBreakpointSet` | `breakpoint_set.retire` | `micro_breakpoint_set` / set id |
| M20 `assignMicroInstrumentRecord`, M21 `applyMicroInstrumentRecord` | `micro_instrument_record.assign` (`detail.resolution`) | `micro_instrument_record` / record id |

## 14. Test strategy

| Layer | What | Fakes |
|---|---|---|
| Unit (`__tests__/unit`) | state tables (every allowed + one forbidden transition each), `ast-value` grammar (qualifiers, `≤`, combos `8/4`, limits), interpretation rules (all seeded codes, restriction, cross-standard rejection, new synthetic code), `breakpoint-eval` golden table (synthetic bands only: inclusive/exclusive bounds, open bands, gaps, qualifier spanning), selection precedence, snapshot builder (keys exactly as schema; ordering; truncation), schedule maths, CSV parser (quotes, CRLF, BOM, comments, NUL) | none |
| Integration (`__tests__/integration`) | services + repositories on migrated PG 17 with both synthetic tenants: consumers (duplicate, stale seq, aliquot, aliquot re-point then aliquot `rejected` → culture cancelled, aliquot after setup creates nothing, rejection, recollection, `order_item_ids` absent with urine C/S + blood culture on two specimens → one culture each, two same-type specimens → none + `lims_micro_unmapped_received_total`), second preliminary over an approved preliminary sends `module_preliminary_update` (D-61), amendment reason stored on `report_versions`, size guard → `micro.report_incomplete`, instrument `isolate_seq` 100 → `pending_match` `isolate_seq_out_of_range`, purge task deletes only expired unreferenced records, submission tx rollback when the port throws, instrument record paths (applied/pending/needs_mapping/conflict/late), import job end-to-end, activation overlap closing | `LabPort`, `CatalogPort`, `IdentityPort` fakes from `@lims/fakes` (`failNext` for C5 errors); fake storage |
| Contract — HTTP | every operation request/response validated against `micro.yaml`; one test per `x-error-codes` entry | Prism for web |
| Contract — events | consumer handles every 03-IC example + unknown extra fields + duplicate delivery + stale seq | — |
| Contract — view | `v_pub_report_content` columns/JSON vs 05-SCHEMA §6 | — |
| Probes (`__tests__/probes`) | 07-SECURITY §5 list: every endpoint cross-tenant + cross-centre; every table | generated + hand-written |
| Web | component tests (MSW), keyboard flows of 04-UI-UX, axe scan per page | MSW 3.0.3 |
| E2E (nightly) | receive micro specimen (C5) → culture → setup → read → isolate → AST → prelim → C5 verify/approve → final → amended | real C5 after its chunk gate |

## 15. Change requests raised

> Status per `program/08-CR-REGISTER.md` (2026-11-06). CR texts below are kept as history.

| CR | Status |
|---|---|
| CR-C10-001 | ACCEPTED-MODIFIED in 08 — Primary of merged amendment shape; seeds `module_phase_progression` and `supplementary_report` (R1). |
| CR-C10-002 | ACCEPTED-MODIFIED in 08 — + `addendum` report kind for `supplementary_report` (R1). |
| CR-C10-003 | ACCEPTED-MODIFIED in 08 — Primary; adds `{orderId, statuses?}` selector absorbing CR-C17-002 (§4.14). C10 no longer uses `processingCentreId` (08 A17 D-63). |
| CR-C10-004 | ACCEPTED in 08 |
| CR-C10-005 | ACCEPTED in 08 |
| CR-C10-006 | ACCEPTED in 08 |
| CR-C10-007 | ACCEPTED in 08 |
| CR-C10-008 | MERGED in 08 into CR-C2-011 — `text/csv` allowed with UTF-8/NUL check, scan not applicable. |
| CR-C10-009 | ACCEPTED in 08 |
| CR-C10-010 | ACCEPTED-MODIFIED in 08 — Renamed to 2 segments (§4.4). |
| Review fix pass 2026-11-06 | review/C10-microbiology.md + 08 Addendum A17 (plus A13 rules P-1…P-15 that apply to you) applied |

**08 Addenda applied (08 A25 P-60: one row per addendum A1–A29; final check 2026-11-06)**

| Addendum | Status for C10 |
|---|---|
| A1 | not applicable |
| A2 | not applicable |
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
| A13 | applied 2026-11-06 — P-1, P-3, P-6, P-8, P-15, D-7, D-13, D-16, D-40, D-42 (PRD, TRD, AF, UI, SCH, PLAN, SEC) |
| A14 | not applicable |
| A15 | not applicable |
| A16 | applied 2026-11-06 — A16.1 (SCH) |
| A17 | applied 2026-11-06 — P-16, P-17, P-18, P-22, P-23, D-47, D-61, D-62, D-63, D-64, D-65 (PRD, TRD, AF, UI, SCH, PLAN, SEC) |
| A18 | not applicable |
| A19 | not applicable (A19 P-40 cites this chunk's existing port idempotency keys as already compliant; D-106/D-109/D-110/D-123 change other chunks or program docs) |
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

### CR-C10-001: `SubmitModuleResultInput.amendment` + amendment reason seed
- From C10 → C0-0C (port) + C5 (implements) + C0-0B (seed). Type: port. Blocking: no (US-11 works without the reason reaching C5).
- Problem: 03-IC §4.5 says a submission on an approved result is an amendment (R7), and `lab.result.amended.v1` requires `amendment_reason_code` (03-IC §3.11), but `SubmitModuleResultInput` has no reason field (AC-11.2). Also a micro **final after an approved preliminary** is, by A1, an R7 amendment; C10 needs a distinct reason so C6 does not label a normal final "Amended" (see CR-C10-002).
- Proposed: `readonly amendment?: { readonly reasonCode: Code; readonly reasonText?: string /* ≤500 */ }` on `SubmitModuleResultInput`; required by C5 when the target result is `approved` (else C5 throws `lab.amendment_reason_required`, existing code); `reasonCode` from `lab.amendment_reasons`. Seed into `lab.g_cs_amendment_reasons`: `module_phase_progression` "Final after preliminary report".
- Backward compatible: yes (optional field). Security: reason text is P3, stays in C5/C10.
- Tests: LabPort contract additions — approved + amendment → event carries the code; approved without amendment → `lab.amendment_reason_required`.

### CR-C10-002: C6 report-kind rule for module phase progression
- From C10 → C6. Type: bug/behaviour (C6 02-TRD report-kind rule). Blocking: no.
- Problem: C6 classifies a report `amended` when any result has `versionNo > 1` and an earlier version was released. A micro final that follows an approved+released preliminary is version 2 of the result line, so it would print "Amended" instead of "Final".
- Proposed: in C6's first-match rule, a micro section whose `ResultView.amendment.reasonCode = 'module_phase_progression'` does not by itself make the report `amended`; the report kind then follows the remaining rules (`preliminary` if any micro section is preliminary, else `final`/`partial`). Later true amendments keep `amended`.
- Backward compatible: yes. Tests: C6 report-kind unit cases.

### CR-C10-003: `LabPort.lookupSpecimens`
- From C10 → C0-0C (port) + C5 (implements). Type: port. Blocking: no — default = manual matching (AC-08.4) and BFF display lookups.
- Problem: instrument records identify the sample only by `sample_barcode` (03-IC §3.14); C10 cannot read `lab.specimens` (R1); `getPendingTestsForBarcode` is a host query with side effects (S6 pick-up). C10 also wants `barcode`/`processing_centre_id` snapshots for worklists and RLS parity.
- Proposed:
  ```ts
  lookupSpecimens(ctx: RequestContext, input: { barcode: string } | { specimenIds: readonly Uuidv7[] /* 1..200 */ }):
    Promise<readonly { specimenId: Uuidv7; barcode: string; orderId: Uuidv7; patientId: Uuidv7; centreId: Uuidv7;
                       processingCentreId?: Uuidv7; specimenTypeCode: Code; status: SpecimenStatus; isActive: boolean }[]>;
  ```
  No side effects; RLS of the caller; user actors need `lab.specimen.read` (system actors: tenant-wide). Unknown/invisible → omitted. Contract tests: other tenant omitted; centre scope; old barcode of a recollected specimen resolves only to the old specimen (01 §2.1).
- Security: returns P2 (barcode) to an authorised caller only.

### CR-C10-004: Permission codes (`contracts/permissions.yaml`)
- From C10 → C0-0C. Type: api.
  - `{ code: micro.config.manage, privileged: false, roles: [lab_manager], phase: 2 }`
  - `{ code: micro.breakpoint.manage, privileged: true, roles: [lab_manager, pathologist], phase: 2 }` (changes interpretations → aal2, 04 A4 spirit)
  - change `micro.culture.work` roles to `[lab_technologist, pathologist]` (pathologists submit finals/amendments in C10).
- Security: privileged entry requires aal2.

### CR-C10-005: Error codes (`contracts/errors.yaml`)
- From C10 → C0-0C. Type: api.
```yaml
- { code: micro.culture_invalid_transition,     http: 409, owner: C10, title: "Culture cannot move to the requested state", meaning: "03-APP-FLOW §2.1" }
- { code: micro.isolate_invalid_transition,     http: 409, owner: C10, title: "Isolate cannot move to the requested state", meaning: "03-APP-FLOW §2.2" }
- { code: micro.ast_value_invalid,              http: 422, owner: C10, title: "AST value invalid", meaning: "MIC/zone syntax or range" }
- { code: micro.ast_category_not_allowed,       http: 422, owner: C10, title: "Interpretive category not allowed", meaning: "Not a code of the standard, or restricted for this antibiotic (04 D14)" }
- { code: micro.report_incomplete,              http: 422, owner: C10, title: "Report is incomplete", meaning: "Preliminary/final completeness guards" }
- { code: micro.amendment_reason_required,      http: 422, owner: C10, title: "Amendment reason required", meaning: "Reopen/amend needs a coded reason" }
- { code: micro.instrument_record_conflict,     http: 409, owner: C10, title: "Instrument record conflicts with existing data", meaning: "Choose use_instrument or keep_existing" }
- { code: micro.breakpoint_import_invalid,      http: 422, owner: C10, title: "Breakpoint file rejected", meaning: "Not UTF-8 text, NUL bytes, or duplicate file" }
- { code: micro.breakpoint_set_invalid_transition, http: 409, owner: C10, title: "Breakpoint set cannot change state", meaning: "03-APP-FLOW §2.5" }
- { code: micro.breakpoint_four_eyes_required,  http: 403, owner: C10, title: "Another user must activate this set", meaning: "Importer cannot activate own import" }
- { code: micro.code_duplicate,                 http: 409, owner: C10, title: "Code already used", meaning: "Protocol/panel code or active vocabulary map key exists" }
```

### CR-C10-006: Routes (`contracts/routes.yaml`)
- From C10 → C0-0C. Type: api. Needed for nav entries (routes with params are not nav entries — C0 04-UI-UX §3).
  - `{ id: staff.micro.worklist, origin: staff_web, path: /micro/worklist, owner: C10, permission: micro.culture.read }`
  - `{ id: staff.micro.instrument_records, origin: staff_web, path: /micro/instrument-records, owner: C10, permission: micro.culture.read }`
  - `{ id: staff.micro.settings, origin: staff_web, path: /micro/settings, owner: C10, permission: micro.config.manage }`
  - `{ id: staff.micro.breakpoint_sets, origin: staff_web, path: /micro/breakpoint-sets, owner: C10, permission: micro.breakpoint.manage }`
  - `{ id: staff.micro.breakpoint_set, origin: staff_web, path: /micro/breakpoint-sets/{breakpoint_set_id}, owner: C10, permission: micro.breakpoint.manage }`
  - existing `staff.micro.culture` unchanged.

### CR-C10-007: ID/AST driver mapping requirements (C7)
- From C10 → C7 (+ C0-0C note in 03-IC §3.14). Type: event semantics (no schema change). Blocking: only the ID/AST driver, itself BLOCKED B2.
- Problem: the result-level idempotency key `<instrument_id>:<sample_barcode>:<instrument_analyte_code>:<instrument_result_time>` (04 N10) does not contain the isolate. If a driver puts only the antibiotic code into `instrument_analyte_code`, the AST of isolate 2 collides with isolate 1 and is dropped by `core.event_log` uniqueness.
- Proposed rule for every driver emitting `organism_id`/`ast`: `instrument_analyte_code` = `ORG:<isolate_seq|1>` for organism records and `AST:<isolate_seq|1>:<antibiotic_code_raw>:<method>` for AST records (truncated to 64 → driver must reject longer and log a warning); `organism.isolate_seq`/`ast.isolate_seq` always set when the instrument provides an isolate number; `standard`/`standard_version` only when the instrument actually sends them (never defaulted in the driver — C10 applies instrument defaults). Simulator fixtures in C7 must include two isolates with the same antibiotic.
- Security: none (no new PHI).

### CR-C10-008: CSV upload support (UI kit + upload helper + bucket)
- From C10 → C0-0D (`FileUpload.accept` add `'text/csv'`) and C0-0A/C0-0B (CR-C4-005 helper allowlist entry `text/csv` with "text" sniffing = valid UTF-8 without NUL; private bucket `micro-imports`, first path segment `{tenant_id}`, `storage.objects` policies per 02-CV §5.8). Type: ui-kit + shared-lib + schema. Blocking: T-14 (import) — default meanwhile: local fake storage, `FileUpload` accept list extended in tests via MSW only.
- Security: CSV is never rendered as HTML; served back only as `attachment` (REQ-SEC-085); no malware scan (text-only, parsed by an in-house parser) — 07-SECURITY threat T-B4.

### CR-C10-009: Documentation alignment (lead / C0)
- (a) 02-CV §3 and §5.2 examples name `catalog.g_ast_interpretations` / `catalog.g_cs_ast_interpretations`, but C3 lists AST data out of its scope ("AST breakpoint tables and organism lists [C10]", C3 01-PRD) and defines no such table. C10 specifies `micro.g_cs_ast_interpretations`. Ask the lead to update the examples (build follows the C10 spec unless the lead rules otherwise; then C0 moves the table and C10 reads it via a CatalogPort method).
- (b) X4 makes **analyte** code maps catalog data. Organism/antibiotic vocabulary maps are not analytes; C10 keeps them in `micro.instrument_vocab_maps`. Ask the lead to confirm X4 does not cover them.
- (c) 03-IC §3.14 should note the CR-C10-007 driver rule.

### CR-C10-010: Access-log action codes
- From C10 → C0-0B (`audit.g_cs_access_actions` seed). Type: schema (seed).
- Codes: `micro.culture.view`, `micro.breakpoint_set.import`, `micro.breakpoint_set.activate`, `micro.breakpoint_set.retire`, `micro.instrument_record.assign`.
