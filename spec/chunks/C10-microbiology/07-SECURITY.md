# C10 Microbiology — 07 Security

Status: DECISION, 2026-11-06. Applies from Phase 2 (04 §12 rule: REQ-SEC §1, §3, §4, §6, §7 apply to every shipped component). IDs are cited, not copied (02-CV §10).

---

## 1. Applicable requirements

| REQ | How it applies in C10 |
|---|---|
| REQ-SEC-001 | ASVS 5.0 L2 target for all `/v1/micro` operations and micro screens |
| REQ-SEC-002 | BOLA is the primary threat: every handler loads the culture/isolate/record/set through RLS before `assertRole` (02-TRD §13) |
| REQ-SEC-004 | Data inventory = 05-SCHEMA §7 classification (P2 barcode columns, P3 culture/AST content) |
| REQ-SEC-005/006 | No disclosure path in C10: report content leaves only through C6 (consent enforced there); C10 sends nothing externally |
| REQ-SEC-007 | All micro data in the Nepal DB; no foreign touchpoint added (04 §11) |
| REQ-SEC-011–016 | ENABLE+FORCE RLS on every `micro` tenant table, per-command policies `TO lims_app`, no `USING (true)`; staff-actor guard `(SELECT app.is_staff_or_system())` in every `__tenant` predicate and user/system-only guard in `__tenant_centre` (08 A17 P-16; review m#30); one DELETE policy only — `instrument_records__delete__tenant_centre` (class E, system actor, expired rows; 08 A17 D-65) (05-SCHEMA §4, §8) |
| REQ-SEC-017 | Centre predicate on culture-bearing tables: `centre_id` (collection centre, copied to every child row) only; hub staff need `all_centres` or membership of each collection centre (08 A17 D-63, A13 D-13(2)) |
| REQ-SEC-019–021 | No SECURITY DEFINER in C10: guards and `micro.tg_child_final_lock()` are INVOKER; the instrument-record purge is a `per_tenant` system-actor DELETE under RLS (08 A17 D-65), so no 08 §4.7 inventory row is needed |
| REQ-SEC-022/023/024 | helpers wrapped in `(SELECT …)`; `tenant_id` leads every index; repositories also filter `tenant_id = $tenant` |
| REQ-SEC-026/027/028 | composite FKs incl. into `lab`, `frontdesk`, `catalog`, `instruments`, `core`; `tenant_id` without default; UUIDv7 ids only in URLs |
| REQ-SEC-031 | `micro.v_pub_report_content` and internal views `security_invoker = true` |
| REQ-SEC-040/041/042/044 | probe suite §5; two synthetic tenants; negative RLS tests (05-SCHEMA §10); mixed-tenant ids in bulk bodies (`recordAstResults` entries reference only the path isolate) |
| REQ-SEC-045 | metrics `lims_rls_denied_total` + `culture.view` access-log volume feed C1's anomaly alerts |
| REQ-SEC-062/067 | `micro.breakpoint.manage` privileged → aal2 + membership re-validation (CR-C10-004); `lab.result.amend` checked by C5 |
| REQ-SEC-080/081 | strict request schemas (`additionalProperties: false`, maxLength everywhere); DTO allowlists (02-TRD §5.6) |
| REQ-SEC-082 | parameterised SQL only; organism/antibiotic search `q` escaped for LIKE prefix |
| REQ-SEC-083/085 | CSV upload through `ctx.uploads.accept` (`allow: ['text/csv']`, `scan: 'not_applicable'`, `bucket: 'micro-imports'`, `objectPath: {tenant_id}/breakpoints/{set_id}.csv`, 08 §4.13): size cap 5 MiB (5,242,880 bytes), UTF-8/NUL sniffing, random object name under `{tenant_id}/…`; template download as `attachment` + `nosniff` |
| REQ-SEC-084 | not applied to CSV (text parsed by an in-house parser, never opened by staff tools or rendered) — matches the program rule "scan mandatory for every type except `text/csv`" (08 R12b); reconsider if xlsx import is added (xlsx is scanned) |
| REQ-SEC-088 | free texts rendered as text nodes only |
| REQ-SEC-091/092 | state changes are POST/PUT through the BFF (Origin checks in core) |
| REQ-SEC-095 | problem+json without internals; CSV issue messages never echo more than 40 chars of a cell |
| REQ-SEC-096/097 | data changes audited by C0 triggers (M/C/E tables); `access_log` codes `culture.view`, `breakpoint_set.{import,activate,retire}`, `micro_instrument_record.assign` (CR-C10-010; 08 §4.4), listed operation → action → entityType in 02-TRD §13 (08 A13 P-3) |
| REQ-SEC-098 | no PHI in URLs (barcode scan via POST to C5; no barcode/names in query strings) or logs (02-TRD §11 denylist) |
| REQ-SEC-099 | every operation in `micro.yaml` has `x-permission`; no `x-public` operation in C10 |
| REQ-SEC-100 | bulk endpoint caps (60 AST entries, 200 page size); breakpoint activation four-eyes |
| REQ-SEC-121 | instrument records from C7 events are treated as untrusted data: length/enum limits enforced by C10's own CHECKs and validation; never executed or rendered as HTML |
| REQ-SEC-131 | runs as `lims_api`/`lims_worker` (members of `lims_app`), no BYPASSRLS |
| REQ-SEC-133 | alerts of 02-TRD §11 |
| REQ-SEC-136 | synthetic fixtures only; breakpoint fixtures use made-up `synthetic_*` codes and values |
| REQ-SEC-139 | no deletes of clinical rows; `instrument_records` (class E) purged `retention.rawInstrumentYears` after it becomes `applied`/`ignored`, never while an AST row references it (08 A17 D-65; 05-SCHEMA §7) |

Not applicable: payment (§2), mobile (§5), bridge-agent host controls (REQ-SEC-114–120, 122–123 — C7).

## 2. Assets and entry points

| Asset | Class | Where |
|---|---|---|
| Culture/isolate/AST content, report snapshots | P3 | `micro.*` C/A tables, view |
| Barcodes in instrument records / culture snapshots | P2 | `instrument_records.sample_barcode`, `cultures.barcode_snapshot` |
| Breakpoint tables (lab-licensed) | P0, but integrity-critical and licence-sensitive | `breakpoint_*`, bucket `micro-imports` |
| Interpretation integrity (category + standard + version) | integrity-critical | `ast_results`, snapshots |
| Hand-off to the release chain | integrity-critical | `LabPort.submitModuleResult` |

| Entry point | Auth |
|---|---|
| `/v1/micro/*` (M1–M49) via BFF | staff session → bearer JWT; permissions per 02-TRD §5 |
| Worker consumers (`evt.micro.*`) | system actor of `micro` (tenant from the event envelope) |
| Cron tasks (`micro.reconcile_chain_status`, `micro.refresh_metrics`, `micro.purge_instrument_records`) | `tenantScope: 'per_tenant'` (08 A13 P-6): one job per tenant under that tenant's claims for the `micro` system actor |
| `micro.v_pub_report_content` | read by C6/C14 code under their own context (`security_invoker`) |

## 3. Threat model (STRIDE)

| # | Asset / entry | STRIDE | Threat | Control | Test |
|---|---|---|---|---|---|
| T-A1 | M2/M15/M16 culture read | I | User of tenant A reads tenant B culture by UUID | RLS + explicit tenant filter; 404 identical to missing | S-01 |
| T-A2 | culture read | I | Centre-scoped user reads another centre's culture | centre predicate | S-02 |
| T-A3 | M7–M12 isolate/AST writes | T | Body references a plate/isolate/observation of another culture (or tenant) to graft data | id-belongs-to-path checks (`common.id_mismatch`), composite FKs | S-03, S-04 |
| T-A4 | M12 bulk AST | E/T | Client sends `interpretation_source`, `standard_source`, `entered_by` to forge provenance | not in request schema (strict) | S-05 |
| T-A5 | M14 submission | T | Submit a report with stale/forged content or for another order item | server builds snapshot from DB; `orderItemId` from the culture row only; ajv on snapshot; C5 validates workflow | S-06 |
| T-A6 | M14 | E | Technologist changes an approved result via C10 to bypass "only pathologist changes" (00 C6) | C5 enforces `lab.result.amend` inside `submitModuleResult` (R7); C10 cannot mark anything approved | S-07 |
| T-A7 | report versions | T/R | Edit or delete a submitted version | no UPDATE/DELETE grant; version_no unique; audit of working rows | S-08 |
| T-A8 | AST categories | T | Store an interpretation without standard/version, or "I" interpreted across standards | CHECK + FK on `(standard, category_code)`; final guard; no cross-standard logic | S-09 |
| T-B1 | M42 import | E | Non-privileged user changes breakpoints | `micro.breakpoint.manage` privileged (aal2 + membership re-validation) | S-10 |
| T-B2 | M46 activate | T/R | One insider imports and activates a manipulated table | four-eyes (`created_by ≠ activator`), access_log for import/activate/retire, immutable rows | S-11 |
| T-B3 | M42 | D | Huge/pathological CSV exhausts the worker | 5 MiB cap at API, 20,000 lines, 60 s timeout, job retries 3, parser streaming line-by-line | S-12 |
| T-B4 | M42 | T | Malicious content (formula injection, HTML) in CSV | parsed as text only; never evaluated; never rendered as HTML; issues echo ≤ 40 chars as text nodes; template has no data; no export of uploaded content to spreadsheets in v1 | S-13 |
| T-B5 | breakpoint licence | — (legal) | The LIMS provider distributes copyrighted tables | no values in repo/seeds/docs (CI grep for `breakpoint_bands` seed inserts and band-like CSV in `db/seeds`); attestation text required | S-14 |
| T-B6 | bucket `micro-imports` | I | Another tenant downloads a CSV via storage path | all access server-side through `ctx.storage` (adapter enforces first path segment = `ctx.tenantId` and the `micro-` bucket prefix); no end-user `storage.objects` policies until SP-4 passes (04 D3 UNVERIFIED; 08 R12b); signed URLs internal only, never sent to browsers | S-15 |
| T-C1 | consumer `instruments.result.received.v1` | S/T | Forged instrument record injects AST values | events originate only from C7's device-authenticated ingest (REQ-SEC-121) through the outbox; C10 never accepts records over HTTP; conflicts with manual data require a human decision | S-16 |
| T-C2 | instrument record matching | I | Assign a record to a culture of another centre/tenant | `assign` loads the target culture via RLS (404) | S-17 |
| T-C3 | consumers | T | Replayed/duplicated events create duplicates | inbox + creation key + record key | S-18 |
| T-C4 | consumers | E | Event with `tenant_id` A and ids of tenant B | worker sets claims from the envelope tenant; composite FKs fail for foreign ids → dead letter (no cross-tenant write) | S-19 |
| T-D1 | logs/metrics | I | Barcodes, organisms, values, free texts leak to logs | denylist of every P2/P3 column and request text field (02-TRD §11) + log-scan test with planted PHI | S-20 |
| T-D2 | URLs | I | Barcode in a query string during scan | scan via POST (C5 lookup); route params UUID only | S-21 |
| T-D3 | M19 inbox | I | Barcode list scraped by a broad role | `micro.culture.read` only (lab roles), page cap 200, access through RLS | S-22 |
| T-E1 | config M24–M40 | E | Technologist edits dictionaries/panels to change reporting | `micro.config.manage` (lab_manager) | S-23 |
| T-E2 | M24 | T | Tenant edits global AST categories | `ast_interpretations` not writable (403); G tables no write grants | S-24 |
| T-F1 | M1 list | D | Expensive filters / counts | partial indexes, `include_total` cap 10,000, rate-limit tier `general` | S-25 |

## 4. Abuse cases

1. A technologist wants to "fix" an approved culture without a pathologist → reopen is allowed, but submission on an approved C5 line fails with `lab.result_locked` unless the actor holds `lab.result.amend` (S-07).
2. A lab manager uploads a breakpoint table copied from a source the lab is not licensed for → the platform records the attestation, the importer and the activator (two people); the LIMS provider never ships content (S-11, S-14).
3. Someone adjusts a breakpoint to flip results → activation needs a second user; old sets stay immutable; each AST row records the set and band used (S-11, audit).
4. A user scans barcodes to discover whether a person had a micro test at another centre → scan goes through C5 lookup under RLS and the C10 list under RLS; the message for "unknown barcode" and "no culture" is identical (AC-02.2, S-02).
5. Bulk scraping of instrument records → page cap, permission, rate limit, access-log volume alerts (S-22).
6. A forged "instrument" record overwrites a manual AST → conflicts never auto-overwrite manual data (AC-08.6).

## 5. Required security tests (all in `services/api/src/modules/micro/__tests__/probes` unless noted)

| # | Test |
|---|---|
| S-01 | **Cross-tenant probe for every operation M1–M49**: tenant A user with tenant B ids in path, body (`plate_id`, `parent_plate_id`, `source_isolate_id`, `corrects_observation_id`, `ast_panel_id`, `breakpoint_band_id`, `culture_id` in assign, `instrument_id` in maps/defaults, `test_id` in protocol `applies_to`) and query (`specimen_id`, `order_id`, `culture_id`, `instrument_id`) → `404 common.not_found` (or `422` for FK-validated config ids), no B data in body, no side effect in B (DB check as owner) |
| S-02 | **Cross-centre probe** for M1, M2, M3–M22 (08 A17 D-63): a user of centre A1 only sees A1 cultures, records and child rows only (A2 → 404; lists return zero A2 rows); a D-13 hub user (`all_centres`) sees both (positive case) |
| S-03 | id-mismatch: plate/isolate/observation of another culture of the same tenant → `400 common.id_mismatch` |
| S-04 | composite FK write probes: insert child rows referencing B parents → rejected (DB) |
| S-05 | strict schema: unknown/forbidden fields (`interpretation_source`, `standard_source`, `isolate_seq` on create, `signed_by_membership_id`, `status`, `tenant_id`) → `400 common.validation_failed` |
| S-06 | snapshot authority: client cannot influence `isolates`/`ast` JSON except via working rows; `orderItemId` sent to the LabPort fake equals the culture's |
| S-07 | privilege escalation: technologist submitting on an approved C5 line → `409 lab.result_locked` passed through (LabPort fake with approved line); pathologist at aal1 → `403 auth.mfa_required` |
| S-08 | grants: `lims_app` has no UPDATE on `report_versions`/A tables and no DELETE in `micro` except on class E `instrument_records`; that DELETE affects 0 rows under `user` claims and only expired rows under `system` claims (db/tests, 05-SCHEMA §10 items 2 and 11) |
| S-09 | category integrity: `(EUCAST, SDD)` rejected; category without standard/version rejected; final blocked by `standard = unknown` |
| S-10 | `micro.breakpoint.manage` operations at aal1 → `auth.mfa_required`; without permission → `auth.forbidden`; revoked membership after token issue → privileged check fails |
| S-11 | four-eyes: importer activation → `403 micro.breakpoint_four_eyes_required`; second user succeeds; access_log rows for import/activate/retire present |
| S-12 | DoS: 5 MiB + 1 byte → `413 common.payload_too_large`; 20,001 lines → `invalid` (`file.too_many_rows`); slow/pathological quoting → `file.parse_timeout` within 60 s |
| S-13 | CSV injection: cells starting with `=`, `+`, `-`, `@`, `<script>` stored nowhere except as issues; UI renders issue text as text (component test) |
| S-14 | CI grep: no inserts into `micro.breakpoint_*` in `db/seeds` or migrations; no breakpoint band data (CSV or seed SQL) under the repo outside the allowlist `packages/test-fixtures/**/micro/synthetic_*` and `**/__tests__/**/synthetic_*`; CI also asserts that every allowed file uses only `synthetic_` organism/antibiotic codes and carries `NOT CLINICAL` in every band `note` (review m#31) |
| S-15 | storage probe: tenant A cannot read `micro-imports/{tenant_B}/…` — adapter refuses an object path whose first segment ≠ `ctx.tenantId`; no browser-reachable Storage API path or signed URL exists for the bucket (08 R12b; 04 D3) — **blocking for enabling M42 in any environment** |
| S-16 | no HTTP path creates instrument records (spec has no such operation; test asserts operation list) |
| S-17 | `assignMicroInstrumentRecord` to a culture of another centre/tenant → 404 |
| S-18 | duplicate event delivery and duplicate idempotency key → single culture / single record |
| S-19 | event with tenant A envelope and tenant B `specimen_id` → no row in either tenant; dead letter after retries |
| S-20 | log scan: run the integration suite with a planted synthetic value in every field of the 02-TRD §11 denylist (barcodes, codes, raw values, every free text incl. `comment`, `reasonText`, `summaryText`, `licence_attestation_text`); assert none in captured logs (05-DoD §1.8) |
| S-21 | route/URL check: no micro route or BFF call carries barcode, name or values in query strings (static check on route builders + MSW request assertions) |
| S-22 | `listMicroInstrumentRecords` denied for roles without `micro.culture.read` (`front_desk`, `centre_staff`) |
| S-23 | config writes by `lab_technologist` → `auth.forbidden` |
| S-24 | `PUT /coded-sets/ast_interpretations/codes/S` → `403 auth.forbidden`; G tables have no write grant |
| S-25 | `limit=201` → 400; `include_total` capped |
| S-26 | **Every owned table** (05-SCHEMA §1): SQL probe with tenant A claims → SELECT sees 0 B rows; INSERT with B `tenant_id` fails; UPDATE of B rows affects 0 rows (C0 `db/tests`, requested here) |
| S-27 | view probe: `micro.v_pub_report_content` under tenant A claims returns no B rows; under A1 centre claims no A2 rows |
| S-28 | actor guard (08 A17 P-16; review #2, m#30): partner, portal and patient claims of tenant A read 0 rows of every `micro` tenant and centre table; device claims (`centre_id` = A1) read 0 rows of every `__tenant_centre` table |
| S-29 | final lock (review #7): with a `final_submitted` culture, direct SQL INSERT/UPDATE on `isolates`, `ast_results`, `culture_plates` and INSERT on `culture_observations` fail with `P0001`; the API maps them to `409 micro.report_final_locked` |
| S-30 | reopen reasons (08 A17 D-62): the reopen dialog never offers `module_phase_progression`, `module_preliminary_update` or `supplementary_report`; M17 with one of them is accepted for format, but the later submission on an approved C5 line returns `422 lab.module_result_invalid` and the culture stays `amending` |

## 6. PHI handling and logging rules

- C10 stores ids, not names: no patient name, phone or age in any `micro` table. Names appear only in the browser through C4's API under the user's own permission.
- Barcodes (P2) are stored only in `instrument_records.sample_barcode` (needed for matching) and `cultures.barcode_snapshot` (CR-C10-003). Never logged; never in URLs; returned only to holders of `micro.culture.read`.
- Logs: ids, codes, counts, durations; `idempotency_key_sha256` instead of the instrument key (it contains a barcode); CSV parsing errors log line numbers and issue codes only.
- Metrics labels: `tenant_id`, status/outcome codes only (no organism/antibiotic labels — they would reveal per-patient findings at low volume).
- Error responses never include organism names, values or barcodes in `detail`.
- Exports: none in C10 v1 (antibiogram is a future C8 view — 06-IMPLEMENTATION-PLAN §4).

## 7. Secrets used

None specific to C10. The module uses the core-provided DB connection (`lims_api`/`lims_worker`), the session/JWT verification of the core, and the core storage helper (credentials held by C0/C1's secret store). No provider keys, no tokens issued, no Supabase `service_role` (04 D5; 02-CV §10.2).
