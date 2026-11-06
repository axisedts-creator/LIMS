# C3 Catalog & Pricing — 02 Technical Requirements (TRD)

Status: DECISION draft, 2026-11-05. Read `01-PRD.md` first. All names (tables, operationIds, permissions, error codes, events) are binding for the C3 build and are the specification C0 transcribes into `contracts/openapi/catalog.yaml`, `db/migrations/*catalog*`, `contracts/permissions.yaml`, `contracts/errors.yaml` (02-CV §2.7). Items needing a contract change are marked (CR-C3-00n) and specified in §15.

---

## 1. Owned paths (01-CM §3)

| Path | Content |
|---|---|
| `services/api/src/modules/catalog/**` | API module (handlers, service, domain, repository, events, ports, mappers, tests) |
| `services/worker/src/jobs/catalog/**` | import/export/purge/fan-out jobs |
| `apps/web/src/app/(staff)/catalog/**` | staff web route segment |
| `apps/web/src/features/catalog/**` | components, BFF server functions, forms, help, nav manifest |
| `docs/manual/catalog/**` | user manual pages |

Everything else is read-only for C3. DDL, OpenAPI, event schema, permissions and error registry changes go through C0 via §15 CRs.

## 2. Stack and pinned libraries

### 2.1 Inherited (do not re-pin)

| Component | Version | Source |
|---|---|---|
| Node.js | 26.x LTS, exact patch [PIN-C0] | 02-CV §1.1 |
| Fastify + `fastify-openapi-glue` | Fastify [PIN-C0]; glue **4.12.0** | 02-CV §1.1; 04 T7 |
| Graphile Worker | **0.18.0** | 04 S10, T7 |
| PostgreSQL | 17 (`supabase/postgres:17.6.1.136`) — no native `uuidv7()` | 04 D9 |
| Next.js (staff web) | [PIN-C0], App Router, server-only BFF | 04 S4 |
| `@lims/shared-ts` (uuidv7, money, errors, logger, bsdate, crypto) | C0 | 02-CV §2.1 |
| Decimal arithmetic library used by `@lims/shared-ts/formula` | **C0 pins** (CR-C3-002) — C3 never imports a decimal library directly | 02-CV §1.1 [PIN-C0] |
| `@lims/shared-ts/spreadsheet` — `neutraliseFormula(cell)` / `restoreNeutralised(cell)` (spreadsheet formula-injection guard; module-local copies are banned) | C0-0A (functions + golden tests) | 08 R12e; 08 A13 P-9 |
| TS test runner, browser E2E tool | C0 pins | 02-CV §11.1 |

### 2.2 Dependencies C3 adds (02-CV §15.1 table)

| Name | Exact version | Licence | Purpose | Maintenance evidence | Alternatives considered |
|---|---|---|---|---|---|
| `read-excel-file` | **9.3.14** (import from `read-excel-file/node`) | MIT (allowed, 02-CV §15.2) | Parse uploaded `.xlsx` in the worker | npm registry, fetched 2026-11-05: 9.3.14 published 2026-10-29; 9.3.10–9.3.13 in Aug–Oct 2026; single maintainer (`catamphetamine`), repo gitlab.com/catamphetamine/read-excel-file; `engines.node >=18`; runtime deps `saxen`, `fflate`, `worker-f`, `unzipper-esm` | `exceljs` 4.4.0 (last stable 2023-10-19 — stale, rejected on the same ground as upstream pdf-lib in 04 S15); `xlsx` (SheetJS) on npm 0.18.5 (2022-03-24 — stale; newer builds are distributed outside npm, from a host this environment could not reach → UNVERIFIED, rejected); `@e965/xlsx` 0.20.3 (2024-07-19, third-party mirror — rejected) |
| `write-excel-file` | **4.1.1** (import from `write-excel-file/node`) | MIT | Generate templates, exports, validation reports | npm registry, fetched 2026-11-05: 4.1.1 published 2026-06-08; same maintainer; runtime dep `fflate` | same as above |

Status: **VERIFIED** (versions, dates, licences, dependencies read from registry.npmjs.org on 2026-11-05) / **DECISION** (choice). Behaviour not verified and therefore **not relied on**: the libraries' own zip-bomb limits, their handling of formula cells, and their memory profile on large sheets → **UNVERIFIED**; mitigated by C3's own pre-parse ZIP inspection (§8.4), worker-only parsing with a timeout, and row caps. Single-maintainer risk is recorded in 06-IMPLEMENTATION-PLAN §7. The libraries are confined behind `services/worker/src/jobs/catalog/xlsx/XlsxReader.ts` and `XlsxWriter.ts` so a replacement touches two files. The choice is not in 04 → this row is **[CONV]/DECISION** by C3 and must be listed in C0's dependency review (02-CV §15).

No other runtime dependency is added. Specifically **no** ORM, **no** Supabase client, **no** Storage SDK (D-C3-05).

## 3. Module architecture

Layers follow 02-CV §2.2 exactly. Files (one handler file per operationId, listed in §5):

```
services/api/src/modules/catalog/
├── index.ts                         # ModuleManifest { name:'catalog', openapi:'contracts/openapi/catalog.yaml',
│                                    #   handlers, ports:{ CatalogPort: catalogPortImpl }, produces:['catalog.changed.v1'] }
├── permissions.ts                   # the 9 catalog.* codes (§5.0)
├── config.ts                        # LIMS_CATALOG_* keys (§11)
├── handlers/index.ts + <operationId>.ts
├── service/
│   ├── revision.service.ts          # bumpRevision(tx, root) → {revision} + events.publish  (ALL writes go through it)
│   ├── masters.service.ts           # departments, specimen types, containers, methods, units, value sets
│   ├── tests.service.ts             # orderables, tests, specimen requirements, analytes, TAT targets
│   ├── analyteVersions.service.ts   # draft/publish/discard; publish bundle with range/critical sets
│   ├── ranges.service.ts            # reference-range + critical-limit sets
│   ├── formulas.service.ts          # validation + dependency graph (uses @lims/shared-ts/formula)
│   ├── panels.service.ts            # members, cycle/depth checks
│   ├── comments.service.ts
│   ├── referrers.service.ts         # doctors (quick add, verify, merge)
│   ├── creditParties.service.ts
│   ├── pricing.service.ts           # price lists, versions, items, assignments, surcharge + tax rules
│   ├── quote.service.ts             # pure-ish quote engine over cached data (priceFor)
│   ├── instrumentMaps.service.ts
│   ├── imports.service.ts           # create/commit/discard (API side); parsing runs in worker
│   └── exports.service.ts
├── domain/
│   ├── codes.ts                     # code normalisation + regexes
│   ├── versioning.state.ts          # draft→published→superseded|retired; draft→discarded (pure)
│   ├── import.state.ts              # import state machine (pure)
│   ├── rangeMatch.ts                # band selection (pure, §7.3)
│   ├── priceMatch.ts                # precedence + fall-through (pure, §7.4)
│   ├── surcharge.ts, tax.ts         # (pure, §7.5, §7.6)
│   ├── panelGraph.ts                # expansion, cycle + depth (pure, §7.7)
│   └── formulaGraph.ts              # dependency graph, cycle, depth, topo order (pure, §7.2)
├── repository/                      # one *.repo.ts per aggregate; SQL on catalog.* only; tenant filter explicit
├── cache/catalogCache.ts            # per-process LRU keyed (tenant_id, catalog_revision, key) (§6.3)
├── events/publish.ts                # publishCatalogChanged(tx, {...})
├── ports/CatalogPort.impl.ts
├── mappers/*.dto.ts                 # explicit field allow-lists (REQ-SEC-081)
└── __tests__/{unit,integration,contract,probes}/

services/worker/src/jobs/catalog/
├── index.ts                         # WorkerManifest (tasks + crontab; subscriptions: {} — C3 consumes no events)
├── tasks/catalog.import_validate.ts
├── tasks/catalog.import_commit.ts
├── tasks/catalog.export_build.ts
├── tasks/catalog.purge_files.ts
├── tasks/catalog.expire_imports.ts
├── tasks/catalog.global_release_fanout.ts
├── xlsx/{ZipInspector.ts, XlsxReader.ts, XlsxWriter.ts, templates/*.ts}
├── cron.ts
└── __tests__/{unit,integration}/

apps/web/src/features/catalog/
├── nav.manifest.ts, server/<operationId>.server.ts, components/, hooks/, forms/, help/, __tests__/
apps/web/src/app/(staff)/catalog/   # routes in 04-UI-UX §1
```

Rules on top of 02-CV §2.2:
- **Every write that changes consumer-visible catalog data** in `service/` ends with `revision.service.bumpRevision(tx, {entityType, entityId, changeKind, effectiveFrom})` before commit; it locks `catalog.catalog_state` (`SELECT … FOR UPDATE`), increments `catalog_revision`, stamps `revision` on the root row where the table has one, and calls `events.publish` (§9). A service method that writes without calling it fails a unit test that spies on the repo/tx (`writesWithoutRevision` guard). **Exempt from the guard** (nothing consumer-visible changes): draft rows (`status = 'draft'` versions and their children — bands, draft price items, draft `formula_dependencies`), `imports`, `import_issues`, `exports`, `files`, `code_counters` (§9.1).
- **Revision stamping (`orderables.revision`)**: the only `revision` column is `catalog.orderables.revision` (05-SCHEMA). A bump whose entity is a test, panel, analyte, analyte version, reference-range or critical-limit set, TAT target or specimen requirement also sets `orderables.revision = <new revision>` on the owning test's orderable row (for a panel bump: the panel's own orderable row). Panels containing a changed test are **not** re-stamped (consumers resolve tests individually). `TestDefinition.revision` and `PanelDefinition.revision` = that column (§6.1).
- **Import mode (08 A13 D-21)**: the `catalog_master`, `referrers` and `credit_parties` import commits call the same services with per-write bumping suppressed and call `bumpRevision` **once** at the end of the commit transaction (`entityType: 'catalog_import'`, §9.1); every orderable row touched by the commit is stamped with that one revision. A `price_list` import commit is an ordinary price-list publish (one `price_list` bump).
- Worker tasks call the same `service/` code via the module manifest (02-CV §2.3); they never duplicate business logic.
- `domain/` is pure and has 100 % branch tests for the state machines and matchers.

## 4. Domain model summary (full DDL in 05-SCHEMA)

```
core.tenants ──┐
               ▼
catalog.catalog_state (1/tenant: catalog_revision, catalog_root_id)
departments ─┐  specimen_types ─┐  containers  methods  cs_units(+g_units)  cs_value_sets/values(+g_*)
             ▼                  ▼
orderables (kind test|panel, code, name) ──1:1── tests ──< test_specimen_types
      │                                    └──< analytes ──< analyte_versions ──< formula_dependencies
      │                                              ├──< reference_range_sets ──< reference_ranges (bands)
      │                                              └──< critical_limit_sets ──< critical_limits (bands)
      └──1:1── panels ──< panel_members (member_orderable_id)
tests ──< tat_targets        comment_codes (department-scoped)
doctors   credit_parties   price_lists ──< price_list_assignments (credit_party | doctor | centre)
                                       └──< price_list_versions ──< price_list_items (orderable)
surcharge_rules   tax_rules (+ cs_tax_types, g_tax_types)   instrument_code_maps
files   imports ──< import_issues   exports
```

## 5. HTTP API (contracts/openapi/catalog.yaml)

### 5.0 Common rules for every operation

