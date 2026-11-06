# C14 Smart Report — 07 Security

Status: DECISION, 2026-11-06. REQ-SEC IDs from `research/02-security.md` are cited, not copied. Phase applicability per 04 §12 (C14 ships in Phase 2–3; LLM layer Phase 3).

## 1. Applicable requirements

| REQ-SEC | How it applies to C14 | Where implemented / tested |
|---|---|---|
| 001, 002 | ASVS L2 target; broken access control / BOLA is the primary threat for summaries and library objects | handlers load-then-authorise (02-TRD §5); probes (§5) |
| 004 | data inventory: every column classified P0–P3 | 05-SCHEMA §2 |
| 005, 006 | summary is shown only to audiences that may see the report: C6 prints it inside the report (C6 enforces consent/release), C16 shows the C6 report-version snapshot to the patient's own session (08 A2.3; C16 never calls the port); no third-party channel of its own | 08 A2.3 (staff/system-only port, 02-TRD §7.1 step 6); C6 report-version snapshot (08 A4.4); no delivery code in C14 |
| 007 | all processing in Nepal; the LLM endpoint must be a Nepal-hosted internal host (host allowlist); a foreign API is not built (04 §11, B11) | config `LIMS_SMARTREPORT_LLM_ALLOWED_HOSTS`; startup refusal test (AC-20.5) |
| 010 | threat model per feature (this document); security review gate | 05-DoD §4 |
| 011–016 | ENABLE + FORCE RLS on every tenant table, per-command policies to `lims_app`, no `USING (true)`, no DELETE policy or grant on any table (class M rows are deactivated — 08 A17 P-18(a)); every policy carries `is_staff_or_system()` and `current_actor_type() IN ('user','system')` (08 A19 D-109) | 05-SCHEMA §6, §9 |
| 017 | centre scoping on summary tables (front desk / centre staff are centre-scoped) | `__tenant_centre` policies with `centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])` (08 A16.1); centre probes |
| 019–021 | trigger functions are SECURITY INVOKER with `search_path = ''`; no DEFINER added | 05-SCHEMA §4 |
| 022–024 | `(SELECT app.…())` wrappers; `tenant_id` leading in every index; explicit tenant filter in repositories | 05-SCHEMA §5, §9; repo code review |
| 025 | load test with 10× seed across two tenants includes queue and build queries | T25 |
| 026, 027 | composite FKs to catalog, frontdesk, core; `tenant_id NOT NULL`, no default | 05-SCHEMA §9 |
| 028 | UUIDv7 ids from app code; no sequential ids in URLs | 02-CV §4.10 |
| 031 | no views defined; none needed | 05-SCHEMA §8 |
| 040–042, 044 | cross-tenant + cross-centre probes for all 35 operations and every table; ID swapping (path vs body), mixed-tenant ids in `analyte_id`/`suggested_test_id`/`order_id` | §5 |
| 045 | anomaly signals: summary detail views per user (access log) available to C2's viewer; spikes alert via C1 | `ctx.audit.access` (AC-21.2) |
| 062, 067 | `smartreport.template.approve` and `smartreport.summary.approve` are privileged → aal2 + membership re-validation | IdentityPort.assertRole; AC-07.2 |
| 080 | strict schema validation, `additionalProperties: false`, max lengths on every text | 02-TRD §5.1 |
| 081 | per-role field allowlist: `review_inputs` and `llm_text` only for `summary.approve` holders; port output only to staff/system callers (C6 system actor); non-staff readers get the C6 snapshot (08 A2.3) | `mappers/summary.dto.ts`; tests |
| 082 | parameterised SQL only | lint (02-CV §1.3) |
| 086 | renderer fragment contains no URLs, images or scripts; all text escaped | 04-UI-UX §4.1; T22 |
| 088, 089 | staff web renders block text as text nodes only; no `dangerouslySetInnerHTML`; CSP from the shell | web lint + XSS corpus in component tests |
| 091, 092 | state changes via POST/PUT/PATCH/DELETE through the BFF with Origin checks | C0 BFF core |
| 095 | generic problem+json; validation details contain issue codes, never SQL or stack | 02-TRD §9.4 |
| 096, 097 | audit trigger on M/C tables; append-only review tables; access-log entries for summary views and previews | 05-SCHEMA §4, §9; AC-21.* |
| 098 | no PHI in URLs (only UUIDs), logs, metrics or traces; smart-report text is on the PHI list (02-CV §9.2) | log-scan test (AC-21.3) |
| 099 | every route in `smartreport.yaml` with owner and permission; no public route | spec lint |
| 101 | LLM server responses treated as untrusted input: TLS verification, timeout, circuit breaker, validator, never executed or rendered as HTML | 02-TRD §4.11–4.12, §9.1 |
| 128 | LLM credential (if any) only in the secret store; never in repo or logs | config §10 of 02-TRD |
| 131 | `lims_app` grants only; no BYPASSRLS role | 05-SCHEMA §6 |
| 133 | alerts: LLM call while disabled (critical), build error rate, stale drafts | 02-TRD §12 |
| 136 | synthetic fixtures only (starter library, preview fixtures, golden vectors) | `packages/test-fixtures`; review |
| 139 | retention follows tenant clinical retention; no deletion path | 05-SCHEMA §7 |
| 141 | if the founder ever approves a foreign LLM, it must be added to the vendor register before the flag can be set (C2 requires `approval_ref`) | C2 flag registry; manual checklist |

