# C9 Quality Engine — 07 Security

Status: DECISION, 2026-11-06. Requirements are cited by ID from `research/02-security.md` (REQ-SEC-###) and 04; not copied. Phase applicability: 04 §12 rule — REQ-SEC §1, §3, §4, §6, §7 apply; payment (§2) and mobile (§5) requirements do not apply to C9.

## 1. Applicable requirements and how C9 meets them

| REQ | How it applies in C9 |
|---|---|
| REQ-SEC-001 | ASVS 5.0 L2 target for every `/v1/quality` operation and staff page |
| REQ-SEC-002 | BOLA is the primary threat: every `{id}` endpoint loads the object through an RLS-scoped repository first (404 if invisible), then `assertRole` (02-CV §10.1) |
| REQ-SEC-004 | Data inventory: 05-SCHEMA §1 PHI column; decisions/verification log/TAT tables are P3 pseudonymous |
| REQ-SEC-011/012/014/015/016 | every `quality` table ENABLE + FORCE RLS, per-command policies `TO lims_app`, no `USING (true)`; every `__tenant`/`__tenant_centre` policy carries `(SELECT app.is_staff_or_system())` (08 A17 P-16) and centre policies use the `::uuid[]` cast (08 A16.1); the only DELETE policy is `tat_items__delete__tenant` (system actor, `expires_at < now()`, 08 A17 P-18(c)) (05-SCHEMA §5) |
| REQ-SEC-013/067 | tenant only from verified claims (`app.current_tenant_id()`); request bodies never carry `tenant_id`, `created_by`, `status`, `outcome` (spec does not declare them) |
| REQ-SEC-017 | TAT tables centre-scoped (`__tenant_centre`); QC/auto-verify tables tenant-scoped by documented DECISION (05-SCHEMA §1) |
| REQ-SEC-019/020/021 | C9 adds three trigger functions (`quality.enforce_run_frozen`, `quality.enforce_observation_exclusion`, `quality.enforce_version_frozen`): SECURITY INVOKER, `SET search_path = ''`, schema-qualified; no SECURITY DEFINER function |
| REQ-SEC-022/023/024 | helpers wrapped in `(SELECT …)`; `tenant_id` leads every index; repositories add `tenant_id = $1` explicitly |
| REQ-SEC-026/027 | composite `(tenant_id, x_id)` FKs to every parent incl. cross-schema (05-SCHEMA §8); `tenant_id NOT NULL` without default |
| REQ-SEC-028 | UUIDv7 ids only; no sequential numbers anywhere in C9 |
| REQ-SEC-031 | `quality.v_pub_qc_summary` is `security_invoker = true`; C9 reads only invoker `v_pub_*` views of `lab`/`instruments` |
| REQ-SEC-039/131 | runs as `lims_api`/`lims_worker` (members of `lims_app`), no BYPASSRLS; no Supabase service keys |
| REQ-SEC-040/041/042/044 | cross-tenant + cross-centre probes for every operation (#1–#54) and table (§5); negative test per policy; mixed-tenant ids in list filters |
| REQ-SEC-045/133 | metrics for permission-denied spikes come from C0 (`lims_rls_denied_total`); C9 adds the invariant alert "allow with reasons" (02-TRD §14) |
| REQ-SEC-062 | `quality.autoverify.manage` is privileged → aal2 + membership re-validation for every operation that requires it (#37, #39, #40, #41, #43, #44, #45; IdentityPort) |
| REQ-SEC-080 | strict schema validation incl. the auto-verify DSL (`additionalProperties: false`, max lengths, ≤ 2,000 rules, ≤ 1 MiB definition) |
| REQ-SEC-081 | DTO allowlists (02-TRD §5.10); decision `inputs` only in the detail response |
| REQ-SEC-082 | parameterised SQL only; `q` prefix filters escape `%`/`_` |
| REQ-SEC-088/089 | free text (corrective-action description, notes, comments) rendered as React text nodes only; no rich text |
| REQ-SEC-091 | all state changes are POST/PUT/PATCH through the BFF with Origin checks (C0) |
| REQ-SEC-095 | problem+json bodies without SQL/stack; `detail` never echoes values |
| REQ-SEC-096/097 | C0 audit triggers on all C9 tables; `access_log` actions `autoverify.activate`, `autoverify.retire`, `autoverify_decision.view` (#47), `autoverify_simulation.view` (#42), all registered in 03-IC §13.1 / 08 §4.4 (08 A13 P-3, 08 A17 D-53); A tables append-only |
| REQ-SEC-098 | no PHI in URLs (route params are UUIDs/dates only), logs or metrics; `instruments.result.received.v1` payload (barcode, values) is never stored or logged by C9 |
| REQ-SEC-099 | every operation in `quality.yaml` has `x-permission`; none is public |
| REQ-SEC-100 | business-flow abuse: bulk-like reads bounded by the API (LJ ≤ 400 days / 2,000 points, decisions ≤ 31 days, observations #26 and runs #28 ≤ 92 days → `400 common.validation_failed`) |
| REQ-SEC-129 | no new dependencies (02-TRD §2) |
| REQ-SEC-136 | synthetic seeds only (05-SCHEMA §9) |
| REQ-SEC-139 | retention per tenant `retentionYears` (B15 default 5 y) for decisions/verification log; no class-A purge in v1 (needs a P-18(c) DEFINER, requested from the lead); `tat_items` purged by C9's own `per_tenant` task (05-SCHEMA §7) |
| 04 D11 | audit trigger old/new on every C9 table |

## 2. Assets

| Asset | Why it matters | Class |
|---|---|---|
| QC set-up (targets, plans, maps) | wrong targets/rules silently accept bad runs → wrong patient results released | integrity-critical, P0 |
| QC run outcomes + corrective-action log | accreditation evidence; drives C5 holds | integrity-critical, P0 |
| `quality.qc_run.rejected.v1` | its absence means patient results are not held | availability/integrity-critical |
| Auto-verify rule sets | a permissive rule bypasses technologist review | integrity-critical |
| Auto-verify decisions | audit of automated clinical decisions; contain pseudonymous result values | P3 confidentiality + integrity |
| TAT items/alerts | pseudonymous order/test linkage | P3 |

## 3. Threat model (STRIDE per entry point)

| Entry point / asset | S | T | R | I | D | E |
|---|---|---|---|---|---|---|
| `/v1/quality` set-up endpoints | stolen session → BFF idle/absolute timeouts (04 A8) | target changed to widen limits → values immutable after insert, activation audited, supersede-only | who changed a target → audit trigger + `activated_by` | tenant B reads A's set-up → RLS + probes | huge lists → cursor pagination, limits | technologist edits targets → `quality.qc.manage` lab_manager only |
| Observation exclusion (#27) | — | excluding the failing point to turn a rejection into acceptance → only before evaluation (run `collecting`), never after (`qc_run_already_evaluated`; DB trigger `quality.enforce_observation_exclusion`); reason code mandatory | exclusion actor/time/reason stored and audited | — | — | `quality.qc.manage` only |
| Run review (#30–#33) | — | closing a rejected run without fixing → requires corrective action (service + DB trigger) + a later accepted run with `run_at > R.run_at + run_window_minutes`, so the rest of the same QC event cannot count as the rerun (08 A17 D-52) | corrective actions append-only | — | — | `quality.qc_run.review` |
| Auto-verify editor/activation (#37–#45) | — | permissive rule activated by one person → four-eyes (`self_activation_forbidden`), simulation minimums, aal2, confirmation text; critical/delta/no-instrument exclusions hard-coded | access_log on activate/retire | DSL echoing PHI → DSL holds ids, limits, flag strings only | 1 MiB / 2,000 rules caps | holder of `quality.autoverify.read` cannot write; technologists hold no manage permission by default |
| `QualityPort` (in C5's tx) | — | decision rows forged by other modules → only the port impl writes `autoverify_decisions`; DB check `allow ⇒ no reasons` | decision row per evaluation | another tenant's plan used → RLS by caller claims + contract case 12 | slow port stalls C5 ingest → ≤ 10 ms budget, cached compiled rules | `allow` while tenant disabled → invariant test, live evaluation skipped when disabled |
| Event consumers | forged event → events only via C0 outbox, envelope validated | replay → inbox dedupe | event_log 90 d | `instruments.result.received.v1` PHI → handler reads only ids/codes/timestamps; never logged | event storm → job_key debounce, batch limits | system actor holds only module permissions |
| Sync from `lab.v_pub_qc_result` | — | — | source row id kept (`source_qc_result_id`) | invoker view under system claims stays tenant-bound | sync lag → overlap + alert | — |
| `quality.qc_run.rejected.v1` publish | — | — | payload stored in event_log | P0 only | C5 consumer down → retries + dead letter alert (C1) | — |
| TAT endpoints | — | acknowledging to hide alerts → ack is append-only, a higher level re-raises | ack actor/time | centre-scoped RLS | sweep cost bounded (02-TRD §13) | `quality.tat_alert.ack` only |

## 4. Abuse cases

| # | Abuse | Control | Test |
|---|---|---|---|
| AB-01 | Lab manager widens SD to make every run pass | SD change only via new target (audited, activation recorded); targets list shows CV % and history; supersede never edits | S-09 |
| AB-02 | Technologist excludes the out-of-range control after the run was rejected | exclusion blocked once evaluated | S-10 |
| AB-03 | Pathologist writes and activates a permissive rule alone | four-eyes + aal2 + simulation minimums | S-12, S-13 |
| AB-04 | Rule tries to auto-verify critical values | `allowed_range_flags` cannot contain LL/HH/A; `isCritical` hard-coded deny | S-14 |
| AB-05 | Attacker posts `tenant_id`/`status`/`outcome` in a body | spec rejects unknown fields (`additionalProperties: false`) | S-03 |
| AB-06 | Tenant A user probes tenant B QC run ids | 404 `common.not_found` identical to missing | S-01 |
| AB-07 | Centre-restricted user lists TAT alerts of other centres | `__tenant_centre` RLS | S-02 |
| AB-08 | Massive LJ / decision queries to load the DB | span and point caps; general rate tier | S-16 |
| AB-09 | Free-text fields used to paste patient details | UI hint "Do not enter patient details"; logger never logs these fields; P0 policy documented in the manual | S-17 (log scan) |
| AB-10 | Closing a rejected run immediately to clear `out_of_control` | needs corrective action + later accepted run | S-11 |
| AB-11 | Instrument id of another tenant in a control map | composite FK `(tenant_id, instrument_id)` fails → 400 `common.validation_failed` | S-04 |

## 5. Required security tests

| ID | Test |
|---|---|
| S-01 | **Cross-tenant probe for every operation #1–#54** (generator over `quality.yaml` + hand-written for list filters and body ids): tenant A credentials with tenant B ids → `404 common.not_found`, no B data, no side effect in B (DB check as owner) |
| S-02 | Cross-centre probe: `listTatAlerts`, `getTatAlert`, `acknowledgeTatAlert` with a user scoped to centre A1 against A2 items → 404 / zero rows |
| S-03 | Mass-assignment: bodies with `tenant_id`, `created_by`, `status`, `outcome`, `version` → `400 common.validation_failed` (`common.unknown_field`) |
| S-04 | FK probes: control map / plan referencing tenant B's instrument, analyte or lot → rejected; tat/decision rows cannot reference B's orders/results (SQL probe) |
| S-05 | **Table probes for every owned table** (all 24 tenant tables in 05-SCHEMA §1, i.e. every table except the two `g_cs_*`, incl. `event_inbox`): with tenant A claims `SELECT` sees zero B rows; `INSERT … tenant_id = B` fails; `UPDATE`/`DELETE` of B rows affect 0 rows; centre variant for the three TAT tables. Sub-case (08 A17 P-16): partner, portal and patient claims of tenant A read 0 rows and cannot insert into any C9 table |
| S-06 | Grants: `has_table_privilege('lims_app', t, 'DELETE') = false` for every C9 table except `quality.tat_items`; `UPDATE` false for A tables and `qc_plan_versions` |
| S-07 | Privilege escalation: each role from 03-IC §11 calls every write endpoint; only the roles of 02-TRD §5.0 succeed |
| S-08 | aal1 session on every `quality.autoverify.manage` operation (#37, #39, #40, #41, #43, #44, #45) → `403 auth.mfa_required`; revoked membership after token issue → privileged call fails |
| S-09 | Immutability: UPDATE of `qc_targets.mean/sd`, `qc_runs.outcome/rules_violated`, `qc_runs.status` of a `closed` run, `evaluated → closed` without a corrective-action row, non-draft `autoverify_versions.definition`, any status change of a `stopped`/`retired`/`discarded` version, `qc_observations.status → excluded` on an evaluated run, any `qc_plan_versions` row, any A-table row → `409 common.immutable_record` / permission denied |
| S-10 | Exclusion after evaluation → `409 quality.qc_run_already_evaluated` |
| S-11 | Close without corrective action / without accepted rerun → 409 codes |
| S-12 | Self-activation → `403 quality.self_activation_forbidden`; DB check `activated_by <> created_by` |
| S-13 | Activation before minimums → `409 quality.simulation_incomplete` |
| S-14 | DSL rejects `LL`, `HH`, `A` in `allowed_range_flags`; property test: no `allow` with any reason; `allow` never when tenant disabled; DB CHECK rejects an `allow` row with reasons |
| S-15 | Event consumers: duplicate `event_id` no-op; unknown extra fields ignored; `instruments.result.received.v1` handler stores no barcode/value (column inspection + log capture) |
| S-16 | Range caps: LJ > 400 days, decisions > 31 days, observations (#26) and runs (#28) > 92 days → 400; limit > 200 → 400 |
| S-17 | Log scan with planted PHI in `instruments.result.received.v1` fixtures and in decision inputs: logs contain none of the 02-CV §9.2 fields |
| S-18 | No SECURITY DEFINER in C9 migrations (inventory equality, C0) |
| S-19 | BFF routes require session; every page returns the permission-denied state without the permission (no data in the HTML) |
| S-20 | `quality.v_pub_qc_summary` under tenant A claims shows only A rows |
| S-21 | Purge probe: `DELETE FROM quality.tat_items` under user claims affects 0 rows; under system claims it deletes only rows with `expires_at < now()`; `quality.purge_tat_items` keeps rows that have `tat_alert_events`/`tat_alert_acks` |
| S-22 | Access-log registry: every `action:` string literal in `services/**/quality/**` is one of the four codes in 02-TRD §5.6 and exists in `audit.g_cs_access_actions` (08 A13 P-3) |

## 6. PHI handling and logging rules

- C9 stores no patient name, phone, barcode, registration number or report content.
- P3 data (pseudonymous ids with result values/order linkage) lives only in `autoverify_decisions`, `verification_log`, `tat_items`, `tat_alert_events`, `tat_alert_acks`; it is returned only to holders of `quality.autoverify.read` / `quality.tat_alert.read`.
- Logged: ids (UUIDs), codes (rule codes, reasons, statuses), counts, durations. Never logged: result values, decision `inputs`, free-text fields (descriptions, notes, comments), raw control ids (P0 but free-form; logged only as SHA-256 prefix when needed for debugging [CONV]).
- `instruments.result.received.v1` (P3+P2): the consumer reads `instrument_id`, `analyte_id`, `mapping_status`, `received_at` only; the envelope is not copied anywhere.
- Metrics labels: `tenant_id`, status/outcome/rule/reason codes only; never instrument raw codes or result ids.

## 7. Secrets

None owned by C9. C9 uses the platform DB credentials of `lims_api`/`lims_worker` and the session/JWT handling of C0/C2. No outbound network calls (no foreign touchpoint; 04 §11 unchanged).

## 8. Security checklist for the chunk gate

- [ ] S-01…S-22 present and green
- [ ] DTO allowlists reviewed (02-TRD §5.10)
- [ ] Privileged operations listed in `permissions.yaml` with `privileged: true`
- [ ] No new dependency, no SECURITY DEFINER, no foreign touchpoint
- [ ] Invariant alert "allow with reasons" registered with C1