- Base `/v1/catalog/…`; `tags: [catalog]`; `security: [bearerJwt]` (BFF forwards the session's JWT — 02-CV §6).
- Rate-limit tier: **`general`** for all operations (02-CV §10.3). Additionally the worker refuses to start a third concurrent import per tenant: `POST /imports` returns `429 common.rate_limited` with `Retry-After: 30` when 2 [CONV] imports are in `uploaded|scanning|validating|committing`.
- Every handler: load target via RLS-scoped repo (404 if not visible) → `IdentityPort.assertRole(ctx,{permission})` → service → mapper. Catalog is tenant-scoped, not centre-scoped (catalog rows have no `centre_id`), so `centreId` is never passed.
- Every mutable resource returns `version`; `If-Match` applies to `PATCH`/`PUT` and to state-changing actions on an existing resource (`428 common.precondition_required` if missing, `409 common.version_conflict` if stale). It does **not** apply to the read-only POSTs #3, #36, #51, #60, #82, nor to the creates #97 `createImport` and #104 `createExport` (no existing resource; `Idempotency-Key` guards them).
- Business-rule failures without a registered code of their own are `400 common.validation_failed` with a JSON-pointer `path` in `errors[]` (08 A13 P-1; `common.validation_failed` is registered with `http: 400`, 03-IC §8). No C3 operation returns `common.validation_failed` with 422; 422 is used only by codes registered at 422 (`catalog.formula_invalid`, `catalog.panel_cycle`, `catalog.tax_config_missing`, `common.idempotency_key_reused`).
- Idempotency (08 A13 P-8): every POST that creates state — including master-data creates and draft creates — is `x-idempotency: required`. C3 has no P-8 exception (no operation returns a secret; no pre-auth OTP POST).
- Conditional permissions (08 A13 P-10): `x-permission` is the floor required on every call. A permission that depends on a request value or resource state is checked in the handler with `IdentityPort.assertRole` right after the target is loaded, written in the row as "`+ <code> when <condition>`", and covered by a hand-written permission test per branch (06 T-36, 07-SECURITY S-4). There is no `x-permission-by-param` / `x-permission-by-kind` extension.
- `catalog.import_invalid` (registered in 03-IC §8) is **not returned** by any C3 operation: imports report problems through `imports.status` (`invalid`/`commit_failed`) and `import_issues`. Retirement of the registry entry is handed to the 03-IC owner.
- Codes (`code`, `doctor_code`, `party_code`) are trimmed and upper-cased before validation; regex per resource (§5.1).
- Lists: cursor pagination (02-CV §4.3), `limit` default 50 max 200, `sort` enum per list, `is_active` filter default `true` (pass `is_active=all` to include inactive) [CONV].
- Errors every operation may return (not repeated): `400 common.validation_failed`, `400 common.unknown_field` (sub-code), `401 auth.unauthenticated|auth.token_invalid|auth.token_expired`, `403 auth.forbidden|auth.mfa_required|auth.account_locked`, `404 common.not_found`, `429 common.rate_limited`, `500 common.internal`, `503 common.dependency_unavailable`. Mutations additionally `409 common.version_conflict`, `428 common.precondition_required`, and where `x-idempotency: required`: `400 common.idempotency_key_required`, `422 common.idempotency_key_reused`, `409 common.idempotency_in_progress`.
- Permissions (9): `catalog.test.read`, `catalog.test.manage`, `catalog.price_list.read`, `catalog.price_list.manage`, `catalog.referrer.manage`, `catalog.instrument_code_map.manage` (03-IC §11) + `catalog.referrer.read`, `catalog.reference_range.publish`, `catalog.referrer.export` (CR-C3-003).

### 5.1 Shared DTOs (JSON, snake_case, `additionalProperties: false`, no nulls — 02-CV §4.2)

| DTO | Fields (type; constraints) |
|---|---|
| `CodeName` (master) | `id` uuid · `code` string `^[A-Z0-9][A-Z0-9_]{0,31}$` · `name` string 1–100 · `is_active` bool · `version` int · `created_at`, `updated_at` IsoUtc |
| `Department` | CodeName + `report_order` int 0–9999 · `report_heading` string ≤100 (opt) |
| `SpecimenType` | CodeName + `report_label` string 1–100 |
| `Container` | CodeName + `additive` ≤60 (opt) · `cap_colour_display` ≤40 (opt) · `default_specimen_type_id` uuid (opt) |
| `Method` | CodeName with `name` 1–120 |
| `Unit` | `id` (tenant rows; addresses #19) · `code` `^[A-Za-z0-9_]{1,32}$` · `display` 1–32 · `scope` enum `global|tenant` · `is_active` · `version` (tenant rows) |
| `ValueSet` | `id` (tenant rows) · `code` `^[A-Z0-9_]{1,32}$` · `display` ≤80 · `is_ordered` bool · `scope` · `values[]` (≤50): `{code ^[A-Z0-9_+\-]{1,16}$, display ≤40, sort_order int, is_active}` |
| `OrderableSummary` | `id` · `kind` `test|panel` · `code` (orderable regex `^[A-Z0-9][A-Z0-9_\-+.]{0,31}$`) · `name` ≤200 · `department_id` (opt) · `department_code` (opt) · `panel_kind` `clinical|package` (panels) · `sex_restriction` `male|female` (opt) · `workflow_type` (tests) · `is_orderable` bool · `is_active` · `revision` int |
| `Test` | OrderableSummary + `department_id` (req) · `workflow_type` enum `standard|narrative|microbiology|anatomic|molecular|attachment|outsourced` (03-IC §4.2) · `report_order` int · `uses_existing_material` bool (default false; CR-C11-009 add-on tests on existing material) · `specimen_requirements[]` `{specimen_type_id, container_id?, is_preferred, min_volume_ul? int 1–100000}` (≤10) · `analytes[]` (Analyte) · `tat_targets[]` (TatTarget) · `version` |
| `Analyte` | `id` · `test_id` · `code` `^[A-Z][A-Z0-9_]{0,31}$` · `name` 1–120 · `print_name` ≤120 (opt) · `report_subheading` ≤80 (opt) · `sort_order` int · `is_reportable` bool · `is_active` · `version` · `current_version` (AnalyteVersion, effective at `as_of`) · `draft_version_id` (opt) |
| `AnalyteVersion` | `id` · `analyte_id` · `version_no` · `status` `draft|published|superseded|retired|discarded` · `result_type` `numeric|text|ordinal|coded|attachment|narrative` · `unit_code` (opt) · `decimals` 0–6 (opt; required for numeric) · `method_id` (opt) · `value_set_code` (opt; required for ordinal/coded; `ordinal` requires a value set with `is_ordered = true`, else `400 common.validation_failed` path `/value_set_code`) · `formula_expression` ≤500 (opt) · `formula_input_codes[]` (read-only) · `effective_from`, `effective_to` (opt) · `change_reason` ≤500 (opt) · `version` |
| `RangeBand` | `sex` `any|male|female` · `age_low` `{value int 0–200, unit day|week|month|year}` (opt = from birth) · `age_high` (opt = no upper) · `specimen_type_id` (opt) · `kind` `numeric|text|ordinal` · `low`, `high` DecimalString (opt) · `normal_codes[]` (≤20, ordinal) · `display_text` ≤500 (opt; required for text/ordinal) · `sort_order` int |
| `RangeSet` | `id` · `analyte_id` · `version_no` · `status` · `unit_code` (snapshot) · `method_id` (snapshot, opt) · `effective_from`/`effective_to` · `change_reason` · `bands[]` (≤100 RangeBand) · `version` |
| `CriticalBand` | `sex`, `age_low`, `age_high`, `specimen_type_id` as RangeBand · `low`, `high` DecimalString (opt) · `abnormal_codes[]` (≤20) — at least one of low/high/abnormal_codes |
| `CriticalSet` | as RangeSet with `bands[]` of CriticalBand |
| `Panel` | OrderableSummary + `panel_kind` · `sex_restriction` (opt) · `members[]` `{kind test|panel, orderable_id, sort_order}` (≤100) · `version` |
| `TatTarget` | `priority` `routine|urgent` · `segment` `within_lab|total` (both targets of a test carry the same segment — #28) · `target_seconds` int 60–2592000 · `effective_from`, `effective_to` (opt) |
| `CommentCode` | `id` · `code` `^[A-Z0-9_]{1,16}$` · `department_id` (opt = all) · `text` 1–2000 · `is_active` · `version` |
| `Doctor` | `id` · `doctor_code` `^[A-Z0-9_\-]{1,20}$` · `display_name` 1–120 · `qualification` ≤120 · `registration_council` ≤20 · `registration_no` ≤30 · `phone_e164` `^\+[1-9][0-9]{7,14}$` (08 A13 P-11) · `email` ≤254 (format email) · `notes` ≤500 · `is_verified` · `source` `back_office|quick_add|import` · `merged_into_id` (opt) · `price_list_id` (opt, read) · `is_active` · `version` — contact fields returned only to holders of `catalog.referrer.manage` (mapper allow-list) |
| `CreditParty` | `id` · `party_code` `^[A-Z0-9_\-]{1,20}$` (optional on create; blank → `CP{seq:5}` via `code_counters` [CONV]) · `name` 1–160 · `kind` `hospital|company|clinic|partner_lab|insurer|other` · `allows_credit` bool · `pan` ≤20 · `contact_phone_e164` `^\+[1-9][0-9]{7,14}$` (08 A13 P-11) · `contact_email` ≤254 (format email) · `billing_address` ≤500 · `price_list_id` (opt, read) · `is_active` · `version` — `pan`, `contact_phone_e164`, `contact_email`, `billing_address` returned only to holders of `catalog.price_list.manage` (mapper allow-list, REQ-SEC-081) |
| `PriceList` | `id` · `code` `^[A-Z0-9][A-Z0-9_\-]{0,31}$` (= `price_lists__code__ck`) · `name` ≤120 · `owner_kind` `default|credit_party|referrer|centre` · `falls_through` bool · `assignments[]` `{owner_id}` (≤500; empty for default) · `current_version` `{id, version_no, effective_from}` (opt) · `scheduled_version` (opt) · `draft_version_id` (opt) · `is_active` · `version` |
| `PriceListVersion` | `id` · `price_list_id` · `version_no` · `status` · `effective_from`/`effective_to` · `item_count` · `source_import_id` (opt) · `change_reason` · `version` |
| `PriceItem` | `orderable_id` · `orderable_code` (read) · `orderable_kind` (read) · `unit_price` Money `{amount_paisa 0–999999999, currency NPR}` |
| `SurchargeRule` | `id` · `scope` `all|department|orderable` · `department_id`/`orderable_id` (per scope) · `price_list_id` (opt) · `amount_kind` `flat|percent` · `amount` Money (flat) · `percent_bp` 1–100000 (percent) · `effective_from`/`effective_to` · `version` |
| `TaxType` | `id` · `code` `^[A-Z0-9_]{1,16}$` · `display` ≤60 · `rate_bp` 0–10000 (opt = not configured) · `effective_from` · `effective_to` (opt) · `scope` · `is_active` · `version` — tenant rows are effective-dated versions of one code (08 R18) |
| `TaxRule` | `id` · `scope` `tenant_default|department|orderable` · `department_id`/`orderable_id` · `vat_treatment` `exempt|taxable` · `other_tax_code` (opt) · `hs_code` `^[0-9]{4,8}$` (opt; 04 L10 applicability UNVERIFIED) · `effective_from`/`effective_to` · `version` |
| `InstrumentCodeMap` | `id` · `instrument_id` uuid · `direction` `inbound|outbound|both` · `instrument_code` 1–64 · `analyte_id` · `test_id` · `unit_from_raw` ≤32 (opt) · `unit_to_code` (opt) · `unit_factor` DecimalString (opt; all three or none) · `flag_map` object ≤20 entries `{string ≤16: Code}` (opt) · `is_active` · `version` |
| `Import` | `id` · `kind` `price_list|catalog_master|referrers|credit_parties` · `target_price_list_id` (opt) · `base_version_no` (opt; written by the validate task from `_meta`, §8.3) · `status` (03-APP-FLOW §2.2) · `file_name` ≤200 · `file_sha256` · `summary` `{rows, added, changed, removed, unchanged, errors, warnings}` · `deduplicated` bool (create response only) · `result_price_list_version_id` (opt) · `expires_at` · `created_at`, `created_by` · `version` |
| `ImportIssue` | `seq` · `severity` `error|warning` · `sheet` ≤31 · `row_no` int (opt) · `column` ≤40 (opt) · `issue_code` (x-coded-set `catalog_import_issue_codes`, §8.6) · `message` ≤300 |
| `Export` | `id` · `kind` `price_list|catalog_master|referrers` · `status` `queued|building|ready|failed|expired` · `file_name` (opt) · `byte_size` (opt) · `expires_at` (opt) · `version` |

### 5.2 Operations

Legend: **Idem** = `x-idempotency` (R = required, O = optional, – = none). **Perm** = `x-permission`. Status codes listed are the success code + operation-specific errors (`x-error-codes`) in addition to §5.0.

#### Revision, search, health

| # | Method + path | operationId | Perm | Idem | Request | Response | Specific errors |
|---|---|---|---|---|---|---|---|
| 1 | GET `/v1/catalog/revision` | `getCatalogRevision` | catalog.test.read | – | – | `200 {catalog_revision, global_release_seen}` | – |
| 2 | GET `/v1/catalog/orderables` | `searchOrderables` | catalog.test.read | – | query `q` (1–64, required), `kind` (test,panel), `panel_kind`, `department_id`, `is_orderable` (default true), `is_active` (default true), `limit` (default 20, max 50) | `200 {data: OrderableSummary[]}` ranked §7.9 (no cursor) | – |
| 3 | POST `/v1/catalog/orderables/resolve` | `resolveOrderablesPreview` | catalog.test.read | – | `{orderable_ids[] (1–50), as_of?}` | `200` = port `ResolvedOrderables` in snake_case | `409 catalog.test_inactive`, `422 catalog.panel_cycle` |
| 4 | GET `/v1/catalog/health-report` | `getCatalogHealthReport` | catalog.test.read | – | – | `200 {active_orderables_without_default_price[], analytes_without_reference_range[], tests_without_specimen_type[], tests_missing_required_analyte[], tax_default_configured bool, unmapped_formula_inputs[]}` (each ≤200 ids + `truncated` bool) | – |

#### Masters (departments, specimen types, containers, methods)

For each resource R ∈ {`departments`→Department, `specimen-types`→SpecimenType, `containers`→Container, `methods`→Method}:

| # | Method + path | operationId (R = Department, SpecimenType, Container, Method) | Perm | Idem | Request | Response | Specific errors |
|---|---|---|---|---|---|---|---|
| 5–8 | GET `/v1/catalog/{R}` | `list{R}s` | catalog.test.read | – | `id` (uuid; single-item read), `is_active`, `cursor`, `limit`, `sort` (`code`,`name`,`report_order`) | `200 {data, page}` | – |
| 9–12 | POST `/v1/catalog/{R}` | `create{R}` | catalog.test.manage | R | DTO minus id/version/timestamps | `201` DTO | `409 catalog.code_duplicate` |
| 13–16 | PATCH `/v1/catalog/{R}/{id}` | `update{R}` | catalog.test.manage | – | any mutable field + `is_active`; `code` immutable | `200` DTO | `409 catalog.code_duplicate` |

(12 operations: `listDepartments`, `createDepartment`, `updateDepartment`, `listSpecimenTypes`, `createSpecimenType`, `updateSpecimenType`, `listContainers`, `createContainer`, `updateContainer`, `listMethods`, `createMethod`, `updateMethod`; single-item GET is served by list filter `id=` [CONV] to keep the surface small.)

#### Units and value sets

| # | Method + path | operationId | Perm | Idem | Request | Response | Specific errors |
|---|---|---|---|---|---|---|---|
| 17 | GET `/v1/catalog/units` | `listUnits` | catalog.test.read | – | `scope`, `is_active` | `200 {data: Unit[]}` (global ∪ tenant; tenant shadows global by code) | – |
| 18 | POST `/v1/catalog/units` | `createUnit` | catalog.test.manage | R | `{code, display}` | `201 Unit` | `409 catalog.code_duplicate` (also if global code exists) |
| 19 | PATCH `/v1/catalog/units/{unit_id}` | `updateUnit` | catalog.test.manage | – | `{display?, is_active?}` | `200` | – |
| 20 | GET `/v1/catalog/value-sets` | `listValueSets` | catalog.test.read | – | `scope` | `200 {data: ValueSet[]}` | – |
| 21 | POST `/v1/catalog/value-sets` | `createValueSet` | catalog.test.manage | R | `{code, display, is_ordered, values[]}` | `201` | `409 catalog.code_duplicate` |
| 22 | PATCH `/v1/catalog/value-sets/{value_set_id}` | `updateValueSet` | catalog.test.manage | – | `{display?, is_active?, values?[]}` — values matched by `code`; new codes appended; existing codes: `display`/`is_active` editable; `sort_order` and removal of a code are rejected once any published analyte version references the set | `200` | `409 catalog.version_in_use` |

#### Tests, analytes, analyte versions, formulas, TAT

| # | Method + path | operationId | Perm | Idem | Request | Response | Specific errors |
|---|---|---|---|---|---|---|---|
| 23 | GET `/v1/catalog/tests` | `listTests` | catalog.test.read | – | `department_id`, `workflow_type`, `is_active`, `cursor`, `limit`, `sort` (`code`,`name`,`report_order`) | `200 {data: OrderableSummary[], page}` | – |
| 24 | POST `/v1/catalog/tests` | `createTest` | catalog.test.manage | R | `{code, name, department_id, workflow_type, report_order?, is_orderable?, uses_existing_material?, specimen_requirements[]}` | `201 Test` | `409 catalog.code_duplicate` |
| 25 | GET `/v1/catalog/tests/{test_id}` | `getTestDetail` | catalog.test.read | – | `as_of?` | `200 Test` | – |
| 26 | PATCH `/v1/catalog/tests/{test_id}` | `updateTest` | catalog.test.manage | – | `{name?, department_id?, workflow_type?, report_order?, is_orderable?, uses_existing_material?, is_active?}` (`workflow_type` change only while no analyte version is published [CONV]) | `200 Test` | `409 catalog.version_in_use` |
| 27 | PUT `/v1/catalog/tests/{test_id}/specimen-requirements` | `replaceTestSpecimenRequirements` | catalog.test.manage | – | `{specimen_requirements[] (1–10, exactly one is_preferred)}` | `200 Test` | – |
| 28 | PUT `/v1/catalog/tests/{test_id}/tat-targets` | `setTestTatTargets` | catalog.test.manage | – | `{targets[] (≤2, one per priority), effective_from?}` — ends current rows, inserts new; both targets must have the same `segment` (else `400 common.validation_failed` path `/targets/1/segment`), so `TestDefinition.tatTargetSegment` is single-valued | `200 Test` | – |
| 29 | POST `/v1/catalog/tests/{test_id}/analytes` | `createAnalyte` | catalog.test.manage | R | Analyte fields + `initial_version` (AnalyteVersion draft fields) | `201 Analyte` (with `draft_version_id`) | `409 catalog.code_duplicate`, `422 catalog.formula_invalid` |
| 30 | GET `/v1/catalog/analytes/{analyte_id}` | `getAnalyte` | catalog.test.read | – | `as_of?` | `200 Analyte + versions[] (AnalyteVersion, newest first, ≤50)` | – |
| 31 | PATCH `/v1/catalog/analytes/{analyte_id}` | `updateAnalyte` | catalog.test.manage | – | `{name?, print_name?, report_subheading?, sort_order?, is_reportable?, is_active?}` | `200` | – |
| 32 | POST `/v1/catalog/analytes/{analyte_id}/versions` | `createAnalyteVersionDraft` | catalog.test.manage | R | `{copy_from_version_no?}` (default latest published) | `201 AnalyteVersion` | `409 common.version_conflict` (draft exists) |
| 33 | PATCH `/v1/catalog/analyte-versions/{analyte_version_id}` | `updateAnalyteVersionDraft` | catalog.test.manage | – | clinical fields of AnalyteVersion | `200` | `409 catalog.version_in_use` (not draft), `422 catalog.formula_invalid` |
| 34 | POST `/v1/catalog/analyte-versions/{analyte_version_id}/publish` | `publishAnalyteVersion` | catalog.reference_range.publish (privileged; clinical sign-off, 08 A13 D-18) + `catalog.test.manage` (always, asserted in the handler) | R | `{effective_from?, change_reason (1–500), reference_range_set_id?, critical_limit_set_id?, allow_without_ranges? bool}` | `200 AnalyteVersion` | `409 catalog.version_in_use`, `422 catalog.formula_invalid` |
| 35 | POST `/v1/catalog/analyte-versions/{analyte_version_id}/discard` | `discardAnalyteVersionDraft` | catalog.test.manage | – | – | `200` | `409 catalog.version_in_use` |
| 36 | POST `/v1/catalog/formulas/validate` | `validateFormula` | catalog.test.read | – | `{analyte_id? (for cycle check context), expression (1–500), sample_inputs? {code: DecimalString}, sample_context? {age_days, sex}}` | `200 {valid, input_analyte_codes[], dependency_order[], chain_depth, sample_result? DecimalString, sample_not_computable_reason?, errors[]}` | – (invalid formulas return `200 valid:false` here; only mutations return `422 catalog.formula_invalid`) |

#### Reference-range sets and critical-limit sets

For S ∈ {`reference-range-sets` → RangeSet / prefix `ReferenceRangeSet`, `critical-limit-sets` → CriticalSet / prefix `CriticalLimitSet`}:

| # | Method + path | operationId | Perm | Idem | Request | Response | Specific errors |
|---|---|---|---|---|---|---|---|
| 37/44 | GET `/v1/catalog/analytes/{analyte_id}/{S}` | `list{P}s` | catalog.test.read | – | `status` | `200 {data}` (newest first) | – |
| 38/45 | POST `/v1/catalog/analytes/{analyte_id}/{S}` | `create{P}Draft` | catalog.test.manage | R | `{copy_from_set_id?, bands[]?}`; `unit_code`/`method_id` snapshot taken from the analyte's draft version if one exists, else current published | `201` | `409 common.version_conflict` (draft exists) |
| 39/46 | GET `/v1/catalog/{S}/{set_id}` | `get{P}` | catalog.test.read | – | – | `200` | – |
| 40/47 | PUT `/v1/catalog/{S}/{set_id}/bands` | `replace{P}Bands` | catalog.test.manage | – | `{bands[] (1–100)}` | `200` | `409 catalog.version_in_use` |
| 41/48 | POST `/v1/catalog/{S}/{set_id}/publish` | `publish{P}` | catalog.reference_range.publish (privileged) | R | `{effective_from?, change_reason}` | `200` | `409 catalog.version_in_use`, `400 common.validation_failed` (overlap/unit mismatch) |
| 42/49 | POST `/v1/catalog/{S}/{set_id}/retire` | `retire{P}` | catalog.reference_range.publish | R | `{change_reason, effective_at?}` | `200` | `409 catalog.version_in_use` (not published) |
| 43/50 | POST `/v1/catalog/{S}/{set_id}/discard` | `discard{P}Draft` | catalog.test.manage | – | – | `200` | `409 catalog.version_in_use` |
| 51 | POST `/v1/catalog/reference-ranges/preview` | `previewReferenceRange` | catalog.test.read | – | `{analyte_id, sex, age_days, birth_on?, specimen_type_code?, at?}` | `200 {reference_range?: ReferenceRangeMatch, critical_limits?: CriticalLimitsMatch, no_reference_range: bool}` | – |

(operationIds: `listReferenceRangeSets`, `createReferenceRangeSetDraft`, `getReferenceRangeSet`, `replaceReferenceRangeSetBands`, `publishReferenceRangeSet`, `retireReferenceRangeSet`, `discardReferenceRangeSetDraft`, and the same seven with `CriticalLimitSet`.)

#### Panels and packages

| # | Method + path | operationId | Perm | Idem | Request | Response | Specific errors |
|---|---|---|---|---|---|---|---|
| 52 | GET `/v1/catalog/panels` | `listPanels` | catalog.test.read | – | `panel_kind`, `is_active`, cursor | `200` | – |
| 53 | POST `/v1/catalog/panels` | `createPanel` | catalog.test.manage | R | `{code, name, panel_kind, sex_restriction?, department_id?, members[]}` | `201 Panel` | `409 catalog.code_duplicate`, `422 catalog.panel_cycle`, `409 catalog.test_inactive` |
| 54 | GET `/v1/catalog/panels/{panel_id}` | `getPanelDetail` | catalog.test.read | – | – | `200 Panel` | – |
| 55 | PATCH `/v1/catalog/panels/{panel_id}` | `updatePanel` | catalog.test.manage | – | `{name?, sex_restriction?, unset?, department_id?, is_active?}` | `200` | – |
| 56 | PUT `/v1/catalog/panels/{panel_id}/members` | `replacePanelMembers` | catalog.test.manage | – | `{members[] (1–100)}` | `200` | `422 catalog.panel_cycle`, `409 catalog.test_inactive` |

#### Comment codes

| # | Method + path | operationId | Perm | Idem | Request | Response | Specific errors |
|---|---|---|---|---|---|---|---|
| 57 | GET `/v1/catalog/comment-codes` | `listCommentCodes` | catalog.test.read | – | `department_id` (includes tenant-wide), `code_prefix` (≤16), cursor | `200` | – |
| 58 | POST `/v1/catalog/comment-codes` | `createCommentCode` | catalog.test.manage | R | `{code, department_id?, text}` | `201` | `409 catalog.code_duplicate` |
| 59 | PATCH `/v1/catalog/comment-codes/{comment_code_id}` | `updateCommentCode` | catalog.test.manage | – | `{text?, is_active?}` | `200` | – |

#### Doctors (referrers)

| # | Method + path | operationId | Perm | Idem | Request | Response | Specific errors |
|---|---|---|---|---|---|---|---|
| 60 | POST `/v1/catalog/doctors/search` | `searchDoctors` | catalog.referrer.read | – | `{q (1–64), include_unverified? (default true), include_inactive? (default false), limit? (≤50)}` — match: `doctor_code` prefix (upper-cased `q`) OR `name_normalised` contains the normalised `q` (escaped LIKE, REQ-SEC-082); rank exact code, code prefix, name prefix, name contains, then `doctor_code`; ≤ 5,000 doctors/tenant (ASSUMPTION) → `(tenant_id, name_normalised)` B-tree + heap scan | `200 {data: DoctorSummary[]}` (`id, doctor_code, display_name, qualification, is_verified, is_active, canonical_doctor_id`) | – |
| 61 | GET `/v1/catalog/doctors` | `listDoctors` | catalog.referrer.read | – | `is_verified`, `is_active`, `source`, cursor, `sort` (`doctor_code`,`created_at`) | `200 {data: DoctorSummary[], page}` | – |
| 62 | POST `/v1/catalog/doctors` | `createDoctor` | catalog.referrer.manage | R | Doctor fields (no code → auto) + `quick_add` bool | `201 Doctor + possible_duplicate_of[]` | `409 catalog.code_duplicate` (explicit code taken) |
| 63 | GET `/v1/catalog/doctors/{doctor_id}` | `getDoctor` | catalog.referrer.read | – | – | `200 Doctor` (contacts only with referrer.manage) | – |
| 64 | PATCH `/v1/catalog/doctors/{doctor_id}` | `updateDoctor` | catalog.referrer.manage | – | mutable Doctor fields, `unset[]` | `200` | – |
| 65 | POST `/v1/catalog/doctors/{doctor_id}/verify` | `verifyDoctor` | catalog.referrer.manage | – | – | `200` | `409 catalog.version_in_use` (merged) |
| 66 | POST `/v1/catalog/doctors/{doctor_id}/merge` | `mergeDoctor` | catalog.referrer.manage | R | `{into_doctor_id}` (≠ self, active, not itself merged) | `200 Doctor` | `400 common.validation_failed` |

#### Credit parties

| # | Method + path | operationId | Perm | Idem | Request | Response | Specific errors |
|---|---|---|---|---|---|---|---|
| 67 | GET `/v1/catalog/credit-parties` | `listCreditParties` | catalog.price_list.read | – | `kind`, `allows_credit`, `is_active`, `q` (code prefix only, ≤20), cursor | `200` | – |
| 68 | POST `/v1/catalog/credit-parties` | `createCreditParty` | catalog.price_list.manage | R | CreditParty fields | `201` | `409 catalog.code_duplicate` |
| 69 | GET `/v1/catalog/credit-parties/{credit_party_id}` | `getCreditParty` | catalog.price_list.read | – | – | `200` | – |
| 70 | PATCH `/v1/catalog/credit-parties/{credit_party_id}` | `updateCreditParty` | catalog.price_list.manage | – | mutable fields | `200` | – |

#### Price lists

| # | Method + path | operationId | Perm | Idem | Request | Response | Specific errors |
|---|---|---|---|---|---|---|---|
| 71 | GET `/v1/catalog/price-lists` | `listPriceLists` | catalog.price_list.read | – | `owner_kind`, `owner_id`, `is_active`, cursor | `200` | – |
| 72 | POST `/v1/catalog/price-lists` | `createPriceList` | catalog.price_list.manage | R | `{code, name, owner_kind, falls_through?, assignments[]}` → creates list + empty draft v1 | `201 PriceList` | `409 catalog.code_duplicate` (code, second default, or owner already assigned) |
| 73 | GET `/v1/catalog/price-lists/{price_list_id}` | `getPriceListDetail` | catalog.price_list.read | – | – | `200 PriceList + versions[] (≤50)` | – |
| 74 | PATCH `/v1/catalog/price-lists/{price_list_id}` | `updatePriceList` | catalog.price_list.manage | – | `{name?, falls_through?, is_active?}` (default list cannot be deactivated) | `200` | `400 common.validation_failed` |
| 75 | PUT `/v1/catalog/price-lists/{price_list_id}/assignments` | `replacePriceListAssignments` | catalog.price_list.manage | – | `{owner_ids[] (≤500)}` of the list's owner_kind | `200` | `409 catalog.code_duplicate` (owner has another list) |
| 76 | POST `/v1/catalog/price-lists/{price_list_id}/versions` | `createPriceListVersionDraft` | catalog.price_list.manage | R | `{copy_from_version_no?}` | `201 PriceListVersion` | `409 common.version_conflict` (draft exists) |
| 77 | GET `/v1/catalog/price-list-versions/{price_list_version_id}/items` | `listPriceListItems` | catalog.price_list.read | – | `orderable_kind`, `department_id`, cursor, `sort` (`orderable_code`) | `200 {data: PriceItem[], page}` | – |
| 78 | POST `/v1/catalog/price-list-versions/{price_list_version_id}/items/bulk-upsert` | `upsertPriceListItems` | catalog.price_list.manage | R | `{items[] (1–200) PriceItem(orderable_id, unit_price)}` | `200 {results[] {orderable_id, outcome created|updated|unchanged|error, error_code?}}` | `409 catalog.version_in_use` |
| 79 | POST `/v1/catalog/price-list-versions/{price_list_version_id}/items/bulk-remove` | `removePriceListItems` | catalog.price_list.manage | R | `{ids[] (orderable ids, 1–200)}` | `200 {results[]}` | `409 catalog.version_in_use` |
| 80 | POST `/v1/catalog/price-list-versions/{price_list_version_id}/publish` | `publishPriceListVersion` | catalog.price_list.manage | R | `{effective_from?, change_reason}` | `200 PriceListVersion` | `409 catalog.version_in_use` |
| 81 | POST `/v1/catalog/price-list-versions/{price_list_version_id}/discard` | `discardPriceListVersionDraft` | catalog.price_list.manage | – | – | `200` | `409 catalog.version_in_use` |
| 82 | POST `/v1/catalog/prices/quote` | `quotePrices` | catalog.price_list.read | – | `{items[] (1–50) {orderable_id, priority}, context {price_list_id?, credit_party_id?, referrer_id?, centre_id?}, at?}` | `200 {quotes[] (PriceQuote snake_case) | {orderable_id, error_code}}` | – |

#### Surcharge, tax

| # | Method + path | operationId | Perm | Idem | Request | Response | Specific errors |
|---|---|---|---|---|---|---|---|
| 83 | GET `/v1/catalog/surcharge-rules` | `listSurchargeRules` | catalog.price_list.read | – | `scope`, `active_at?` | `200` | – |
| 84 | POST `/v1/catalog/surcharge-rules` | `createSurchargeRule` | catalog.price_list.manage | R | SurchargeRule fields | `201` | `400 common.validation_failed` path `/effective_from` (overlap with same scope + key + `price_list_id`; checked after taking the `catalog_state` lock, §7.5) |
| 85 | POST `/v1/catalog/surcharge-rules/{surcharge_rule_id}/end` | `endSurchargeRule` | catalog.price_list.manage | – | `{effective_to?}` | `200` | – |
| 86 | GET `/v1/catalog/tax-types` | `listTaxTypes` | catalog.price_list.read | – | `active_at?` (default now; `all_versions=true` lists the rate history) | `200` (global VAT + tenant types, version effective at `active_at`) | – |
| 87 | POST `/v1/catalog/tax-types` | `createTaxType` | catalog.price_list.manage | R | `{code, display, rate_bp?, effective_from?}` (default now) | `201` | `409 catalog.code_duplicate` |
| 88 | PATCH `/v1/catalog/tax-types/{tax_type_id}` | `updateTaxType` | catalog.price_list.manage | – | `{display?, rate_bp?, effective_from?, is_active?}` — a `rate_bp` change requires `effective_from` (≥ now − tolerance) and is stored as a **new version row** of the code (the predecessor gets `effective_to = effective_from`); a stored rate is never edited in place (08 R18) | `200` (the version now current or scheduled) | `400 common.validation_failed` (rate change without `effective_from`, back-dated) |
| 89 | GET `/v1/catalog/tax-rules` | `listTaxRules` | catalog.price_list.read | – | `scope`, `active_at?` | `200` | – |
| 90 | POST `/v1/catalog/tax-rules` | `createTaxRule` | catalog.price_list.manage | R | TaxRule fields — overlap rule §7.6 (successor of the open `tenant_default` ends its predecessor in the same transaction) | `201` | `400 common.validation_failed` (path `/effective_from` on overlap; `/other_tax_code` when the tax type has no rate) |
| 91 | POST `/v1/catalog/tax-rules/{tax_rule_id}/end` | `endTaxRule` | catalog.price_list.manage | – | `{effective_to?}` (tenant default can only be ended by creating its successor) | `200` | `400 common.validation_failed` |

#### Instrument code maps (writes come from C7's UI — X4)

`catalog.instrument_code_map.manage` is **privileged** (aal2) per 08 A13 D-18 (a wrong map writes analyser values into the wrong analyte); `lab_manager` already has `mfa_required: true`.

| # | Method + path | operationId | Perm | Idem | Request | Response | Specific errors |
|---|---|---|---|---|---|---|---|
| 92 | GET `/v1/catalog/instrument-code-maps` | `listInstrumentCodeMaps` | catalog.instrument_code_map.manage | – | `instrument_id` (required), `direction`, `analyte_id`, `is_active`, cursor | `200` | – |
| 93 | POST `/v1/catalog/instrument-code-maps` | `createInstrumentCodeMap` | catalog.instrument_code_map.manage | R | InstrumentCodeMap fields | `201` | `409 catalog.code_duplicate` |
| 94 | PATCH `/v1/catalog/instrument-code-maps/{map_id}` | `updateInstrumentCodeMap` | catalog.instrument_code_map.manage | – | `{unit_from_raw?, unit_to_code?, unit_factor?, flag_map?, unset?, is_active?}` (`instrument_id`, `instrument_code`, `analyte_id` immutable: deactivate + create) | `200` | `409 catalog.code_duplicate` (reactivation clash) |
| 95 | POST `/v1/catalog/instrument-code-maps/bulk-upsert` | `upsertInstrumentCodeMaps` | catalog.instrument_code_map.manage | R | `{instrument_id, maps[] (1–200)}` keyed by (direction, instrument_code / analyte_id) | `200 {results[] per row}` | – |

#### Imports and exports

| # | Method + path | operationId | Perm | Idem | Request | Response | Specific errors |
|---|---|---|---|---|---|---|---|
| 96 | GET `/v1/catalog/import-templates/{kind}` | `downloadImportTemplate` | `catalog.test.read` (floor) + `catalog.price_list.read` when `kind` ∈ {price_list, credit_parties} · + `catalog.referrer.read` when `kind = referrers` (P-10, handler) | – | path `kind` | `200 application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`, `Content-Disposition: attachment` | – |
| 97 | POST `/v1/catalog/imports` | `createImport` | `catalog.test.read` (floor) + `catalog.price_list.manage` when `kind` ∈ {price_list, credit_parties (CR-C18-008)} · + `catalog.test.manage` when `kind = catalog_master` · + `catalog.referrer.manage` when `kind = referrers` (P-10, handler) | R | `multipart/form-data` (`x-upload: [application/vnd.openxmlformats-officedocument.spreadsheetml.sheet]`): `kind`, `target_price_list_id` (price_list only), `file` (binary, ≤15 MB) | `201 Import` (or `200 Import` with `deduplicated: true`) | `413 common.payload_too_large`, `415 common.unsupported_media_type`, `429 common.rate_limited` |
| 98 | GET `/v1/catalog/imports` | `listImports` | catalog.test.read (rows filtered to kinds the caller may manage) | – | `kind`, `status`, cursor | `200` | – |
| 99 | GET `/v1/catalog/imports/{import_id}` | `getImport` | as #97 for the import's kind | – | – | `200 Import` | – |
| 100 | GET `/v1/catalog/imports/{import_id}/issues` | `listImportIssues` | as #97 | – | `severity`, cursor | `200 {data: ImportIssue[], page}` | – |
| 101 | GET `/v1/catalog/imports/{import_id}/report-file` | `downloadImportReport` | as #97 | – | – | `200` xlsx attachment | `409 common.version_conflict` with `detail: "file_not_ready"` (report not yet built; reuse accepted in 08 A13 D-20, precedent A2.10) |
| 102 | POST `/v1/catalog/imports/{import_id}/commit` | `commitImport` | as #97 for the import's kind · + `catalog.reference_range.publish` when `kind = catalog_master` and the commit creates or publishes analyte versions, range sets or critical sets (08 A13 D-18; decided from the validation summary) | R | `{effective_from?, change_reason (1–500), accept_stale_base? bool, publish? bool (default true; false = leave the new price-list version as draft), replace_draft? bool (default false; discards open drafts of the targets first, §8.5)}` | `202 Import` (status `committing`) | `409 catalog.import_not_committable`, `409 catalog.import_stale_base` |
| 103 | POST `/v1/catalog/imports/{import_id}/discard` | `discardImport` | as #97 | – | – | `200` | `409 catalog.import_not_committable` |
| 104 | POST `/v1/catalog/exports` | `createExport` | `catalog.test.read` (floor) + `catalog.price_list.manage` (privileged) when `kind = price_list` · + `catalog.test.manage` when `kind = catalog_master` (P0 master data only — not a privileged export, 08 A13 D-22) · + `catalog.referrer.export` (privileged) when `kind = referrers` (P-10, handler) | R | `{kind, price_list_version_id? (price_list)}` | `202 Export` | – |
| 105 | GET `/v1/catalog/exports/{export_id}` | `getExport` | as #104 for the export's kind | – | – | `200` | – |
| 106 | GET `/v1/catalog/exports/{export_id}/file` | `downloadExportFile` | as #104 for the export's kind | – | – | `200` xlsx attachment (streamed through API → BFF; `Content-Disposition: attachment`, `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`) | `409 common.version_conflict` with `detail: "file_not_ready"` (status ≠ `ready`; 08 A13 D-20) |
| 107 | GET `/v1/catalog/exports` | `listExports` | `catalog.test.read` (rows filtered in the handler to the kinds the caller may export, as #98) | – | `kind`, `status`, cursor, `limit` | `200 {data: Export[], page}` (newest first) | – |

Per-kind permissions in #96–#107 follow 08 A13 P-10: the spec's `x-permission` is the floor `catalog.test.read`; the kind-dependent permission is asserted in the handler right after the import/export row (or the `kind` parameter) is known; `auth.forbidden` and `auth.mfa_required` are in each operation's `x-error-codes`; each kind → permission branch has a hand-written permission test (06 T-36). No vendor extension is used.

Access-log calls (08 A13 P-3; every `action` exists in the 03-IC §13.1 seed):

| Operation | `action` | `entityType` | `entityId` |
|---|---|---|---|
| #96 `downloadImportTemplate` | `data.export` | `catalog_file` | — (template kind in `detail.kind`) [CONV] |
| #101 `downloadImportReport` | `data.export` | `catalog_file` | report file id |
| #106 `downloadExportFile` (kinds `price_list`, `catalog_master`) | `data.export` | `catalog_file` | export file id |
| #106 `downloadExportFile` (kind `referrers`) | `data.export` | `referrer_export` | export file id |

Each call carries `outcome` (04 D11; REQ-SEC-096; seed comment in 08 §4.4 "C3: catalog file / referrer exports use existing data.export"). No other C3 handler calls `ctx.audit.access`.

## 6. Ports

### 6.1 Implemented: `CatalogPort` (03-IC §4.2 + CR-C3-001 additions)

File `services/api/src/modules/catalog/ports/CatalogPort.impl.ts`. Signatures from 03-IC §4.2 are unchanged; CR-C3-001 as accepted in `program/08-CR-REGISTER.md` §4.14 (merged with CR-C4-002, CR-C5-001, CR-C11-009, CR-C13-007, CR-C6-012/R25) adds **optional** fields and three methods (backward compatible, still `CATALOG_PORT_VERSION = 1`; consumers C4, C5, C6, C7, C9, C10, C11, C12, C13, C14, C16):

```ts
// final additions (08 §4.14; contracts/ports/CatalogPort.ts)
export interface RangeQuery { /* existing */ readonly analyteId: Uuidv7; readonly sex: Sex;
  readonly ageDays?: number;                                      // optional since 08 A17.1 (CR-C5-012): absent = patient age unknown —
                                                                  //   only bands/limits with no age restriction match (§7.3); birthOn is then ignored
  readonly specimenTypeCode?: Code; readonly at: IsoUtc;
  readonly birthOn?: IsoDate; }                                   // NEW optional: exact calendar age when known (used only with ageDays)
export interface ReferenceRangeMatch { /* existing fields */
  readonly kind?: 'numeric' | 'text' | 'ordinal';                 // NEW: text = print only, never flag
  readonly normalCodes?: readonly Code[]; }                       // NEW: ordinal expected codes
export interface AnalyteDefinition { /* existing fields */
  readonly formula?: { readonly expression: string; readonly inputAnalyteCodes: readonly Code[];
                       readonly inputUnitCodes?: Readonly<Record<Code, Code>> };   // NEW optional snapshot
  readonly printName?: string;                                    // NEW optional
  readonly ordinalSetValues?: readonly { readonly code: string; readonly display: string; readonly sortOrder: number }[]; }
                                                                  // NEW (08 A13 D-9): active values of ordinalSetCode, sortOrder asc; present iff ordinalSetCode is set
export interface TestDefinition { /* existing fields */
  readonly departmentName?: string;                               // NEW (R25): C6 report headings
  readonly tatTargetSegment?: 'within_lab' | 'total';             // NEW
  readonly specimenReportLabel?: string;                          // NEW: printed "Specimen:" line (00 §4)
  readonly usesExistingMaterial?: boolean; }                      // NEW (CR-C11-009): C5 creates results without a specimen requirement
export interface PriceQuote { /* existing */
  readonly tax: { readonly vat: 'exempt' | 'taxable'; readonly otherTaxCode?: Code;
                  readonly vatRateBp?: number; readonly otherTaxRateBp?: number; readonly hsCode?: string }; }   // rates owned by C3 (R18)
export type CatalogPartyPurpose = 'display' | 'notification' | 'billing';
export interface ReferrerProfile {
  readonly referrerId: Uuidv7; readonly canonicalReferrerId: Uuidv7; readonly code: Code; readonly displayName: string;
  readonly qualification?: string; readonly registrationNo?: string; readonly isVerified: boolean; readonly isActive: boolean;
  readonly contact?: { readonly phoneE164?: string; readonly email?: string };  // purpose 'notification' + actor user|system only
}
export interface CreditPartyProfile {
  readonly creditPartyId: Uuidv7; readonly code: Code; readonly name: string;
  readonly kind: 'hospital' | 'company' | 'clinic' | 'partner_lab' | 'insurer' | 'other';
  readonly allowsCredit: boolean; readonly isActive: boolean; readonly priceListId?: Uuidv7;
  readonly pan?: string; readonly billingAddressText?: string;                  // purpose 'billing' only (C4 receipts/periodic invoices)
  readonly contact?: { readonly phoneE164?: string; readonly email?: string };  // purpose 'notification' only
}
export interface CommentCodeResolution {
  readonly resolved: readonly { readonly code: Code; readonly commentCodeId: Uuidv7; readonly version: number;
                                readonly departmentId?: Uuidv7; readonly text: string }[];
  readonly unknown: readonly Code[];
}
export interface CatalogPortV1 { /* 7 existing methods: signatures unchanged except RangeQuery.ageDays (08 A17.1). @throws as C3 implements them
   *  (03-IC §4.2 contract cases (1), (2), (23); JSDoc rows for 03-IC §4.2 — final sweep f-11):
   *    getTest            @throws common.not_found; catalog.test_inactive (requireActive)
   *    getPanel           @throws common.not_found; catalog.test_inactive (requireActive)
   *    resolveOrderables  @throws common.not_found; catalog.test_inactive; catalog.panel_cycle
   *    priceFor           @throws catalog.no_price; catalog.tax_config_missing; common.not_found
   *    referenceRangeFor  @throws catalog.no_reference_range; common.not_found
   *    criticalLimitsFor  @throws common.not_found (no set effective → undefined, never an error)
   *    mapInstrumentCode  @throws catalog.instrument_code_unmapped */
  /** NEW. @throws common.not_found; auth.forbidden (purpose 'notification' from device/portal/patient/partner actor) */
  getReferrer(ctx: RequestContext, input: { referrerId: Uuidv7; purpose: 'display' | 'notification' }): Promise<ReferrerProfile>;
  /** NEW. @throws common.not_found; auth.forbidden (purpose 'notification'|'billing' from a non user/system actor) */
  getCreditParty(ctx: RequestContext, input: { creditPartyId: Uuidv7; purpose: CatalogPartyPurpose }): Promise<CreditPartyProfile>;
  /** NEW (absorbs CR-C5-001; `searchCommentCodes` is not a port method — the C5 picker uses C3's HTTP list #57 `listCommentCodes`).
   *  Department-specific active code wins over tenant-wide; unknown/inactive codes → `unknown`; ≤ 50 codes.
   *  `asOf` returns the text version effective then. @throws common.validation_failed */
  resolveCommentCodes(ctx: RequestContext, input: { codes: readonly Code[]; departmentId?: Uuidv7; asOf?: IsoUtc }): Promise<CommentCodeResolution>;
  /** NEW (08 Addendum A2.2, CR-C12-010, additive; signature verbatim from 03-IC §4.2 / 08 Addendum A4.1, which supersedes the A2.2 text).
   *  No 'exempt' kind: exemption is a treatment (`tax_rules.vat_treatment`), not a rate (08 A4.1). `effectiveFrom` null for the global VAT row.
   *  @throws catalog.tax_config_missing */
  getTaxRate(ctx: RequestContext, input: { taxCode: string; on: string /* ISO date, tenant timezone */ }): Promise<{ taxCode: string; ratePercentBasisPoints: number; kind: 'vat' | 'other'; effectiveFrom: string | null }>;
  /** NEW (08 Addendum A24.1, CR-C16-023, additive; consumer C16 — staff validation of a membership plan's price_list_id).
   *  A24.1's status set is replaced by C3's own set, as A24.1 allows: price-list versions have
   *  'draft' | 'published' | 'superseded' | 'discarded' (05-SCHEMA `price_list_versions__status__ck`); there is no 'retired' —
   *  a price list is retired by deactivating it (`isActive = false`; 03-APP-FLOW §2.1 "forbidden" row).
   *  `status` = derived list status (§7.4a). @throws common.not_found */
  getPriceListStatus(ctx: RequestContext, input: { priceListId: Uuidv7 }): Promise<{ priceListId: Uuidv7; isActive: boolean; status: 'draft' | 'published' | 'superseded' | 'discarded' }>;
}
```

Method behaviour (all run inside `ctx.tx`, never open a transaction, tenant from `ctx.tenantId` only — 02-CV §8.1):

| Method | Algorithm | Throws |
|---|---|---|
| `getTest` | load test + analytes (cache); for each analyte pick the analyte version with `effective_from ≤ asOf < effective_to` (status published/superseded/retired); analytes with no version effective at `asOf` are omitted; `ordinalSetCode` = that version's `value_set_code`, and `ordinalSetValues` = the **active** values of that set (tenant `cs_value_set_values` when a tenant set has the code, else `g_value_set_values`), ordered by `sort_order` asc, present iff `ordinalSetCode` is set (08 A13 D-9); `tatTargetSeconds` from `tat_targets` effective at `asOf`; `revision` = `orderables.revision` of the test's orderable row (stamping rule §3); `departmentName` = the test's department `name` (R25); `usesExistingMaterial` = `tests.uses_existing_material` (CR-C11-009); `specimenTypeCodes` = the codes of all `test_specimen_types` rows, preferred first, then by specimen type code; `containerCode` and `specimenReportLabel` from the preferred row (its container code; its specimen type's `report_label`); a test without specimen requirements has `specimenTypeCodes = []` and no `containerCode`/`specimenReportLabel` | `common.not_found`; `catalog.test_inactive` iff `requireActive` and `is_active = false` |
| `getPanel` | load panel + members (ordered); `revision` = `orderables.revision` of the panel's orderable row | same with panel |
| `resolveOrderables` | §7.7 | `common.not_found` (unknown id), `catalog.test_inactive`, `catalog.panel_cycle` (defensive; also prevented at write) |
| `priceFor` | §7.4–§7.6 (tax rates effective at `at`, C3 sole owner — 08 R18) | `catalog.no_price`, `catalog.tax_config_missing` (CR-C3-003; propagates unchanged through C4), `common.not_found` (orderable/list/party/referrer/centre not visible) |
| `referenceRangeFor` | §7.3 (with `ageDays` absent only age-unrestricted bands match — 08 A17.1) | `catalog.no_reference_range` (also: age unknown and no age-unrestricted band), `common.not_found` (analyte) |
| `criticalLimitsFor` | §7.3 over critical sets; returns `undefined` when no set effective at `at`, and when `ageDays` is absent and no age-unrestricted band matches (08 A17.1) | `common.not_found` (analyte) |
| `mapInstrumentCode` | §7.8 | `catalog.instrument_code_unmapped` — also for an inbound query without `instrumentCode` or an outbound query without `analyteId`/`testId` (mapped to the code the 03-IC §4.2 JSDoc lists — review C3 m#23) [CONV] |
| `getReferrer` | load doctor (any `is_active`); `canonicalReferrerId` = `merged_into_id` (always one hop — merges flatten chains, 05-SCHEMA §5.5; the impl still follows ≤10 hops defensively) else self; `contact` only when `purpose = 'notification'` **and** `ctx.actor.type ∈ {user, system}` [CONV]; calls with `notification` are counted in `lims_catalog_contact_reads_total{purpose}` | `common.not_found`; `auth.forbidden` (notification purpose from a device/portal/patient/partner actor) |
| `getCreditParty` | same pattern; `pan` + `billingAddressText` (= `billing_address`) only when `purpose = 'billing'` **and** actor ∈ {user, system}; `contact` only for `notification` (same actor rule); `billing` never returns `contact` | `common.not_found`; `auth.forbidden` (`notification`/`billing` from a non user/system actor) |
| `getTaxRate` (08 A2.2, A4.1) | §7.6a — reads C3 tax-rule data only (`g_tax_types` for `VAT`, `cs_tax_types` versions for every other code); no other source of rates exists (08 R18) | `catalog.tax_config_missing` (unknown/inactive code, no version effective on `on`, `rate_bp` NULL, and also `on` not `YYYY-MM-DD` or `taxCode` not `^[A-Z0-9_]{1,16}$` — no rate can exist for such input; mapped to the only code the 03-IC §4.2 JSDoc lists, review C3 m#23) [CONV] |
| `getPriceListStatus` (08 A24.1) | §7.4a — reads `catalog.price_lists` (`is_active`) and the list's `price_list_versions` statuses under the caller's tenant (cached price-list index, §6.3); no permission check beyond the caller's tenant context, like `getTest` (the list carries no personal or financial data beyond its existence) [CONV] | `common.not_found` (unknown id or other tenant's list) |
| `resolveCommentCodes` | upper-case codes; for each, pick active `(code, department_id = input)` else active `(code, department_id IS NULL)`; with `asOf`, the code's text version effective at `asOf` from `catalog.comment_code_texts` (05-SCHEMA) — `version`/`text` of that version; ≤50 codes per call (`common.validation_failed` above) | `common.validation_failed` |

Determinism: same `(input, catalogRevision)` ⇒ same output (03-IC §4.2 invariant): matchers are pure, inputs sorted, ties broken by `sort_order` then `id`.

`common.not_found` (`getTest`, `getPanel`, `resolveOrderables`, `priceFor`, `referenceRangeFor`, `criticalLimitsFor`) is kept: 03-IC §4.2 contract cases (1), (2) and (23) already require it. The `@throws` rows above are C3's own JSDoc for the seven existing methods (final sweep f-11); the 03-IC §4.2 JSDoc is aligned to them by the 03-IC owner (review C3 m#23, program sweep item 11).

### 6.2 Ports consumed

| Port | Method | Where |
|---|---|---|
| `IdentityPort` (C2) | `assertRole(ctx, {permission})` | every handler, before any read beyond the authz lookup |
| `IdentityPort` | `getActor(ctx)` | mappers (decide whether contact fields are included: actor holds `catalog.referrer.manage`) |
| `IdentityPort` | `getTenantSettings(ctx, {keys: ['timezone']})` | `getTaxRate` (local date → instant, §7.6a) and calendar age from `birthOn` (§7.3) — v1 accepts only `Asia/Kathmandu` (08 A13 P-15) [CONV] |
| `ctx.core` (C0) | `centre(ctx, { centreId })` (C0 TRD §6.8; throws `common.not_found`) | validate centre assignments and `quotePrices` `context.centre_id` |

C3 does not call any other chunk's port. The staff web BFF (SCR-13 assignments, SCR-15 simulator) reads the centre directory over HTTP from C2 `listCentres` with `identity.centre.read` (08 A13 D-16); C3 adds no centre endpoint.

### 6.3 Cache

- Per API/worker process LRU (`LIMS_CATALOG_CACHE_MAX_ENTRIES`, default 50,000 [CONV]; TTL `LIMS_CATALOG_CACHE_TTL_SECONDS` 600 [CONV]).
- Key = `(tenant_id, catalog_revision, kind, id)`. Every port call reads `catalog_revision` once per request (`SELECT catalog_revision FROM catalog.catalog_state WHERE tenant_id = $1`, memoised on the `RequestContext` via a WeakMap) so a committed change is visible to the next request in every process without cross-process messaging.
- Cached values: test bundle (test + analytes + all versions + tat rows), range-set list per analyte (all published/superseded sets with bands), critical-set list per analyte, panel graph per tenant, price-list index per tenant (assignments → list id; per list: versions with effective windows), price items per (list version) loaded lazily, surcharge rules per tenant, tax rules + tax-type rate versions per tenant, code-map index per instrument.
- Time filtering (`asOf`, `at`) happens in memory on cached version lists, so one cache entry serves all instants.

## 7. Algorithms

### 7.1 Formula grammar (owner of the text: C3; implementation: `@lims/shared-ts/formula` by C0-0A — 08 R12a; CR-C3-002, CR-C5-002 merged)

One grammar for the program: C3 validates and C5 evaluates with the same parser (C0-0A, `@lims/shared-ts/formula`, signatures 08 §4.13). C5's ternary and `||`/`&&` are not part of it.

```ebnf
formula     = expr ;
expr        = orExpr ;
orExpr      = andExpr { "or" andExpr } ;
andExpr     = cmpExpr { "and" cmpExpr } ;
cmpExpr     = addExpr [ ( "<" | "<=" | ">" | ">=" | "==" | "!=" ) addExpr ] ;
addExpr     = mulExpr { ( "+" | "-" ) mulExpr } ;
mulExpr     = unary { ( "*" | "/" ) unary } ;
unary       = "-" unary | power ;
power       = primary [ "^" unary ] ;                       (* right-associative *)
primary     = number | analyteRef | contextVar | call | "(" expr ")" ;
number      = digit { digit } [ "." digit { digit } ] ;     (* no exponent notation *)
analyteRef  = upper { upper | digit | "_" } ;              (* = analyte code, ≤32 chars *)
contextVar  = "@age_days" | "@age_years" | "@is_female" | "@is_male" ;
call        = fname "(" [ expr { "," expr } ] ")" | "invalid" "(" string ")" ;
fname       = "if" | "min" | "max" | "abs" | "round" | "sqrt" | "ln" | "log10" | "exp" | "pow" ;
string      = '"' lower { lower | digit | "_" } '"' ;      (* reason code ≤ 32 chars *)
```

Semantics (binding for the evaluator; C3 tests them through the shared lib's golden vectors):
- Numeric semantics (binding, 08 R12a): `+ − × ÷` and comparisons in exact decimal arithmetic with ≥ 28 significant digits (`@lims/shared-ts/decimal`, implementation pinned by C0-0A within the licence allowlist); `sqrt`, `ln`, `log10`, `exp` and `pow` with a non-integer exponent are computed in IEEE-754 double, rounded to 15 significant digits and mark the result `inexact: true` (C5 stores it in provenance). Comparisons yield booleans; booleans are only legal as the first argument of `if` and operands of `and`/`or`.
- `if(c, a, b)` evaluates lazily. `invalid("reason")` makes the whole formula **not computable** with that reason (C5 AC-09.2).
- Missing input, division by zero, `sqrt`/`ln`/`log10` of a non-positive number, `pow` with non-integer exponent of a negative base → not computable with reasons `missing_input:<CODE>`, `division_by_zero`, `domain_error`. Missing is never 0 (06-GLOSSARY).
- `round(x, n)` = half-up to n decimals (0–6). The final value is rounded by C5 to the analyte's `decimals`, half-up [CONV, same rule as money 02-CV §4.9].
- `@age_years` = completed years, `@age_days` = days; `@is_female`/`@is_male` = 1 or 0 (0 for other/unknown).
- Limits [CONV]: expression ≤ 500 chars; AST depth ≤ 32; ≤ 20 distinct analyte refs; chain depth (formula analyte → formula input analyte → …) ≤ 5.
- Validation (C3): parse; every `analyteRef` must be an active analyte code of the tenant; the formula's own analyte must be `numeric`; inputs whose version result type is not `numeric` are rejected unless used only inside comparisons; graph checks §7.2.
- Stored: `formula_expression` exactly as entered (whitespace normalised to single spaces), `formula_inputs` = refs in order of first appearance, `formula_input_units` = `{code: unit_code}` of each input's effective analyte version at publish time.

Golden vectors (SYNTHETIC, shipped in `packages/fakes/contract-tests/formula.vectors.json` via CR-C3-002):

| # | Expression | Inputs | Expected |
|---|---|---|---|
| G1 | `MCV / RBC` (Mentzer index) | MCV 70.0, RBC 5.60 | `12.5` |
| G2 | `NEUT_ABS / LYMPH_ABS` (NLR) | 4.20, 2.10 | `2` (decimals 2 → `2.00`) |
| G3 | `PLT / LYMPH_ABS` (PLR) | 250, 2.00 | `125` |
| G4 | `WBC * NEUT_PCT / 100` (absolute count) | WBC 8.50, NEUT_PCT 60.0 | `5.1` |
| G5 | `if(TG >= 400, invalid("tg_over_400"), TC - HDL - TG / 5)` (Friedewald LDL; validity limit TG < 400 mg/dL is VERIFIED per 06-GLOSSARY / 01 log #9) | TC 200, HDL 50, TG 150 | `120` |
| G6 | same | TG 450 | not computable `tg_over_400` |
| G7 | `NEUT_ABS / LYMPH_ABS` | LYMPH_ABS 0 | not computable `division_by_zero` |
| G8 | `TP - ALB` | ALB missing | not computable `missing_input:ALB` |
| G9 | `round(2 ^ 0.5, 3)` | — | `1.414` |
| G10 | `if(@is_female == 1, A * 0.9, A)` | A 10, female | `9.0` |

The formulas above are illustrative synthetic seed content. Which formulas and coefficients a lab uses (e.g. any eGFR equation) is lab-director data delivered with the test list (BLOCKED B3), not a fact asserted here.

### 7.2 Formula dependency graph and cycle detection (`domain/formulaGraph.ts`)

1. Nodes = analytes of the tenant. Edges `A → I` for each input I of A's **candidate** version: the draft being validated/published for A, otherwise A's latest published version (effective now or scheduled).
2. On validate/publish of A's draft: build the graph from `catalog.formula_dependencies` (published + scheduled rows) with A's edges replaced by the draft's edges.
3. Iterative DFS from A with colours (white/grey/black); a grey hit returns the cycle path `A -> … -> A` (codes) → `catalog.formula_invalid`, `errors[0] = {path:'/formula_expression', code:'common.field_invalid', message:'cycle: B -> A -> B'}`.
4. Chain depth = longest path from A through formula analytes; > 5 → `catalog.formula_invalid` ("formula chain too deep").
5. `dependency_order` (validate response) = reverse post-order restricted to A's reachable set (inputs before dependants) — C5 may use the same order.
6. On publish, `formula_dependencies` rows for the version are inserted in the same transaction **before** the `UPDATE … SET status = 'published'` (the `tg_parent_is_draft` trigger rejects child writes once the parent is no longer `draft`, 05-SCHEMA §10.2); a tenant-wide re-check of every formula is run in the `catalog_master` import commit before writing.
7. Panel cycle detection uses the same DFS over `panel_members` (§7.7).

### 7.3 Reference-range / critical-limit band selection (`domain/rangeMatch.ts`)

Input: `RangeQuery`, the analyte's published/superseded/retired sets (cached).
1. Set selection: the set with `effective_from ≤ at < coalesce(effective_to, +∞)`. None → `catalog.no_reference_range` (critical: return `undefined`).
2. Analyte-version check: the analyte version effective at `at` must have `unit_code` and `method_id` equal to the set's snapshot (null = null). Mismatch → `catalog.no_reference_range` (critical: `undefined`) and metric `lims_catalog_range_unit_mismatch_total`.
3. Age: if `ageDays` is absent, the patient's age is **unknown** (08 A17.1, CR-C5-012): no age is computed, `birthOn` is not used [CONV: A17.1 keys age-unknown on `ageDays`; C5 always sends `ageDays` when it knows a date of birth], and step 4 admits only bands with **both** `age_low` and `age_high` absent. Otherwise, if `birthOn` given, compute completed units between `birthOn` and the `at` date in the tenant timezone from `IdentityPort.getTenantSettings(['timezone'])` (default `Asia/Kathmandu`; in v1 the only accepted value — 08 A13 P-15), the same source as §7.6a: days, weeks = floor(days/7), months = completed calendar months, years = completed calendar years. Else from `ageDays`: weeks = floor(ageDays/7), months = floor(ageDays / 30.4375), years = floor(ageDays / 365.25) [CONV approximation; may differ from calendar age by ≤ 1 day near a birthday — documented to C5, which passes `birthOn` whenever the patient has a date of birth].
4. A band matches when: `sex` = query sex or `any` (query `other`/`unknown` matches only `any`); `age_low` absent or age in `age_low.unit` ≥ `age_low.value` (inclusive); `age_high` absent or age in `age_high.unit` < `age_high.value` (exclusive); with age unknown (step 3), `age_low` and `age_high` both absent (any band with an age bound is skipped, even an open-ended one such as "18 y – ∞"); no matching band → `catalog.no_reference_range` (critical: `undefined`), and C5 then marks the result `range_unavailable_age_unknown` (08 A17.1; C5's rule); `specimen_type_id` absent or equal to the id of `specimenTypeCode` (query without specimen type matches only bands without one).
5. Specificity score = (specimen match ? 2 : 0) + (sex exact ? 1 : 0). Highest score wins; ties are impossible after publish validation (step 6), else `sort_order`, `id`.
6. Publish validation: for every pair of bands with equal (sex, specimen_type) whose age intervals overlap (compared after converting bounds to days with the same approximation: day = 1, week = 7, month = 30.4375, year = 365.25 days), reject with `common.validation_failed` listing both band indexes. Numeric bands need `low` or `high`, and `low ≤ high`; values must have ≤ the analyte version's `decimals` + 2 places [CONV]. Ordinal bands' `normal_codes` must exist in the analyte's value set; critical `abnormal_codes` likewise.
7. Output: `referenceRangeId` = band id, `version` = set `version_no`, `low`/`high` as stored text (scale preserved — numeric stored unconstrained), `text` = `display_text` or, for numeric bands without one, generated `"<low> - <high>"`, `"< <high>"` or `"> <low>"` [CONV], `unitCode` = set `unit_code`, `kind`, `normalCodes`.

### 7.4 Price precedence and fall-through (`domain/priceMatch.ts`)

Input: `PriceQuery`. Candidate lists in precedence order (03-IC §4.2 [CONV default]):
1. `explicit` — `context.priceListId` (must be active; else `common.not_found`).
2. `credit_party` — list assigned to `context.creditPartyId`.
3. `referrer` — list assigned to the **canonical** doctor of `context.referrerId`.
4. `centre` — list assigned to `context.centreId`.
5. `tenant_default` — the active default list.

For each candidate in order: pick the list's version effective at `at` (published/superseded with `effective_from ≤ at < effective_to`). A list with **no** version effective at `at` (e.g. a new list that has only its draft v1) is treated as absent and skipped, regardless of `falls_through`. If the version has an item for `orderableId` → winner. If not: if the list has `falls_through = false` → `catalog.no_price`; else continue. Exhausted → `catalog.no_price`. Inactive lists are skipped (treated as absent). Output `PriceQuote { orderableId, priceListId, priceListVersion: version_no, source, unitPrice }` + surcharge (§7.5) + tax (§7.6).

### 7.4a Price-list status (`getPriceListStatus`; 08 Addendum A24.1)

A price list has no status column of its own (05-SCHEMA `catalog.price_lists` has `is_active` only); its versions carry C3's status set. The port derives one list-level value [CONV]:
1. Load `catalog.price_lists` by `(ctx.tenantId, priceListId)`; not found → `common.not_found` (another tenant's id is not found — RLS and the explicit tenant filter).
2. `isActive` = `price_lists.is_active`.
3. `status` = `published` if the list has at least one version with status `published` (the newest published version is never `superseded`, because V5 supersedes only on a successor's publish — 03-APP-FLOW §2.1); else `draft` if it has an open draft (at most one, partial unique index `price_list_versions__tenant_id_price_list_id__draft__p_uq`); else `discarded` (every version was discarded). `superseded` is part of the type because it is in C3's set; this derivation never returns it.
4. Effectiveness is not part of the answer: a list whose only published version starts in the future is `published`; `priceFor` uses effective windows, never status (03-APP-FLOW §2.1 note). A caller that needs a usable list checks `isActive = true` and `status = 'published'`.
Deterministic for the same `(input, catalogRevision)`; reads the cached price-list index (§6.3).

### 7.5 Urgent surcharge (`domain/surcharge.ts`)

Only when `priority = urgent`. Rules effective at `at`; candidates matching the orderable: `orderable` scope (orderable_id = id), `department` scope (department = the test's department; for a panel, the panel's `department_id` if set), `all`. Rank: specificity (orderable 3 > department 2 > all 1), then list-scoped (`price_list_id` = winning list) over unscoped. Top rule: `flat` → `amount_paisa`; `percent` → `round_half_up(unit_price_paisa × percent_bp / 10000)` via `@lims/shared-ts/money`. No rule → field absent. Overlapping rules with the same (scope, key, price_list_id) and overlapping effective windows are rejected at create (`400 common.validation_failed` path `/effective_from`); the overlap check runs after `createSurchargeRule` has taken the `catalog_state` row lock (§3), so two concurrent creates cannot both pass it.

### 7.6 Tax (`domain/tax.ts`)

Rules effective at `at`: orderable rule > department rule > tenant default. Department used for a test = the test's department; for a panel/package = `orderables.department_id` if set, else no department rule applies (orderable rule, then tenant default).
Overlap rule (deterministic tax output): at create (#90), after taking the `catalog_state` lock, a rule whose window overlaps an existing rule of the same (`scope`, `department_id`/`orderable_id`) is rejected with `400 common.validation_failed` path `/effective_from` — **except** a new `tenant_default` rule whose `effective_from` > the open default's `effective_from`: the service first sets the predecessor's `effective_to = new.effective_from`, then inserts the new rule, in the same transaction. DB backstop: partial unique index `tax_rules__tenant_id_scope_key__open__p_uq` (one open rule per scope + key, 05-SCHEMA). Rows are effective-dated and never edited after creation except `effective_to`/`is_active` (DB trigger, 05-SCHEMA §10).
C3 is the only owner of tax rates (08 R18): `cs_tax_types` rows are effective-dated; C4 has no tax table. No tenant default → `catalog.tax_config_missing`. Output `vat` = rule's `vat_treatment`; `vatRateBp` = 1300 when taxable (global `g_tax_types` row `VAT`, 04 L14 VERIFIED); `otherTaxCode` + `otherTaxRateBp` from the `cs_tax_types` version of that code effective at `at` (its rate must be non-null — enforced when the rule is created, and a rate version may not clear the rate while a rule references the code); `hsCode` when set. C3 computes no tax amounts (C4 does — 02-CV §4.9).

### 7.6a `getTaxRate` (`domain/tax.ts`; 08 Addendum A2.2, signature per A4.1)

Single-code rate lookup for consumers that keep their own tax **treatment** but not rates (first consumer: C12 purchase side — C12 stores tax code per item/supplier and `vat_in_cost`, never a rate value; 08 A2.2).
1. Validate `taxCode` (`^[A-Z0-9_]{1,16}$` — C3's tax-code format, 08 Addendum A5.6) and `on` (ISO date `YYYY-MM-DD`) → else `catalog.tax_config_missing` [CONV: no rate can exist for malformed input; the 03-IC §4.2 JSDoc lists only this code — review C3 m#23].
2. Instant `t` = 00:00 of `on` in the tenant timezone (`IdentityPort.getTenantSettings(['timezone'])`, default `Asia/Kathmandu`) [CONV].
3. `taxCode = 'VAT'` → the active global `g_tax_types` row `VAT` → `{taxCode: 'VAT', ratePercentBasisPoints: rate_bp, kind: 'vat', effectiveFrom: null}`. `g_tax_types` has no effective-dating column, so the rate has no versioned history and `effectiveFrom` is `null`; it is never derived from `created_at` (08 A4.1).
4. Any other code → the `cs_tax_types` row of the tenant with that `code`, `is_active`, and `effective_from ≤ t < coalesce(effective_to, +∞)`; `rate_bp` must be non-null → `{taxCode, ratePercentBasisPoints: rate_bp, kind: 'other', effectiveFrom: effective_from}` (ISO-8601 UTC [CONV]).
5. No row, inactive, or `rate_bp IS NULL` → `catalog.tax_config_missing`.
6. There is no `'exempt'` kind (08 A4.1): exemption is a treatment (`tax_rules.vat_treatment = 'exempt'`, per orderable/department/tenant default; C12 purchase lines with no tax code), not a rate. C12 never calls `getTaxRate` for an exempt line.
Reads the same cached tax-type rate versions as `priceFor` (§6.3); deterministic for the same `(input, catalogRevision)`.

### 7.7 Panels: expansion, cycles, `resolveOrderables`

- Write-time: `replacePanelMembers` runs DFS over the tenant's panel graph with the new members; a path back to the panel → `catalog.panel_cycle`; depth > `LIMS_CATALOG_PANEL_MAX_DEPTH` (4) → `common.validation_failed`. Members must be active (`catalog.test_inactive`).
- `resolveOrderables(ids, asOf)`: for each id in input order: test → `[test]`; panel → depth-first expansion in `sort_order`, de-duplicating tests by id (first occurrence wins). Any inactive test or panel reached → `catalog.test_inactive`. `tests` = union in first-seen order, each a `TestDefinition` as of `asOf`. `specimenRequirements` = group tests by their **preferred** specimen requirement `(specimen_type_code, container_code)`; groups sorted by specimen type code; `testIds` in first-seen order. Tests without any specimen requirement (allowed by #24, e.g. `uses_existing_material`) are omitted from the groups (they still appear in `tests`, with `specimenTypeCodes = []`). `catalogRevision` = request's revision.
- Packages with `sex_restriction`: returned in `PanelDefinition.sexRestriction`; enforcement against the patient's sex is C4's (registration) — C3 does not know the patient.

### 7.8 `mapInstrumentCode`

- `inbound`: active map with (`instrument_id`, `instrument_code` exact, case-sensitive), `direction ∈ {inbound, both}`.
- `outbound`: active map with (`instrument_id`, `analyte_id`) or, if only `testId` is given, the lowest-`instrument_code` map among the test's analytes, `direction ∈ {outbound, both}`.
- Not found → `catalog.instrument_code_unmapped`. Output includes `unitConversion` when all three unit fields are set and `flagMap` when set.

### 7.9 Orderable search ranking

`q` normalised (trim, upper-case for code comparison, `%`/`_`/`\` escaped). Candidates `WHERE tenant_id = $1 AND is_active … AND (upper(code) LIKE q||'%' OR name ILIKE '%'||q||'%')`. Rank: exact code = 0, code prefix = 1, name prefix = 2, name contains = 3; then `length(code)`, `code`. No trigram index: catalog size per tenant is small (ASSUMPTION ≤ 5,000 orderables, §12), a `(tenant_id, is_active)` B-tree scan meets the target and avoids depending on `pg_trgm`/`btree_gin` for a tenant-leading index (02-CV §5.3 rule).

## 8. Excel import/export

### 8.1 Flow (details and state machine in 03-APP-FLOW §4)

`createImport` (API, synchronous): BFF streams multipart → core multipart parser + per-operation `x-upload` allowlist (08 §4.13) → core size cap 15 MB → C3 checks extension `.xlsx` and magic bytes `50 4B 03 04` (ZIP local header) → sha256 → dedupe lookup on (tenant, kind, `target_price_list_id`, `file_sha256`) only — the same bytes carry the same `_meta`, so `base_version_no` (unknown before parsing) is not part of the key — with status ∉ {invalid, quarantined, commit_failed, discarded, expired, failed} and not expired → insert `catalog.files` (purpose `import_upload`, `expires_at = created_at + LIMS_CATALOG_IMPORT_TTL_HOURS + LIMS_CATALOG_FILE_RETENTION_DAYS` = + 168 h + 30 d) + `catalog.imports(status 'uploaded')` → enqueue `catalog.import_validate` (job_key = import id) → `201`. No parsing in the API process.

### 8.2 Templates

All templates: sheet `Instructions` (static text: column meanings, "prices in NPR with at most 2 decimals", "do not edit _meta", tax disclaimer), data sheets, hidden sheet `_meta` with key/value rows: `template_kind`, `template_version` (= 1), `tenant_catalog_revision`, `exported_at` (IsoUtc), and kind-specific keys. On import, `_meta` keys read by validation are `template_kind`, `template_version` and the kind-specific keys (price_list: `price_list_id`, `base_version_no`); a missing one → `file.meta_missing`, a wrong kind or list → `file.meta_mismatch`. `price_list_code`, `tenant_catalog_revision` and `exported_at` are informational only: the validator never reads them, so a blank or missing value is accepted for every kind, including a fresh `price_list` template filled outside C3 (C18 hand-off, confirmed in the final sweep 2026-11-06) [CONV: the list of keys read]. Header row = row 1, exact column keys (lower snake) as listed; columns may be reordered; unknown columns → warning `file.unknown_column` (ignored).
Formula-injection guard (08 R12e, 08 A13 P-9): every **text** cell C3 writes (templates, exports, annotated import reports — including untrusted cells re-emitted from an upload) passes `@lims/shared-ts/spreadsheet.neutraliseFormula`; numbers are written as number cells and no cell is written as a formula. The importer applies `restoreNeutralised` to every text cell **before** validation, so an export → import round-trip still reports "0 changes" (`restoreNeutralised(neutraliseFormula(s)) === s`). C3 has no local copy of either function.

**`price_list`** — `_meta`: `price_list_id`, `price_list_code`, `base_version_no` (0 for an empty template). Sheet `Prices`:

| Column | Req | Type / rule |
|---|---|---|
| `orderable_code` | yes | text ≤32, normalised upper-case; must be an orderable of the tenant |
| `orderable_kind` | no | `test`/`panel`; if present must match (`row.kind_mismatch` error) |
| `orderable_name` | no | ignored on import (reference only) |
| `department` | no | ignored on import |
| `unit_price_npr` | yes | number ≥ 0, ≤ 9,999,999.99, ≤ 2 decimals; text cells holding such a number are accepted; commas, currency symbols, negative → `row.price_invalid` |

Import semantics: the sheet is the **complete** content of the new version (D-C3-03). Summary compares to the latest published version: added / changed / removed / unchanged.

**`catalog_master`** — sheets (each upsert by code; blank optional cells = "no value"): `Departments` (code, name, report_order, report_heading), `SpecimenTypes` (code, name, report_label), `Containers` (code, name, additive, cap_colour_display, default_specimen_type_code), `Methods` (code, name), `Units` (code, display), `ValueSets` (value_set_code, is_ordered, value_code, value_display, sort_order), `Tests` (code, name, department_code, workflow_type, report_order, is_orderable, specimen_type_codes `;`-separated with preferred first, container_code), `Analytes` (test_code, analyte_code, name, print_name, report_subheading, sort_order, is_reportable, result_type, unit_code, decimals, method_code, value_set_code, formula), `ReferenceRanges` (analyte_code, sex, age_low, age_low_unit, age_high, age_high_unit, specimen_type_code, kind, low, high, normal_codes `;`, display_text), `CriticalLimits` (analyte_code, sex, age_low, age_low_unit, age_high, age_high_unit, specimen_type_code, low, high, abnormal_codes), `Panels` (code, name, panel_kind, sex_restriction, department_code), `PanelMembers` (panel_code, member_code, sort_order), `CommentCodes` (code, department_code, text), `TatTargets` (test_code, priority, segment, target_minutes).
Commit semantics: non-clinical attributes update in place; for each analyte whose clinical attributes differ from its current published version → new analyte version; for each analyte whose `ReferenceRanges` rows differ (as a set) from the current published set → new range set (same for critical limits); everything published with the commit's `effective_from` and `change_reason`. Rows absent from the workbook are **not** deactivated [CONV] (deactivation is explicit in the UI).

**`referrers`** — sheet `Doctors`: `doctor_code` (blank = auto), `display_name`*, `qualification`, `registration_council`, `registration_no`, `phone_e164`, `email`, `is_verified` (Y/N, default N). Upsert by `doctor_code`.

**`credit_parties`** (CR-C18-008, accepted in 08) — sheet `CreditParties`: `party_code`*, `name`*, `kind`* (`hospital|company|clinic|partner_lab|insurer|other`), `allows_credit` (Y/N, default Y), `pan` (≤20), `contact_phone_e164`, `contact_email`, `billing_address` (≤500). Upsert by `party_code`; permission `catalog.price_list.manage`. Rows absent from the workbook are not deactivated [CONV]. Contact and PAN cells are never logged.

### 8.3 Validation job `catalog.import_validate`

1. Status `uploaded → scanning`: call `ctx.files.scan(bytes)` (C0-0D/C1; **mandatory in staging and production** — 08 R12b, CR-C3-005 merged into CR-C2-011); `infected` → `quarantined` (+ `common.upload_quarantined` as `last_error_code`), metric + alert; `unavailable` → the import stays `scanning` and the task fails for retry; after the final attempt it is `quarantined` with `last_error_code = common.upload_quarantined` (fail closed). Only in local development without a scanner does `unavailable` continue with log `scan_unavailable`.
2. `scanning → validating`: ZIP inspection (§8.4); failure → `invalid` with `file.*` issue.
3. Parse with `XlsxReader` inside a 60 s [CONV] timeout (`AbortSignal`-guarded promise race; on timeout the task throws `file.parse_timeout` → `invalid`); sheet row cap 20,000 [CONV] (`file.too_many_rows`).
4. Apply `restoreNeutralised` to text cells (§8.2); write `imports.base_version_no` from `_meta.base_version_no` (price_list kind); validate rows against current catalog (one read transaction, tenant context) → issues (§8.6), capped at 5,000 issues [CONV] (`file.too_many_issues` warning, remaining rows still counted).
5. Build the report xlsx (`XlsxWriter`: original rows + `issues` column + `Issues` sheet; every text cell through `neutraliseFormula`, §8.2) → `catalog.files(purpose 'import_report')`.
6. Status → `validated` (0 errors) or `invalid`; `summary` stored; import `expires_at = now + 168 h`. In the same transaction the upload file's and the report file's `expires_at` are set to import `expires_at` + 30 d, and every `import_issues` row is written with `expires_at` = that same file `expires_at` (05-SCHEMA §7).
Idempotent: the task first re-reads the import; if status is not `uploaded`/`scanning`/`validating` it returns success (duplicate job).

### 8.4 ZIP inspection (`ZipInspector.ts`, in-house, no library)

Read the End-of-Central-Directory record and iterate central-directory entries (PKWARE ZIP format) without decompressing. Reject (`file.not_xlsx`, `file.zip_unsafe`, `file.macro_present`, `file.external_links`) when: EOCD not found; ZIP64 markers present; any entry encrypted (general-purpose bit 0); entry count > 200 [CONV]; Σ uncompressed sizes > 50 MB [CONV]; any entry's compressed→uncompressed ratio > 100 [CONV]; entry names containing `..`, absolute paths or backslashes; missing `[Content_Types].xml` or `xl/workbook.xml`; entry `xl/vbaProject.bin` present; any `xl/externalLinks/` entry present. Only after passing is the buffer handed to `read-excel-file`.

### 8.5 Commit job `catalog.import_commit`

API `commitImport` checks state `validated` and not expired, stale-base rule (price_list: latest published version_no ≠ `base_version_no` → `catalog.import_stale_base` unless `accept_stale_base`), permissions, then sets `committing` and enqueues the job (job_key = import id). For `catalog_master` the API also asserts `catalog.reference_range.publish` when the validation summary shows analyte-version, range-set or critical-set changes (08 A13 D-18). The job, in **one** transaction: re-validates (catalog may have changed since validation; any new error → `commit_failed` with issues appended); **open drafts**: if a target already has an open draft (the price list's draft version; for `catalog_master` an open analyte-version / range-set / critical-set draft of an analyte the commit versions), the commit fails with `commit_failed` and issue `file.draft_exists` (one per target), unless the commit request sent `replace_draft: true`, in which case those drafts are discarded first (status `discarded`) in the same transaction; applies changes through the normal services; sets `committed`, `result_price_list_version_id`, `committed_at/by`.
Revisions and events (08 A13 D-21): a `price_list` commit is one price-list publish (one `price_list` / `versioned` bump and event, as by the UI); a `catalog_master`, `referrers` or `credit_parties` commit bumps `catalog_revision` **once** and emits **one** `catalog.changed.v1` with `entity_type: 'catalog_import'`, `entity_id = import_id` (§9.1), and every orderable row touched by the commit gets `orderables.revision` = that revision (§3).
Actor (repudiation): the job runs as the catalog system actor, but rows it writes record the committing user — `published_by`, `created_by`, `updated_by` = `imports.committed_by` (actor-on-behalf) — and analyte versions, range sets and critical sets created by the commit carry `source_import_id = import_id` (plain uuid, no FK — 05-SCHEMA), as price-list versions already do. Retry after crash: the job re-reads the import; `committed` → no-op; `committing` → runs again (the whole apply is one transaction, so a crash leaves nothing half-applied).

### 8.6 Import issue codes (`x-coded-set: catalog_import_issue_codes` [CONV])

`file.not_xlsx`, `file.zip_unsafe`, `file.macro_present`, `file.external_links`, `file.parse_timeout`, `file.sheet_missing`, `file.header_mismatch`, `file.unknown_column` (w), `file.meta_missing`, `file.meta_mismatch` (wrong kind / other price list), `file.stale_base` (w), `file.too_many_rows`, `file.too_many_issues` (w), `row.required_missing`, `row.code_invalid`, `row.duplicate_code`, `row.orderable_unknown`, `row.orderable_inactive` (w), `row.kind_mismatch`, `row.price_invalid`, `row.price_decimals`, `row.price_change_large` (w, change > 50 % [CONV]), `row.reference_unknown` (department/method/unit/specimen code not found), `row.value_invalid`, `row.formula_invalid`, `row.range_overlap`, `row.panel_cycle`, `row.phone_invalid` (pattern `^\+[1-9][0-9]{7,14}$`, 08 A13 P-11), `row.email_invalid`, `file.draft_exists` (commit only: a target has an open draft and `replace_draft` was not sent, §8.5). (w) = warning; all others errors.

### 8.7 Exports `catalog.export_build`

`createExport` inserts `exports(status 'queued')`, enqueues job; job builds the workbook from one consistent snapshot (`REPEATABLE READ` read transaction) in the template format so the export round-trips into an import; cell types: codes and text written as string cells, each passed through `neutraliseFormula` (§8.2, 08 A13 P-9), prices as number cells with 2 decimals; no cell is written as a formula. File stored in `catalog.files(purpose 'export')`, export `ready`, `expires_at = now + 30 days` [CONV] (same value on the file row). Referrer exports include phone/email → privileged permission and access-log entry. `catalog_master` exports hold only P0 master data and are not privileged (08 A13 D-22); `price_list` exports require the privileged `catalog.price_list.manage`.

## 9. Events

### 9.1 Produced: `catalog.changed.v1` (03-IC §3.19)

Produced by `revision.service.bumpRevision` in the writing transaction via `events.publish(tx, 'catalog.changed.v1', {aggregate:{type:'catalog', id: catalog_root_id, seq: catalog_revision}, idempotencyKey: `${tenantId}:catalog:${catalog_revision}`, payload})`.

| Trigger (exact) | entity_type | entity_id | change_kind | effective_from |
|---|---|---|---|---|
| create of department / specimen type / container / test / analyte / panel / comment code / doctor / credit party / price list / surcharge rule / tat target row / instrument code map | as named (`specimen_type`, `container`, `comment_code`, `doctor`, `credit_party`, `price_list`, `surcharge_rule`, `tat_target`, `instrument_code_map`) | created row id | `created` | commit time |
| update of mutable attributes (incl. panel members, specimen requirements, price-list assignments, doctor verify) | same | root id (panel id, test id, price list id, doctor id) | `updated` | commit time |
| `is_active` → false, doctor merge, surcharge/tax rule end | same | row id | `deactivated` | commit time / rule `effective_to` |
| publish of analyte version | `analyte` | analyte id | `versioned` | version `effective_from` |
| publish / retire of reference-range set | `reference_range` | set id | `versioned` | `effective_from` / retire time |
| publish / retire of critical-limit set | `critical_limit` | set id | `versioned` | same |
| publish of price-list version | `price_list` | price list id | `versioned` | `effective_from` |
| method, unit, value set change; tax type (incl. a new rate version) / tax rule change | `method`, `unit`, `value_set`, `tax_rule` (CR-C3-003; enum marked `x-extensible: true`, stays `.v1` — 08 R13; consumers treat an unknown `entity_type` as "invalidate all") | changed row id | `updated`/`created`/`deactivated` | commit time (rate version: its `effective_from`) |
| global release (job) | `global_reference` | tenant's `catalog_root_id` | `updated` | job run time |
| commit of a `catalog_master` / `referrers` / `credit_parties` import (08 A13 D-21) | `catalog_import` (added to the `x-extensible` enum; consumers apply the unknown-value rule = invalidate the whole tenant cache) | `import_id` | `updated` | commit time [CONV: the earliest instant any change of the commit is visible; versions it publishes with a later `effective_from` are time-filtered by the port] |

One event per revision increment; a transaction touching several roots increments once per root, **except** an import commit of kind `catalog_master` / `referrers` / `credit_parties`, which increments once and emits the single `catalog_import` event (D-21). A `price_list` import commit emits the one `price_list` / `versioned` event of its publish. Draft edits (draft versions, draft bands, draft price items) and writes to `imports`, `import_issues`, `exports`, `files`, `code_counters` do **not** bump the revision (nothing visible to consumers changed; §3) [CONV]. Every bump whose entity belongs to a test or panel stamps `orderables.revision` (§3). Payload never contains names, prices or contact data (PHI class P0).

### 9.2 Consumed

None (01-CM §5.1; 03-IC §3.25). `services/worker/src/jobs/catalog/index.ts` declares `subscriptions: {}`.

## 10. Background jobs (`services/worker/src/jobs/catalog`)

| Task | Trigger | Tenant scope | max_attempts | Idempotency | Notes |
|---|---|---|---|---|---|
| `catalog.import_validate` | enqueued by `createImport` (`job_key = import_id`) | tenant (payload `tenant_id`, `import_id`) | 3 [CONV] | status check at start | §8.3 |
| `catalog.import_commit` | enqueued by `commitImport` | tenant | 3 [CONV] | status check; single transaction | §8.5; final failure → `commit_failed` |
| `catalog.export_build` | enqueued by `createExport` | tenant | 3 [CONV] | status check | §8.7 |
| `catalog.expire_imports` | cron hourly `5 * * * *` [CONV] | `tenantScope: 'per_tenant'` (08 A13 P-6) | 1 | set-based UPDATE | `validated|invalid` past `expires_at` → `expired`; exports past `expires_at` → `expired` |
| `catalog.purge_files` | cron daily `20 21 * * *` UTC (= 03:05 Asia/Kathmandu) [CONV] | `tenantScope: 'per_tenant'` (P-6) | 1 | DELETE … RETURNING | delete `catalog.files` where `expires_at < now()` (uploads and reports: import `expires_at` + 30 d — before validation `created_at` + 168 h + 30 d; exports: created + 30 d) and NULL the referencing `imports.upload_file_id`/`report_file_id`/`exports.file_id` in the same transaction (05-SCHEMA §10.1); delete `import_issues` where `expires_at < now()` |
| `catalog.global_release_fanout` | cron every 10 min `*/10 * * * *` | `tenantScope: 'per_tenant'` (P-6) | 3 | compare `catalog.g_reference_release.release_no` with the tenant's `catalog_state.global_release_seen`; if greater → `bumpRevision(global_reference)` + set seen, in one tx | AC-19.5 |

`per_tenant` (08 A13 P-6, C0 TRD §7.2): at each tick the worker core enqueues one job per tenant with `core.tenants.status IN ('active','suspended')`, payload `{tenant_id}`, `job_key = '<identifier>:<tenant_id>:<tick, ISO minute>'`; the job runs under that tenant's claims for the catalog system actor, so the tenant RLS policies (05-SCHEMA §10.3) suffice and C3 needs no SECURITY DEFINER function and no tenant iteration of its own.

Cron entries live in `cron.ts` (REQ-ARCH-042). Task failures beyond `max_attempts` go to `core.dead_letters` (02-CV §7.5). Final-attempt handler (sets the row state in the same transaction as the dead-letter insert):

| Task | Row state at final failure | → state | `last_error_code` |
|---|---|---|---|
| `catalog.import_validate` | `scanning` with last error `scan_unavailable` | `quarantined` (fail closed, 08 R12b) | `common.upload_quarantined` |
| `catalog.import_validate` | `uploaded` / `scanning` / `validating` otherwise | `failed` | the task's `LimsError.code` or `common.internal` |
| `catalog.import_commit` | `committing` | `commit_failed` (nothing applied) | same |
| `catalog.export_build` | `queued` / `building` | `failed` | same |

## 11. Configuration

| Key | Scope | Default | Rationale |
|---|---|---|---|
| `LIMS_CATALOG_CACHE_MAX_ENTRIES` | global | 50000 | [CONV] ~10 tenants × few thousand objects |
| `LIMS_CATALOG_CACHE_TTL_SECONDS` | global | 600 | [CONV] revision key already guarantees freshness; TTL bounds memory |
| `LIMS_CATALOG_IMPORT_MAX_BYTES` | global | 15728640 | 15 MB (02-CV §10.2) |
| `LIMS_CATALOG_IMPORT_MAX_UNCOMPRESSED_BYTES` | global | 52428800 | [CONV] 50 MB |
| `LIMS_CATALOG_IMPORT_MAX_ZIP_ENTRIES` | global | 200 | [CONV] |
| `LIMS_CATALOG_IMPORT_MAX_COMPRESSION_RATIO` | global | 100 | [CONV] zip-bomb guard |
| `LIMS_CATALOG_IMPORT_MAX_ROWS` | global | 20000 | [CONV] per sheet |
| `LIMS_CATALOG_IMPORT_MAX_ISSUES` | global | 5000 | [CONV] |
| `LIMS_CATALOG_IMPORT_PARSE_TIMEOUT_MS` | global | 60000 | [CONV] |
| `LIMS_CATALOG_IMPORT_TTL_HOURS` | global | 168 | [CONV] matches idempotency-key retention 7 d (02-CV §4.5) |
| `LIMS_CATALOG_FILE_RETENTION_DAYS` | global | 30 | [CONV] working copies, not records |
| `LIMS_CATALOG_MAX_ACTIVE_IMPORTS_PER_TENANT` | global | 2 | [CONV] |
| `LIMS_CATALOG_PANEL_MAX_DEPTH` | global | 4 | [CONV] package → panel → panel → test |
| `LIMS_CATALOG_FORMULA_MAX_CHAIN_DEPTH` | global | 5 | [CONV] |
| `LIMS_CATALOG_EFFECTIVE_FROM_TOLERANCE_SECONDS` | global | 300 | [CONV] clock skew between BFF and API |
| `LIMS_CATALOG_PRICE_CHANGE_WARN_PCT` | global | 50 | [CONV] |

No per-tenant configuration keys: tenant choices (price lists, tax rules, surcharge) are data. Precedence order is fixed in v1 (a per-tenant order is a future CR).

## 12. Performance targets

Arithmetic from 04 §14 (all ASSUMPTION):
- Registrations: 500 patients/day/lab, peak hour 25 % → 125/h ≈ 0.035/s/lab; N = 10 → 0.35/s. Per registration ≈ 1 `resolveOrderables` + 10 `priceFor` (10 items/patient, 04 §14) ≈ 11 calls → **≈ 3.9 port calls/s** at peak.
- Results: 25,000 rows/day/lab (upper bound) × 25 % / 3600 s ≈ 1.74/s/lab; N = 10 → 17.4/s; each ≈ `referenceRangeFor` + `criticalLimitsFor` + (instrument path) `mapInstrumentCode` + `getTest` (memoised) ≈ 3–4 calls → **≈ 70 port calls/s** sustained peak.
- Burst 500 req/s (04 §14) × assume ≤ 4 catalog calls per request → 2,000 port calls/s worst case; with a warm in-process cache each call is one memoised revision read per request + in-memory work.
- Catalog size (ASSUMPTION, B3): ≤ 5,000 orderables, ≤ 15,000 analytes, ≤ 500 price lists × ≤ 5,000 items, ≤ 10 versions retained hot → ≤ 25 M price-item rows worst case across 10 tenants; typical far lower.

| Target | Value | Basis |
|---|---|---|
| CatalogPort p95, warm cache | ≤ 20 ms | 03-IC §4.2 |
| `resolveOrderables` 50 orderables | ≤ 50 ms | 03-IC §4.2 |
| Cold-cache `getTest` | ≤ 60 ms [CONV] | 3 indexed queries |
| `searchOrderables` p95 | ≤ 150 ms [CONV] | registration typing |
| Other reads p95 | ≤ 200 ms [CONV] | |
| Writes p95 (incl. revision lock + outbox) | ≤ 300 ms [CONV] | |
| Price import 1,000 rows | validate ≤ 10 s, commit ≤ 10 s [CONV] | |
| Price import 20,000 rows | validate ≤ 90 s, commit ≤ 60 s [CONV] | |
| Revision lock hold time | ≤ 50 ms per write tx except import commit (whole tx) [CONV] | serialises catalog writes per tenant |

Load test: k6-style script [tool PIN-C0] against the compose stack seeded at 1× and 10× the ASSUMPTION sizes (05-DoD §3.5).

## 13. Observability

Logs (02-CV §9): module `catalog`, operation/task ids, `import_id`, `export_id`, `catalog_revision`, counts. **Never** logged: doctor/credit-party names, phones, emails, file contents, cell values, formula sample inputs from requests (they could be patient values pasted for testing).

Metrics:

| Metric | Type | Labels |
|---|---|---|
| `lims_catalog_port_calls_total` | counter | `method`, `outcome` (ok, not_found, no_price, no_reference_range, unmapped, inactive, error) |
| `lims_catalog_port_duration_seconds` | histogram | `method` |
| `lims_catalog_cache_lookups_total` | counter | `kind`, `result` (hit, miss) |
| `lims_catalog_revision_bumps_total` | counter | `entity_type` |
| `lims_catalog_imports_total` | counter | `kind`, `outcome` (validated, invalid, quarantined, committed, commit_failed, expired, discarded) |
| `lims_catalog_import_duration_seconds` | histogram | `kind`, `phase` (validate, commit) |
| `lims_catalog_exports_total` | counter | `kind`, `outcome` |
| `lims_catalog_range_unit_mismatch_total` | counter | — |
| `lims_catalog_contact_reads_total` | counter | `purpose` |
| `lims_catalog_import_tasks_inflight` | gauge (inc at task start, dec in `finally`) | `phase` (validate, commit) [CONV: needed so the CatalogImportStuck rule below has a source] |

Alerts (registered with C1 — 05-DoD §3.7). Metrics carry no tenant label (cardinality), so "per tenant" conditions are evaluated over all tenants [CONV]:

| Alert | Condition | Severity |
|---|---|---|
| CatalogImportQuarantined | any `outcome="quarantined"` in 5 min | page (security) |
| CatalogNoPriceSpike | `no_price` > 5 % of `priceFor` calls over 15 min per tenant | ticket |
| CatalogNoRangeSpike | `no_reference_range` > 5 % of `referenceRangeFor` over 15 min | ticket |
| CatalogPortLatency | p95 > 50 ms for 10 min | ticket |
| CatalogImportStuck | import in `validating`/`committing` > 15 min | ticket |
| CatalogContactReadsSpike | `contact_reads_total{purpose="notification"}` > 10× 7-day median per hour | ticket (REQ-SEC-045) |

**Alert rules for C1** (08 A13 P-14; file `services/api/src/modules/catalog/ops/alerts.yaml`, wired by C1 through CR-C3-009; expressions and `for` values [CONV]):

| Alert | expr | for | severity | route |
|---|---|---|---|---|
| CatalogImportQuarantined | `increase(lims_catalog_imports_total{outcome="quarantined"}[5m]) > 0` | 0m | page | security |
| CatalogNoPriceSpike | `sum(rate(lims_catalog_port_calls_total{method="priceFor",outcome="no_price"}[15m])) / sum(rate(lims_catalog_port_calls_total{method="priceFor"}[15m])) > 0.05` | 15m | ticket | ops |
| CatalogNoRangeSpike | `sum(rate(lims_catalog_port_calls_total{method="referenceRangeFor",outcome="no_reference_range"}[15m])) / sum(rate(lims_catalog_port_calls_total{method="referenceRangeFor"}[15m])) > 0.05` | 15m | ticket | ops |
| CatalogPortLatency | `histogram_quantile(0.95, sum by (le) (rate(lims_catalog_port_duration_seconds_bucket[5m]))) > 0.05` | 10m | ticket | ops |
| CatalogImportStuck | `sum(lims_catalog_import_tasks_inflight) > 0` | 15m | ticket | ops |
| CatalogContactReadsSpike | `sum(increase(lims_catalog_contact_reads_total{purpose="notification"}[1h])) > 10 * quantile_over_time(0.5, sum(increase(lims_catalog_contact_reads_total{purpose="notification"}[1h]))[7d:1h])` | 0m | ticket | security |

**CI jobs for C0-0A** (08 A13 P-14; wired through CR-C3-009):

| Job id | Trigger paths | Runner OS | Command |
|---|---|---|---|
| `c3-wording-commission` | `services/api/src/modules/catalog/**`, `services/worker/src/jobs/catalog/**`, `apps/web/src/features/catalog/**`, `apps/web/src/app/(staff)/catalog/**`, `docs/manual/catalog/**` | Linux (C0's default runner) | `bash services/api/src/modules/catalog/__tests__/ci/wording-grep.sh` — fails when `grep -rniI commission` matches in the trigger paths (template texts live in `services/worker/src/jobs/catalog/xlsx/templates/*.ts`, so they are covered) (04 L19, AC-11.5) |

## 14. Test strategy

| Layer | What | Fakes / tools |
|---|---|---|
| Unit (`domain/`) | versioning and import state machines (every allowed + representative forbidden transition); `rangeMatch` (boundaries day 0, exact upper age, sex/specimen specificity, `other`/`unknown`, text/ordinal kinds, unit mismatch); `priceMatch` (all 5 sources, fall-through on/off, inactive list, effective windows); surcharge ranking + rounding golden cases (`@lims/shared-ts/money`); tax precedence + missing default; panel graph (cycle, depth, de-dup); formula graph (self-cycle, 2- and 3-cycles, chain depth 5 vs 6, dependency order); code normalisation; ZIP inspector against crafted fixtures (EOCD missing, ZIP64, encrypted flag, 201 entries, ratio 101, `..` path, vbaProject, externalLinks) | none |
| Formula vectors | G1–G10 + C5's additions through `@lims/shared-ts/formula` (incl. `log10` and `inexact` cases) | shared vectors `packages/fakes/contract-tests/formula.vectors.json` (08 R12a) |
| Integration (`service` + repo + RLS) | every service method on a migrated DB with tenants A/B; publish/supersede chains; immutability triggers (published version/band/item edits fail with SQLSTATE P0001 → `common.immutable_record`); revision monotonicity under 20 concurrent writers; outbox rows (one per bump, none on rollback) | `IdentityPort` fake (C0), real DB |
| Contract — port | `packages/fakes/contract-tests/CatalogPort.contract.ts` (all 13 03-IC cases) + C3 additions: (14) `getReferrer` display hides contact, notification shows it; (15) merged doctor → canonical id; (16) `resolveCommentCodes` department precedence + unknown list; (17) `priceFor` returns `vatRateBp = 1300` for taxable; (18) `tax_config_missing`; (19) text-kind range has no low/high; (20) `birthOn` exact-age boundary; (21) critical ordinal `abnormalCodes`; (22) unit/method mismatch → no_reference_range; (23) explicit inactive price list → not_found; (24) `getCreditParty` purpose `billing` returns `pan`/`billingAddressText`, never `contact`; (25) `TestDefinition.departmentName` present; (26) `resolveCommentCodes` with `asOf` before a text change returns the old text (08 §4.14); **08 A2.2:** (27) `getTaxRate` returns the `cs_tax_types` version effective on `on` (day before and on a new version's `effective_from`), and `VAT` → 1300 / `kind 'vat'`; (28) `getTaxRate` unknown code, inactive code, no version on `on`, or `rate_bp` NULL → `catalog.tax_config_missing`; tenant B's code is not visible to tenant A (→ `catalog.tax_config_missing`); **08 A4.1:** (29) `getTaxRate('VAT')` → `effectiveFrom: null` (not the row's `created_at`); (30) no input ever yields `kind: 'exempt'` (result kind ∈ {`vat`, `other`}); **08 A13 D-9:** (31) analyte with `ordinalSetCode` → `ordinalSetValues` equals the active values of that set in `sortOrder` order (an inactive value is absent); **08 A17.1:** (32) `referenceRangeFor` / `criticalLimitsFor` without `ageDays` and a set holding an age-unrestricted band plus age-bounded bands → the age-unrestricted band (with `birthOn` also sent, the result is the same); (33) without `ageDays` and only age-bounded bands (including an open-ended "18 y – ∞" band) → `catalog.no_reference_range` / `undefined`; **08 A24.1:** (34) `getPriceListStatus`: list with draft v1 only → `{isActive: true, status: 'draft'}`; after v1 publish → `published`; with published v1 + open draft v2 → `published`; every version discarded → `discarded`; deactivated list → `isActive: false`; no input ever yields `superseded` or `retired`; (35) `getPriceListStatus` with an unknown id or tenant B's list id under tenant A → `common.not_found` | fake (C0) and real impl |
| Contract — HTTP | every operationId: request/response validation on, every `x-error-codes` entry triggered once; hand-written permission tests for every conditional branch "`+ <code> when <condition>`" (#34, #96, #97–#107 per kind, #102 range publication) per 08 A13 P-10 | fastify-openapi-glue validation |
| Contract — events | every `catalog.changed.v1` emitted validates against the schema; idempotency key format; trigger table §9.1 row by row (incl. one `catalog_import` event per `catalog_master` commit — D-21) | ajv |
| Spreadsheet guard | export of a cell `=HYPERLINK(...)` is written neutralised (`'=`…) and no `<f>` element exists; export → import round-trip reports 0 changes (P-9) | worker unit |
| Probes | generated cross-tenant probes for all 107 operations + hand-written: bulk endpoints with mixed A/B ids; price-list assignment to tenant-B doctor/centre id; code map referencing tenant-B analyte; import commit of tenant-B import id; download of tenant-B file id | C0 generator |
| Worker | import validate/commit/export tasks against real DB with synthetic workbooks (`packages/test-fixtures`) incl. malicious fixtures; duplicate job delivery; crash between `committing` and commit (kill + retry) | real worker runtime |
| E2E (nightly) | lab_manager creates test + analytes + range set → publish → C5 fake reads it; finance exports price list → edits → imports → commits → `quotePrices` shows new price | browser tool [PIN-C0] |
| Load | §12 targets at 1× and 10× | [PIN-C0] |
| Log scan | planted doctor phone/email and cell values do not appear in logs | C0 log-scan test |
| Wording | CI grep over C3 paths for `commission` (case-insensitive) fails the build (04 L19) | grep |

## 15. Change requests raised

> Status per `program/08-CR-REGISTER.md` (2026-11-06). CR texts below are kept as history.

| CR | Status |
|---|---|
| CR-C3-001 | ACCEPTED-MODIFIED in 08 — Primary of merged CatalogPort set (C4-002, C5-001, C13-007, C11-009, C6-012): purpose `billing` (pan, billingAddressText), `departmentName`, `usesExistingMaterial`, `asOf` on resolveCommentCodes (§4.14). |
| CR-C3-002 | ACCEPTED-MODIFIED in 08 — One grammar = C3 TRD §7.1 + `log10`; exact decimal (≥28 digits), transcendental → `inexact`; C0-0A implements (R12a). |
| CR-C3-003 | ACCEPTED-MODIFIED in 08 — `entity_type` marked `x-extensible: true`; stays .v1 (R13). Permissions are in 03-IC §11; the "Interim (before merge)" text in the CR body below is **superseded** and must not be built. 08 A13 D-18 widens `catalog.reference_range.publish` to analyte-version publication and makes `catalog.instrument_code_map.manage` privileged. |
| CR-C3-004 | ACCEPTED in 08 |
| CR-C3-005 | MERGED in 08 into CR-C2-011 — Scanner mandatory in staging/prod (not optional). |
| CR-C3-007 | ACCEPTED in 08 A13 D-17 (C3 → C0-0A): `packages/test-fixtures/catalog/starter_catalog_master.xlsx` and `starter_price_list.xlsx`, generated by a script from §8.2 (columns) and 05-SCHEMA §8 (content), every value labelled SYNTHETIC (C0 TRD §3.5 domain-generator mechanism). |
| CR-C3-008 | RAISED 2026-11-06 (review C3 m#48; to C0-0C; pending lead registration in 08) — probe generator handling of not-yet-implemented operations; default C3 builds meanwhile: stub handlers throw `LimsError('common.service_unavailable', 'not_implemented')` (503, registered in 03-IC §8) and are listed in `services/api/src/modules/catalog/__tests__/probes/pending.json`, which the probe job skips; the list must be empty at M6 (06 T-01). |
| CR-C3-009 | RAISED 2026-11-06 (08 A13 P-14; to C0-0A + C1; pending lead registration in 08) — wire the CI job and alert rules listed in §13 ("CI jobs for C0-0A", "Alert rules for C1"). |
| Review fix pass 2026-11-06 | Review fix pass 2026-11-06 — review/C3-catalog-pricing.md + 08 Addendum A13 applied (P-1, P-3, P-6, P-8, P-9, P-10, P-11, P-14, P-15; D-9, D-16, D-17, D-18, D-19, D-20, D-21, D-22; all review findings fixed in C3 files or handed off). |
| CR-C3-006 | ACCEPTED-MODIFIED in 08 — Mapped to existing kit names; new `EditableGrid`, `CodeField`, `FormulaEditor`, `StatusStepper`, `DiffTable` (R22). |
| 08 Addendum A2/A3 | 08 Addendum A2/A3 applied 2026-11-06 — A2.2 (CR-C12-010, additive): `CatalogPort.getTaxRate` implemented by C3 from its tax-rule data (§6.1, §7.6a, §14 cases 27–28; 06 T-29a). No other A2/A3 item affects C3. |
| 08 Addendum A4 | 08 Addendum A4 applied 2026-11-06 — A4.1: `getTaxRate` signature (`RequestContext`; `kind 'vat' \| 'other'`, no `'exempt'`; `effectiveFrom string \| null`, `null` for the global VAT row — the `created_at` [CONV] removed) (§6.1, §7.6a, §14 cases 29–30; 06 T-29a). No other A4 item affects C3. 08 Addendum A5.6 confirms the tax-code format `^[A-Z0-9_]{1,16}$` used in §7.6a step 1. |
| Final sweep 2026-11-06 — second touch applied | Final sweep 2026-11-06 — second touch applied (`review/_triage-batch4.md` §(g) C3 group): **08 A17.1** `RangeQuery.ageDays` optional; age unknown matches only bands/limits with both age bounds absent, `birthOn` ignored [CONV] (§6.1, §7.3, §14 cases 32–33; PRD AC-05.11, AC-06.5; 03-APP-FLOW §4.2, E26; 04-UI-UX §7; 06 T-08, T-28a); **08 A24.1** `CatalogPort.getPriceListStatus` with C3's status set `draft\|published\|superseded\|discarded` (no `retired`) and the derived list status [CONV] (§6.1, §7.4a, §14 cases 34–35; PRD AC-19.6; 03-APP-FLOW §4.5b; 06 T-29b; 07 S-19); **f-11** C3's own `@throws` rows for the seven existing methods (§6.1); **C18 hand-off** blank `_meta.tenant_catalog_revision` accepted (§8.2; PRD AC-16.12; 03-APP-FLOW E27). No SQL changed (no DDL needed: `price_lists.is_active` and `price_list_versions.status` already exist; the lookups use `price_lists__tenant_id_id__uq` / `price_list_versions__tenant_id_price_list_id_version_no__uq`; 05-SCHEMA §4 row added). 03-IC §4.2 rows (ageDays, `getPriceListStatus`, JSDoc `@throws`) stay with the program-doc sweep (items 11–13). |

**08 Addenda applied (08 A25 P-60: one row per addendum A1–A29; final check 2026-11-06)**

| Addendum | Status for C3 |
|---|---|
| A1 | not applicable |
| A2 | applied 2026-11-06 — A2.2, A2.10 (TRD, AF, PLAN) |
| A3 | not applicable |
| A4 | applied 2026-11-06 — A4.1 (TRD, AF, PLAN) |
| A5 | applied 2026-11-06 — A5.6 (TRD) |
| A6 | not applicable |
| A7 | not applicable (A7 items concern C4, C6, C8, C12, C16; C3 is named only in the heading) |
| A8 | not applicable |
| A9 | not applicable |
| A10 | applied 2026-11-06 — A10.5 (SCH) |
| A11 | not applicable |
| A12 | applied 2026-11-06 — A12.2 (SCH) |
| A13 | applied 2026-11-06 — P-1, P-3, P-6, P-8, P-9, P-10, P-11, P-14, P-15, D-9, D-16, D-17, D-18, D-19, D-20, D-21, D-22 (PRD, TRD, AF, UI, SCH, PLAN, SEC) |
| A14 | not applicable |
| A15 | not applicable |
| A16 | not applicable |
| A17 | applied 2026-11-06 — P-21, A17.1 (PRD, TRD, AF, UI, PLAN, SEC) |
| A18 | not applicable |
| A19 | not applicable (A19 P-40 cites this chunk's existing port idempotency keys as already compliant; D-106/D-109/D-110/D-123 change other chunks or program docs) |
| A20 | not applicable |
| A21 | not applicable |
| A22 | not applicable |
| A23 | not applicable |
| A24 | applied 2026-11-06 — A24.1 (PRD, TRD, AF, UI, SCH, PLAN, SEC) |
| A25 | not applicable |
| A26 | not applicable |
| A27 | not applicable |
| A28 | not applicable |
| A29 | not applicable |



All are designed as if accepted. Template per `program/04-CHANGE-REQUESTS.md` §2.

### CR-C3-001 — CatalogPort V1 additive fields and three methods
```
Title: CR-C3-001: CatalogPort additive fields + getReferrer/getCreditParty/resolveCommentCodes
From chunk: C3            To owner: C0-0C (C3 implements; consumers C4, C5, C6 must acknowledge)
Type: port
Blocking? no (C3 implements behind the V1 interface once merged; consumers keep working without the new fields)
Problem: (a) C6 must print "Referred By" and NotificationPort must reach the referrer/centre/credit party
  (03-IC §4.8 "resolves contact details … via … catalog doctors") — CatalogPort has no referrer/credit-party read.
  (b) C5 must expand comment short codes server-side and store code+version+text (C5 AC-10.2; CR-C5-001 asks for
  the same method). (c) C5 cannot tell a text-only "Biological Ref Range" (Mentzer "<13.0 - Thalassemia trait /
  >13.0 - Iron deficiency") from a numeric one, nor know ordinal normal codes (urine "Negative") → PRD AC-05.5/05.6.
  (d) Age bands at an exact birthday need calendar age (AC-05.2). (e) C4 needs the VAT rate and extra-tax rate/HS
  code as data (04 L14/L25/L10; 07-BLOCKERS B7 "tax rules are data"). (f) C6 needs the "Specimen:" label (00 §4).
Proposed change (exact): the TypeScript in 02-TRD §6.1 (all new fields optional; three new methods; fakes gain the
  same seeded data: one merged doctor, one credit party with allowsCredit=false, comment codes in two scopes).
Backward compatible? yes — optional fields + new methods; CATALOG_PORT_VERSION stays 1.
Tenant/security impact: contact fields are P2 personal data of doctors/parties; returned only for
  purpose 'notification' (REQ-SEC-081); calls counted (REQ-SEC-045). No patient PHI.
Alternatives considered: consumers calling C3 HTTP from server code (breaks in-transaction port rule 02-CV §8.1);
  a v_pub view for doctors (views are for reporting reads only, 01-CM §5).
Tests that will prove it: contract cases 14–23 in 02-TRD §14.
```

### CR-C3-002 — Shared formula parser/evaluator (`@lims/shared-ts/formula`) — same need as CR-C5-002
```
Title: CR-C3-002: @lims/shared-ts/formula implementing the C3 grammar (02-TRD §7.1) + golden vectors
From chunk: C3 (co-requested by C5 as CR-C5-002)   To owner: C0-0A
Type: shared-lib
Blocking? yes — C3 task T-11 (formula validation) and C5 formula evaluation
Problem: formulas are stored in the catalog (01 §2.2) and validated by C3 but evaluated by C5; one grammar must be
  implemented once (02-CV: no copy-paste across chunks; packages/* are C0's).
Proposed change: package export `parseFormula(text) → {ast, refs, contextVars, errors}`,
  `evaluateFormula(ast, inputs: Record<Code, DecimalString|undefined>, ctx:{ageDays, ageYears, sex}) →
  {value: DecimalString} | {notComputable: reason}`, `formulaRefs(ast)`; decimal library pinned by C0;
  vectors G1–G10 as packages/fakes/contract-tests/formula.vectors.json (C3 and C5 both run them).
Backward compatible? yes (new module).
Tenant/security impact: pure function; no IO; DoS guarded by length/depth limits in the grammar.
Alternatives considered: each chunk implements its own parser (divergence risk; banned).
Tests: vectors G1–G10 + fuzz (random token strings never throw outside {errors}).
```

### CR-C3-003 — Registry additions: permissions, error codes, event entity types
```
Title: CR-C3-003: catalog permissions (3), error codes (3), catalog.changed.v1 entity_type values (4)
From chunk: C3            To owner: C0-0C (permissions.yaml, errors.yaml, events schema)
Type: api + event
Blocking? no (interim behaviour described below)
Proposed change:
  permissions.yaml:
    - { code: catalog.referrer.read,          privileged: false, roles: [tenant_admin, lab_manager, front_desk, finance, centre_staff] }
    - { code: catalog.reference_range.publish, privileged: true, roles: [pathologist, lab_manager] }   # clinical sign-off
    - { code: catalog.referrer.export,        privileged: true,  roles: [tenant_admin, lab_manager] }  # doctors' contacts (04 A4 data export)
  errors.yaml:
    - { code: catalog.tax_config_missing,     http: 422, owner: C3, title: "Tax configuration missing", meaning: "No tenant-default tax rule (04 L15/L25, B7)" }
    - { code: catalog.import_not_committable, http: 409, owner: C3, title: "Import cannot be committed", meaning: "Not in validated state, expired, or already committed" }
    - { code: catalog.import_stale_base,      http: 409, owner: C3, title: "Price list changed since export", meaning: "Base version superseded; resend with accept_stale_base" }
  catalog.changed.v1 payload entity_type enum: add "method", "unit", "value_set", "tax_rule".
Backward compatible? permissions/errors: additive. Event enum: adding values is a payload change consumers
  validate leniently (02-CV §7.2) — C0 decides whether this needs .v2; interim mapping in 02-TRD §9.1 is used until merged.
Interim (before merge): [SUPERSEDED — CR-C3-003 is accepted (03-IC §11); no interim grant is built. Original
  text removed in the review fix pass 2026-11-06; business-rule errors are 400 common.validation_failed (08 A13 P-1).]
Tests: permission matrix tests per role; error-code tests per x-error-codes.
```

### CR-C3-004 — Published view column addition
```
Title: CR-C3-004: add canonical_referrer_id to catalog.v_pub_referrer_directory
From chunk: C3            To owner: C0-0B (C8 acknowledges)
Type: schema
Blocking? no
Problem: merged duplicate doctors (quick-add duplicates, 06-GLOSSARY Referring doctor) must roll up in C8's
  "which doctor sends the most patients" (00 F3); orders keep the original referrer id.
Proposed change: column canonical_referrer_id uuid (= id when not merged) appended (05-SCHEMA §6).
Backward compatible? yes (additive column).
Tenant/security impact: none (ids only).
Tests: view returns survivor id for merged rows; RLS via security_invoker.
```

### CR-C3-005 — Core upload handling for `.xlsx` and optional malware-scan hook
```
Title: CR-C3-005: core multipart support + xlsx content type for catalog imports + ctx.files.scan hook
From chunk: C3            To owner: C0-0D (runtime core) — security-relevant (04-CR §3.6)
Type: shared-lib/core
Blocking? partly — T-20 (createImport) needs multipart parsing in the API core
Problem: 02-CV §10.2 upload allowlist covers pdf/jpeg/png only; 00 E4 requires uploading Excel.
Proposed change: (1) core multipart parser with per-route size cap (catalog: 15 MB) exposing the file as a Buffer
  to the handler, never written to disk; (2) per-route content-type allowlist; catalog import route allows
  application/vnd.openxmlformats-officedocument.spreadsheetml.sheet (+ application/octet-stream sent by some
  browsers, accepted only with .xlsx extension and ZIP magic bytes — C3 checks both); (3) optional
  ctx.files.scan(buffer) → {clean|infected|unavailable} backed by the ClamAV-class scanner of REQ-SEC-084 if C1
  deploys one; (4) streaming file response helper with Content-Disposition: attachment, nosniff, no-store.
Backward compatible? yes.
Tenant/security impact: new upload surface (REQ-SEC-083/084/085/087); original upload never re-served (D-C3-05);
  parsing only in worker with limits (02-TRD §8.4).
Tests: EICAR-in-zip fixture → quarantined when scanner present; 16 MB → 413; .xlsm → rejected; polyglot → rejected.
```

### CR-C3-006 — UI-kit components
```
Title: CR-C3-006: @lims/ui components needed by catalog screens
From chunk: C3            To owner: C0-0D
Type: ui-kit
Blocking? yes for T-30+ (screens); no for API tasks
Problem: no component inventory of @lims/ui is published yet; 02-CV §14 forbids local look-alikes.
Proposed change: the component list in 04-UI-UX §2 (names proposed; C0 may rename — C3 adapts).
Backward compatible? yes.
Tests: C0 storybook/a11y tests; C3 screen tests use them.
```

**Note on CR-C3-003 interim:** closed — CR-C3-003 is accepted (03-IC §11), so range/critical publication, and since 08 A13 D-18 analyte-version publication, require the privileged `catalog.reference_range.publish`; gap G-1 (07-SECURITY §7) is closed. No interim grant is built.