Not applicable: payments (046–059), mobile (102–113: C16 owns its app), bridge agent (114–123), infra (124–132 except 128/131: C1).

## 2. Assets and data classification

| Asset | Class | Notes |
|---|---|---|
| `summaries.content`, `llm_overlay`, `llm_runs.items`, `reject_comment`, score/band/counts | P3 | health data linked to an order/patient |
| `summaries` ids, hashes, bindings | P1 | pseudonymous |
| Library texts, rules, mappings, parameters | P0 | clinical content but no patient data; **integrity-critical** (they become patient-facing statements) |
| Registration number / patient display name in queue DTOs | P2 | read at request time from FrontdeskPort; never stored by C14 |
| `SmartSummaryView.reviews[]` (08 A22.1) | P1 (staff display names, action and reason codes, times) | staff readers only (no non-staff path, 08 A2.3); the P3 `comment` is not exposed in it; actor names via `ctx.core.memberships.list` (08 A17 P-17) |
| LLM credential (if any) | secret | secret store |

## 3. Threat model (STRIDE per entry point / asset)

| # | Entry point / asset | S | T | R | I | D | E |
|---|---|---|---|---|---|---|---|
| T1 | Library authoring endpoints (#1–#25) | session hijack → BFF HttpOnly cookies (REQ-SEC-068, C0/C2) | unapproved or malicious text reaching patients → draft-only edits, content hash at submit, approval by privileged pathologist at aal2, DB triggers | who wrote/approved what → `library_reviews` + audit trigger | cross-tenant read of another lab's library → RLS + probes | 500 blocks / 1,000 rules caps (V11); general rate tier | `lab_manager` approving → `template.approve` only for pathologist; privileged check re-reads membership |
| T2 | Summary review (#27–#32) | — | approving a stale summary → hash re-check under advisory lock | approver identity, attestation stored | centre-scoped staff viewing other centres' summaries → `__tenant_centre` RLS + `assertRole(centreId)`; `review_inputs` allowlist | queue pagination max 200 | front desk approving → `summary.approve` privileged, pathologist only |
| T3 | `SmartReportPort.buildSummary` | caller passing another tenant's orderId → `ctx.tenantId` only; RLS → `not_found` | patient/portal/partner actors → not port callers; no non-staff RLS on `smartreport.*` (08 A2.3) | binding rows record which report version requested it | draft text leaking to patients → non-staff actors make zero port calls (08 A2.3); C6 prints and snapshots approved only; renderer returns `''` for drafts | heavy builds → caching; advisory lock bounds concurrency per order | — |
| T4 | Event consumers | forged events → only C0 outbox/fan-out can enqueue `evt.*` tasks | stale event resurrecting an old summary → consumers only supersede, never un-supersede | inbox | — | event floods → idempotent, O(1) per event | system actor permissions limited to `lab.result.read`, `frontdesk.order.read` |
| T5 | Renderer fragment | — | HTML/script injection via block text → text nodes only; element/attribute allowlist; C6 sanitiser again | — | — | very large summaries → caps on advice/follow-ups/trends | — |
| T6 | LLM layer (Phase 3) | rogue endpoint → host allowlist, TLS verify | model adds claims/numbers/products → validator L1–L8, pathologist diff review, default `use_llm_text = false` | `llm_runs` with input hash, model ref, prompt version | PHI to model → only template text with unfilled placeholders; self-hosted in Nepal; foreign API not built | slow model → timeout, circuit breaker, concurrency 1 | prompt injection inside block text (authored by staff) → output still validated; failing items keep template text |
| T7 | Deny-term list | — | tenant removing global rules → global terms are separate, read-only | — | — | — | — |

## 4. Abuse cases (each has a test)

| ID | Abuse | Expected control |
|---|---|---|
| AB-1 | A `lab_manager` edits a block of the active library directly through the API | `409 smartreport.library_invalid_transition`; direct SQL UPDATE as `lims_app` → `immutable_row` |
| AB-2 | An author hides a product name with zero-width characters ("supp​lement") or different case | deny-term normaliser catches it (AC-18.3) |
| AB-3 | A follow-up rule suggests a paid test for every patient (`all_in_range` trigger, or `any`/`borderline` on everything) | `all_in_range` follow-ups rejected (DB CHECK); `any` rules need `min_severity`; rules visible in SR-05; approval required; audit trail; follow-up cap |
| AB-4 | A block with digits hard-codes an interval ("repeat in 3 months") contradicting the rule data | V5 `digits_not_allowed` |
| AB-5 | Front-desk user of centre A1 opens a summary id of centre A2 | `404 common.not_found` |
| AB-6 | Tenant B user calls `getSmartSummary` with tenant A's id, or maps tenant A's analyte id | `404 common.not_found` / FK failure → `404` |
| AB-7 | Patient session (C16) tries to obtain a draft | no non-staff RLS on `smartreport.*` → zero rows; C16 reads only the approved snapshot C6 stored on the report version (08 A2.3) |
| AB-8 | Pathologist approves a summary after a result was amended (race) | `409 smartreport.summary_superseded` |
| AB-9 | Block text contains `<script>` or `<img src=…>` | stored as text; staff UI and fragment escape it (snapshot test) |
| AB-10 | Platform admin enables `smart_report_llm` without founder approval | C2 refuses (approval_ref required); C14 additionally refuses when the endpoint host is not allowlisted |
| AB-11 | LLM output adds "take iron tablets twice a day" | `deny_term` (tablet) + `novel_word` + `digit_added` (if numerals) → kept original |
| AB-12 | Replay of `buildSmartSummary` with the same Idempotency-Key and a different body | `422 common.idempotency_key_reused` |
| AB-13 | Preview used to read results of an order the author may not see | `lab.result.read` + centre check required; access-logged |

## 5. Required security tests

1. **Cross-tenant probes** for all 35 operations (C0 generator): tenant A credentials with tenant B ids in path (`library_version_id`, `block_id`, `rule_id`, `analyte_id`, `group_code` scoped to B's version, `term_id`, `summary_id`, `order_id`) and body (`source_version_id`, `analyte_id`, `suggested_test_id`, `block_id`, `order_id`) → `404 common.not_found`, no side effect in B (DB check as owner).
2. **Cross-centre probes** for #27–#34 (summary operations; #35 is tenant-wide): centre-A1 user vs A2 summaries → 404; list returns zero A2 rows.
3. **SQL RLS probes** for every tenant table (05-SCHEMA §10).
4. **Privilege escalation:** `lab_manager` and `front_desk` on #20, #21, #30–#34 → `403 auth.forbidden`; `front_desk` on #35 and `lab_manager` on #26 → `403 auth.forbidden` (one floor per operation, 08 A19 P-43); pathologist at aal1 → `403 auth.mfa_required`; revoked membership after token issue → privileged call fails (IdentityPort contract).
5. **Non-staff and device isolation tests (08 A2.3, 08 A19 D-109 / A19.1):** RLS probes with patient, portal, partner and device claims on every `smartreport.*` table → zero rows, every INSERT/UPDATE fails (the policies' `current_actor_type() IN ('user','system')` term excludes `device`, which `is_staff_or_system()` alone would admit); static check that every policy in `db/policies/smartreport.sql` contains both `is_staff_or_system()` and `current_actor_type()) IN ('user','system')` and none names a non-staff actor type; C16/C13 fakes record zero `SmartReportPort` calls.
6. **Immutability:** triggers and grants (05-SCHEMA §10 items 3–6).
7. **Wording:** deny-term, digit and link scans with an adversarial corpus (zero-width, mixed case, NFD input, Devanagari digits).
8. **Renderer:** XSS corpus in block texts → fragment contains no executable markup; passes C6 sanitiser unchanged.
9. **LLM (Phase 3):** disabled → zero outbound calls; captured request contains no filled placeholder values, no names, no registration numbers; validator corpus; non-allowlisted host → startup refusal.
10. **Logs:** log-scan test with planted synthetic PHI and block text (AC-21.3).
11. **Idempotency:** replay/mismatch for #2, #6, #10, #24, #30, #33.

## 6. PHI handling and logging rules

- C14 stores no names, phones, registration numbers or barcodes. Queue/detail DTOs read them at request time through FrontdeskPort (purpose-bound) and never persist them.
- Summary content is P3: never logged, never in metrics labels, never in error `detail`, never in job payloads (payloads carry `order_id` / `summary_id` only).
- LLM input contains approved template text only; values and names are filled **after** the model call, inside the API.
- Access logging: summary detail view (action `smart_summary.view`, entityType `smart_summary`), preview (action `smart_summary.view`, entityType `smart_summary_preview`) — action code per 08 §4.4; approvals and rejections via review rows + audit trigger.
- Exports: none in C14.

## 7. Secrets

| Secret | Used by | Storage |
|---|---|---|
| `LIMS_SMARTREPORT_LLM_CREDENTIAL` (only if the chosen server needs one; Phase 3) | worker task | secret store (C1), per environment; never in non-prod with real endpoints (REQ-SEC-136) |

No other secret. C14 uses no Supabase service key (04 D5).

## 8. Security sign-off checklist (05-DoD §4)

- [ ] Every REQ-SEC row in §1 has an implementation location and a test.
- [ ] No foreign touchpoint (LLM host allowlist contains Nepal-hosted internal hosts only).
- [ ] No BYPASSRLS role; no SECURITY DEFINER function added.
- [ ] Privileged permissions require aal2 (tests §5.4).
- [ ] Probes for every operation and table pass.
