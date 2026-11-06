# C5 Lab Workflow — 07 Security

Status: DECISION, 2026-11-05. Phase-1 applicability per 04 §12 rule (REQ-SEC §1, §3, §4, §6, §7 from Phase 1; §2 payments and §5 mobile not applicable to C5). REQ IDs are cited, not copied (research/02-security.md).

---

## 1. Applicable requirements

| REQ | How it applies in C5 |
|---|---|
| REQ-SEC-001/002 | ASVS L2 target; BOLA is the primary threat — every handler loads the object through RLS-scoped repos before `assertRole` with the object's `centre_id` (02-CV §10.1) |
| REQ-SEC-004 | 05-SCHEMA §6 column classification |
| REQ-SEC-006 | results only to authorised staff (`lab.result.read`) and via LabPort `approved` scope to C6/C14; events carry no values (except C7's inbound event) |
| REQ-SEC-011/012/014/015/016 | ENABLE + FORCE RLS on every lab tenant table; per-command policies `TO lims_app`; no DELETE policies; no `USING (true)` (05-SCHEMA §3.1) |
| REQ-SEC-013/067 | tenant/centre only from verified claims; no request body field carries tenant; `processing_centre_id` in receive body is checked against the actor's centre scope |
| REQ-SEC-017 | centre scoping with `centre_id` OR `processing_centre_id` predicate (05-SCHEMA §1 decision); recollection/aliquot/existing-material rows copy the processing centre, and lab-processing memberships need `all_centres` or every collection centre they process (08 A13 D-13); P2-bearing `ingest_log` and `worksheet_items` are centre-scoped (08 R3); `qc_results` scoped on `centre_id` |
| REQ-SEC-019/020/021 | C5 defines one trigger function `lab.enforce_result_lock()` — SECURITY INVOKER, `SET search_path = ''`, schema-qualified; no DEFINER functions requested |
| REQ-SEC-022/023/024 | helpers wrapped in `(SELECT …)`; `tenant_id` leads every index; repos add `tenant_id = $tenant` explicitly |
| REQ-SEC-025 | load test with 10× seed across two tenants includes worklist, history, host query |
| REQ-SEC-026/027 | composite `(tenant_id, id)` FKs throughout; `tenant_id NOT NULL` without default |
| REQ-SEC-028 | UUIDv7 ids in URLs; barcodes/registration numbers never in paths or query strings (POST lookup — CR-C5-008) |
| REQ-SEC-031 | all lab views `security_invoker = true` |
| REQ-SEC-039/131 | `lims_app` gets SELECT/INSERT/UPDATE per class; never DELETE; no BYPASSRLS |
| REQ-SEC-040/041/042/044 | probes §5; synthetic tenants A/B; negative RLS test per policy (C0 `db/tests`) |
| REQ-SEC-045/133 | metrics on `auth.forbidden` and `common.not_found` spikes per user on lab routes feed C1 alerts |
| REQ-SEC-062/067 | `lab.result.approve`, `lab.result.amend`, `lab.config.manage`, `lab.qc_hold.release` are privileged → membership re-validation + aal2 (IdentityPort) |
| REQ-SEC-072 | device actors reach C5 only through `LabPort` methods called by C7 handlers; they cannot call any `lab.yaml` operation (no lab permission in device set) |
| REQ-SEC-080/081 | spec-validated inputs, `additionalProperties: false`; DTO allowlists per role (02-TRD §5.9) |
| REQ-SEC-082 | parameterised SQL only; LIKE not used (barcode exact match) |
| REQ-SEC-088 | comment/free text rendered as React text nodes; label and worksheet SVG generated from validated `[A-Z0-9]` input only |
| REQ-SEC-089/090/091/092 | inherited from web shell/BFF (C0); all state changes are POST via BFF with Origin checks |
| REQ-SEC-095 | problem+json bodies with no PHI (e.g. never echo a barcode or value in `detail`) |
| REQ-SEC-096/097 | audit triggers on all C/M tables; `access_log` with exactly the registered actions `specimen_label.print`, `lab_result.view`, `lab_result_history.view`, `critical_value.view`, `worksheet.print`, `ingest_exception.view` (08 A13 D-11; operation map in 02-TRD §11) |
| REQ-SEC-098 | logs carry ids only; ingest logs carry `sha256(result_key)`; URLs carry UUIDs only |
| REQ-SEC-099 | every operation in `lab.yaml` has `x-permission`; none `x-public` |
| REQ-SEC-100 | bulk endpoints capped at 200 ids; bulk approve privileged; status board range ≤ 7 days |
| REQ-SEC-121 | instrument input treated as untrusted: schema-validated by C0 consumer wrapper, attachment path tenant check, barcode charset check, value length caps |
| REQ-SEC-136 | synthetic data only in non-prod; no real printer/patient data in fixtures |
| REQ-SEC-139 | no deletion paths; retention per tenant setting (B15) |

## 2. Assets and entry points

| Asset | Where |
|---|---|
| Result values, flags, comments, critical values (P3) | `lab.results`, `result_versions`, `result_observations`, `critical_value_log` |
| Lab-linked identifiers (P2): barcode, registration no | `lab.specimens`, `lab.orders`, ingest tables, labels |
| Approval integrity (who approved what, lock) | `lab.approvals`, lock trigger |
| Critical notification evidence | `lab.critical_notifications` (append-only) |
| Readiness signal to reporting | `lab.order.ready_for_report.v1` |

| Entry point | Actor |
|---|---|
| `lab.yaml` operations via BFF | staff users |
| `LabPort` methods | C6, C7 (incl. device ctx), C9, C10, C11, C14 in-process |
| Event consumers | worker system actor |
| Label/worksheet print pages | staff browser |

## 3. Threat model (STRIDE)

| Asset / entry | Threat | Category | Mitigation | Test |
|---|---|---|---|---|
| Result endpoints | Tenant A user reads tenant B result by id | I | RLS + explicit tenant filter; 404 parity | probe P-01 |
| Result endpoints | Centre-scoped centre staff reads another centre's results | I | centre predicate; front_desk/centre roles lack `lab.result.read` | P-02, P-10 |
| Approve | Technologist approves own verified result / escalates | E | `lab.result.approve` privileged + aal2; approver ≠ verifier | S-01, S-02 |
| Approved result | Value changed in place (API bug or SQL) | T | lock trigger + no value columns accepted by approve/verify endpoints; amendment only | S-03 (DB-level UPDATE as `lims_api` fails) |
| Amendment | Non-pathologist amends | E | `lab.result.amend` privileged → `lab.amend_requires_pathologist` | S-04 |
| Critical notifications | Entries edited/deleted to hide late notification | T/R | no UPDATE/DELETE grant; audit trigger; `notified_by` from actor | S-05 |
| Critical notifications | Notified-at back-dated | R | `notified_at` ≤ now + 5 min; `created_at` stored by DB; both shown | S-06 |
| Ingest consumer | Malicious/misbound device sends results for another tenant's barcode | S/T | event tenant from C7's verified device context; lookup by `(tenant_id, barcode)`; attachment path tenant check | P-08, S-07 |
| Ingest consumer | Flood of junk records filling exception queue | D | C7 ingest rate tier (04 §4: 60 req/min/device, ≤100 msgs/request); exception rows deduped per open key; alert on queue growth | S-08 |
| Host query (device ctx) | Device enumerates barcodes to learn patients | I | port returns sex/age only (no names/ids beyond specimen id); device sees only its centre; unknown barcode → `lab.specimen_not_found` without hints | P-09 |
| Barcode lookup | Barcode in URL/query logged by nginx | I | POST lookup with body; no barcode in routes | S-09 (route lint) |
| Labels | Label page used to harvest names for many orders | I | `lab.specimen.label_print` + centre RLS + access_log per specimen; ≤200 ids per call | P-05, S-10 |
| Status board | Wide date ranges to scrape | I/D | 7-day cap; pagination; general rate tier | S-11 |
| Bulk endpoints | Mixed-tenant id arrays | I/T | per-id not_found, no side effect on foreign ids | P-04 |
| Events produced | PHI leakage via event_log | I | payloads exactly 03-IC (no values/barcodes in lab events); producer schema validation | S-12 |
| Worksheets | Snapshot JSON exposes PHI to roles without access | I | worksheets readable only with `lab.worklist.read`; patient names fetched at render, not stored | P-06 |
| Formula engine | Expression injection / code execution | E | `@lims/shared-ts/formula` (C0-0A, 08 R12a): no C5 parser, no `eval`/`Function`, identifier allowlist = `inputAnalyteCodes`; limits as defined by that library | S-13 (fuzz through the library) |
| Comment text / short codes | Stored XSS in report or UI | T | plain text only, React text nodes; C6 renders as text | S-14 |
| Settings / delta rules | Unauthorised loosening of checks | T/E | `lab.config.manage` privileged; versioned rules; audit | S-15 |
| QC hold release | Releasing hold without authority | E | `lab.qc_hold.release` privileged; comment required | S-16 |
| Port callers | A module calls `getOrderResults('all_visible')` without permission | E | method asserts `lab.result.read` | S-17 (contract case 2) |

## 4. Abuse cases

1. A front-desk user tries `GET /v1/lab/orders/{id}/results` → `403 auth.forbidden` (no `lab.result.read`).
2. A technologist scans a barcode from another tenant's printed label (same pattern) → lookup searches only own tenant → 404 "No specimen with this barcode in your lab."
3. A pathologist verifies then approves the same result to skip the two-step rule → `lab.self_approval_forbidden`.
4. A user replays a captured bulk-approve request with a new idempotency key after results were amended → each id's `version` mismatch → per-id `common.version_conflict`.
5. A centre-staff user edits `processing_centre_id` in a receive body to a hub they do not belong to → `403 auth.forbidden` (scope check) and nothing written.
6. A user sends `status` or `tenant_id` fields in a body → `400 common.validation_failed` (unknown field).
7. A compromised bridge PC sends an attachment path under another tenant's prefix → exception `attachment_tenant_mismatch`, nothing attached.

## 5. Required security tests

### 5.1 Probes (every operation and every table — 02-CV §11.3)

| ID | Probe |
|---|---|
| P-01 | For every `lab.yaml` operation with an id parameter: tenant-A user with tenant-B ids → `404 common.not_found`, body has no B data, DB check shows no B change. Exception: #26 `getAnalyteTrend` (RLS-filtered list keyed by `patient_id`) returns `200` with empty `points` for invisible patient ids (no existence oracle) |
| P-02 | Same with a centre-A1-scoped user against centre-A2 objects (specimens, results, critical values, exceptions, worksheets, status board rows) |
| P-03 | List operations (`listSpecimens`, `listWorklistItems`, `listPendingItems`, `listVerificationQueue`, `listCriticalValues`, `listIngestExceptions`, `listQcResults`, `listQcHolds`, `getStatusBoard`, `listWorksheets`, `listDeltaCheckRules`, `listLabCodedSet`) with B data present → zero B rows |
| P-04 | Bulk operations with mixed A/B ids → per-id `common.not_found` for B, A processed |
| P-05 | `printSpecimenLabels` and `requestOrderLabelPrint` with `order_id` of tenant B → 404; of centre A2 for A1 user → 404 |
| P-06 | `getWorksheet` of another centre → 404 |
| P-07 | Write/FK probes: aliquot request listing a tenant-B test id; assign exception to tenant-B result; `logCriticalNotification` on B event → rejected |
| P-08 | Consumer probe: `instruments.result.received.v1` in tenant A with a barcode existing only in B → exception `unknown_barcode` in A, B untouched |
| P-09 | `LabPort.getPendingTestsForBarcode` under a device ctx of centre A1 for a specimen received at A2 → `lab.specimen_not_found`; for a B barcode → `lab.specimen_not_found` |
| P-10 | Role probe: each default role against each operation matches 03-IC §11 grants (+ CR-C5-004; + 08 A13 D-4 `lab.specimen.read` for `front_desk`/`phlebotomist`); `front_desk` still gets `403` on every result operation |
| P-11 | Consumer probes, one per consumed event (02-TRD §7.2: `frontdesk.order.*` ×3, `instruments.qc.received.v1`, `catalog.changed.v1`, `quality.qc_run.rejected.v1`, `homecollection.collection.synced.v1`, `reporting.report.released.v1`; P-08 covers `instruments.result.received.v1`): an event in tenant A that references tenant-B ids (e.g. a B `specimen_id`, a B `order_id`) → no B row changes, the A outcome is logged (skip / not found / dead letter as the consumer defines) |
| P-12 | Hub-lab scope (08 A13 D-13): a processing-centre user without `all_centres` and without the collection centre cannot see a specimen before receipt (expected); after receipt at their centre they see it, its recollection/aliquot rows and its existing-material order tests/results |
| P-T | Table probes for every lab tenant table (C0 `db/tests`): A claims see 0 B rows; INSERT with B tenant fails; UPDATE of B rows affects 0; DELETE privilege absent |

### 5.2 Specific security tests

| ID | Test |
|---|---|
| S-01 | approve without `lab.result.approve` → 403; at aal1 → `auth.mfa_required`; membership revoked after token issue → privileged check fails |
| S-02 | approver = verifier → `lab.self_approval_forbidden` |
| S-03 | as `lims_api`: `UPDATE lab.results SET value_numeric = … WHERE status = 'approved'` → `immutable_row`; `UPDATE lab.result_versions SET value_numeric = …` → `immutable_row`; DELETE on any lab table → permission denied |
| S-04 | technologist amend → `lab.amend_requires_pathologist` |
| S-05 | `UPDATE`/`DELETE` on `lab.critical_notifications` as `lims_api` → permission denied |
| S-06 | `notified_at` > now + 5 min → `common.validation_failed` |
| S-07 | attachment with foreign tenant prefix → exception, CHECK constraint also rejects direct insert |
| S-08 | 1,000 identical unmatched records → one open exception (`attempts` = 1,000), not 1,000 rows |
| S-09 | route/spec lint: no lab path or query parameter named barcode/registration_no |
| S-10 | every `printSpecimenLabels` call writes one `access_log` row `specimen_label.print` per specimen; `requestOrderLabelPrint` writes none and changes no counter (08 A13 D-4); every other access-log call uses one of the six D-11 actions |
| S-11 | status board with range > 7 days → `common.validation_failed` |
| S-12 | producer tests: lab event payloads contain no keys outside 03-IC schemas (no `barcode`, `value`, `comment`) |
| S-13 | formula fuzz through `@lims/shared-ts/formula` (shared lib, 08 R12a): random strings, deep nesting, huge numbers, unknown identifiers → `not_computable`, never throw uncaught, never execute code |
| S-14 | comment text `<script>` rendered inert in grid, worksheet and label |
| S-15 | delta rule create/version by technologist → 403; by lab_manager at aal1 → `auth.mfa_required` |
| S-16 | QC hold release without permission → 403 |
| S-17 | LabPort `getOrderResults(all_visible)` with an actor lacking `lab.result.read` → `auth.forbidden` |
| S-18 | log scan: planted synthetic patient name, barcode, value and comment in a full journey → none appear in API/worker logs |
| S-19 | error bodies for every lab error code contain no barcode/value (snapshot tests) |
| S-20 | `LabPort.lookupSpecimens` with a device actor → `auth.forbidden`; `{orderId}` form by a user holding only `homecollection.visit.read` returns only visible specimens; other-tenant ids omitted (08 §4.14) |
| S-21 | `submitModuleResult` on an approved result without `amendment` → `lab.amendment_reason_required`; `module_phase_progression` from `anatomic`, `module_preliminary_update` with `reportPhase = 'final'` or from `anatomic` (08 A17 D-61), and `supplementary_report` from `micro` → `lab.module_result_invalid`; `amendResult` with any of the three module-only codes → `400 common.validation_failed` (08 R1; 08 A13 P-1) |
| S-22 | `getAnalyteHistory` never returns another patient's or another tenant's results; `getOrderItemProcessingState` returns no PHI |
| S-23 | Claims with `actor_type` `partner`/`portal`/`patient` see 0 rows of every tenant-scoped `lab` table (`app.is_staff_or_system()`; centre-scoped tables fail closed via `app.has_all_centres()` — 08 R3/R10) |

## 6. PHI handling and logging rules

- Store P2/P3 only in `lab` tables listed in 05-SCHEMA §6; never in logs, metrics labels, traces, job payloads beyond the C0 event envelope, or error `detail`.
- Patient names are never stored by C5; they are fetched through `FrontdeskPort` per request with the narrowest purpose (`label_print`, `lab_display`) and not cached.
- Job payloads enqueued by C5 tasks contain ids only (`specimen_id`, `tenant_id`, revision numbers).
- Raw instrument values in `ingest_exceptions` are visible only via `getIngestException` (access-logged).
- Printed labels and worksheets carry PHI by necessity; printing is access-logged; the worksheet footer marks it as a snapshot.
- Clipboard: no special handling on staff web [CONV]; REQ-SEC-111 is mobile-scoped.

## 7. Secrets

C5 uses no secrets of its own: no provider credentials, no signing keys, no tokens. It relies on C0 core for DB credentials (`lims_api`, `lims_worker` login roles) and on C2/C0 for session/JWT handling. No Supabase `service_role`/secret key (04 D5; 02-CV §10.2).

Final sweep 2026-11-06 — second touch applied (S-21 extended with `module_preliminary_update`, 08 A17 D-61).
