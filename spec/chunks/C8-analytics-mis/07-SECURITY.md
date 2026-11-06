# C8 Analytics & MIS — 07 Security

Status: DECISION, 2026-11-06. REQ-SEC IDs are cited from `research/02-security.md`, not copied. Phase 1 applicability per 04 §12 (§1, §3, §4, §6, §7 apply; §2 gateways and §5 mobile do not touch C8).

## 1. Applicable requirements

| REQ | How it applies in C8 |
|---|---|
| REQ-SEC-001/002 | ASVS L2 target; BOLA is the primary threat — every report is an aggregate over tenant + centre scope |
| REQ-SEC-004 | column classification in 05-SCHEMA §8; `export_files` = P2 |
| REQ-SEC-011/012/014/015/016 | ENABLE + FORCE RLS on every `analytics` table, per-command policies `TO lims_app`, no `USING (true)`, default deny for UPDATE on class R; every `__tenant` policy carries `(SELECT app.is_staff_or_system())` in its predicate (`pred_t`, 08 A17 P-16); centre predicate cast `::uuid[]` (08 A16.1) |
| REQ-SEC-013 | tenant only from verified claims; no tenant/centre param is trusted — `centre_id` filters are intersected with the IdentityPort scope |
| REQ-SEC-017 | centre scoping on every rollup row (nullable-centre predicate) and in exports/report runs by explicit scope |
| REQ-SEC-019–021 | no SECURITY DEFINER in C8; guard triggers are INVOKER with `search_path = ''` |
| REQ-SEC-022/023/024 | helpers wrapped in `(SELECT …)`; `tenant_id` leading every key; repositories add explicit tenant + scope predicates |
| REQ-SEC-026 | composite FKs on C8 config tables to `core.memberships` |
| REQ-SEC-031 | C8 reads only `security_invoker` views; live pending/agents reads run in the **user** transaction so owners' RLS applies |
| REQ-SEC-040/041/042/044 | probe suite §5; mixed-id filters; two synthetic tenants |
| REQ-SEC-045/133 | export/download spike alerts; RLS-denied spikes (core metric) |
| REQ-SEC-062/067 | `analytics.data.export` and `analytics.referral_report.read` privileged → aal2 + membership re-validation (C2) |
| REQ-SEC-080/081 | strict spec validation; explicit DTO allowlists; no row serialisation |
| REQ-SEC-088/089 | React text nodes only; doctor/centre names (user-entered) never via `dangerouslySetInnerHTML` |
| REQ-SEC-095 | generic problem+json; reconciliation details only in logs |
| REQ-SEC-096/097 | access_log: export request/download (`data.export`), referral view (`referral_report.view`, CR-C8-006); schedule changes via audit trigger |
| REQ-SEC-098 | no PHI in URLs: query params are ids/codes/dates; referrer search by POST body; report-run link carries only a UUID |
| REQ-SEC-099 | 30 operations inventoried in `analytics.yaml` (#30 `getCollectionsFilterOptions`, 08 A17 D-46); none public |
| REQ-SEC-100 | bulk extraction (export) requires elevated role + quota |
| REQ-SEC-131 | `lims_analytics` reserved role gets no grant on `analytics.*`; BI access stays KEEP-LATER |
| REQ-SEC-136 | synthetic data only; non-prod NotificationPort has no real provider credentials |
| REQ-SEC-007 / 04 R5, S20 | scheduled emails link-only through C6 relay; no figures, no names |
| 04 L19 / B13 | referral report reporting-only, flag-gated, word "commission" banned |

## 2. Assets and entry points

| Asset | Sensitivity | Entry points |
|---|---|---|
| Income/collection aggregates | business-confidential | report GETs, exports, report runs |
| Doctor (referrer) business volumes | P2 personal + commercially/ethically sensitive (04 L19) | top referrers, referral report, exports |
| Staff collection amounts | P2 (staff) + financial | collections report, exports |
| Pending list (ids, tests, ages) | P1/P3-adjacent (test linked to order id) | pending items list, exports |
| Export files | P2, portable outside the system | download endpoint |
| Schedules/recipients | P1 | schedule CRUD, dispatcher |
| Rollup integrity | integrity of owner decisions | worker refresh (system), events |

## 3. STRIDE

| Asset / entry | Threat | Mitigation | Test |
|---|---|---|---|
| Report GETs | **S**poofing another tenant via headers/params | tenant from verified JWT only (CV §6) | probe P1 |
| Report GETs | **I**nfo disclosure across centres via `centre_id` param | intersect with scope; foreign centre → 404 | probe P3 |
| Rollups with NULL centre | **I** to centre-restricted users | predicate requires `centre_id IS NOT NULL` for scoped users | SQL probe P6 |
| Rows without a centre (credit-party invoices/payments, non-report deliveries) | **I** of tenant-wide figures to centre-restricted users | `centre_id IS NOT NULL` required for scoped readers; results, critical values and deliveries are centre-scoped (CR-C8-004/005); no Phase-1 family is tenant-wide-only | P4 |
| Partner / portal / patient actors of the same tenant | **I** via a misrouted token reaching analytics tables | `pred_t` staff-actor guard on every `__tenant` policy (P-16); centre helpers are false/empty for those actors (08 R3) | P12 |
| Per-referrer billing (top referrers card, export, schedule) | **I** + compliance (B13: flag must hide the report entirely) | top referrers is volume only; `net_billed_paisa` only in the flag-gated, aal2, access-logged referral report (08 A17 D-44) | P13 |
| Small-cell inference (e.g. one patient at a centre in a day) | **I** — aggregates are not anonymous; a user scoped to a centre already sees that centre's patients via C4/C5 | accept: C8 never exposes data a user's scope could not already read; no cross-centre rank exposure (US-06.2) | P3 |
| Rollup writes | **T**ampering by a user path | INSERT/DELETE policies require `actor_type = 'system'`; no UPDATE grant | SQL probe P7 |
| Event-driven dirtying | **T** via forged events | events only from core outbox (producer tx); consumers never take values from payloads | consumer tests |
| Exports | **I**/exfiltration by insider | privileged + aal2, quota 10/h/user 50/day/tenant, own-only, 3 downloads/24 h, access log, spike alert, acknowledgement checkbox, header "Exported by …" | §5 E-tests |
| Export build in worker (tenant-wide RLS) | **E**levation: snapshot scope ignored | mandatory `Scope` arg in repositories; build-time intersection with current membership; unit test fails if any repository read lacks scope | P8, unit |
| Export files | **I** via another user's export id | RLS own-only + 404 | P9 |
| Export content | **T**/code execution in spreadsheet (formula injection from doctor names) | shared `neutraliseFormula` from `@lims/shared-ts/spreadsheet` (prefixes `'` on `= + - @ TAB CR '`; 08 A13 P-9) in every writer | C0-0A golden corpus + C8 writer integration test (E5) |
| Download | **R**epudiation | access_log per download with sha256 prefix | audit test |
| Referral report | **I** + compliance | flag (default off) → `common.feature_disabled`; aal2; access log | E7–E9 |
| Schedules | **I** by sending to ineligible/foreign recipients | recipients must be same-tenant memberships (composite FK) with permission at create and at dispatch | S-tests |
| Report-run link | **I** if forwarded | login required; recipient/owner only; figures computed with viewer scope ∩ schedule scope | S4 |
| Email body | **I** to foreign relay (04 §11) | params `lab_name`, `schedule_name` only; name CHECK blocks emails/phones; name CHECK also blocks `://` / `www.` (08 A5.4); C6 validates `schedule_name` as `label_text` (≤ 80, plain text, no URLs, HTML-escaped; 08 A4.3) and resolves the staff e-mail through `IdentityPort.getStaffNotificationContact` using the recipient's `requiredPermission` (08 A4.2); link-only, no PHI | NotificationPort fake assertions |
| Manual refresh | **D**oS on DB | 1 per 5 min per tenant; sweeps bounded; statement timeout | throttle test |
| Large ranges | **D** | 366-day cap; export row/byte caps | contract tests |
| Live pending query | **D** | C5 partial index; 5 s timeout → 503 | timeout test |

## 4. Abuse cases

1. A front-desk user with a crafted URL requests `/v1/analytics/reports/income?centre_id=<other centre>` → 404 (no oracle).
2. A centre staff member enumerates `export_id`s → 404 for every id not their own.
3. A lab manager without the referral permission requests the referral report or schedules it → 403 / omitted at dispatch.
4. An owner exports referral data repeatedly to take it to a competitor → quota 429 after 10/h, downloads capped, spike alert pages the security owner, all events in access_log.
5. A user whose access was revoked downloads a ready export → privileged re-validation fails → 403.
6. A doctor name `=HYPERLINK("http://x","click")` (quick-added at front desk) appears in an export → cell written as text with leading `'`.
7. Someone sets a schedule name containing a patient's phone to leak it via email → CHECK and service validation reject it.
8. A support-session platform user (C2) opens analytics → actions recorded with `support_session_id` in access logs (core); no special path in C8.

## 5. Required tests (all in `services/api/src/modules/analytics/__tests__/probes/` and `db/tests` via C0)

| ID | Test |
|---|---|
| P1 | For **all 30 operations**: tenant A credentials with tenant B ids (path ids, `centre_id`/`branch_id`/`department_id` params, export/schedule/run ids, recipient ids in bodies, mixed A+B arrays) → `404 common.not_found` (or per-field) and no B data in the body; generator-driven from `analytics.yaml` |
| P2 | Lists (`listAnalyticsExports`, `listReportSchedules`, `listPendingTests`) with B data present → zero B rows |
| P3 | Centre A1-only user vs A2 data: every report's totals equal A1-only expected; `centre_id=A2` → 404; dashboard; exports; report runs |
| P4 | Centre-restricted user: results, critical-value and delivery sections show only A1 rows; NULL-centre rows (credit-party income/collections, non-report deliveries) are absent; `tenant_wide_sections_hidden` is empty (no Phase-1 tenant-wide family) |
| P5 | Branch filter does not widen scope (branch containing A2 → only A1 rows) |
| P6 | SQL probes per owned table (as `lims_api` with tenant A claims): SELECT sees zero B rows; NULL-centre rows invisible to scoped claims; INSERT with tenant B fails |
| P7 | SQL: user-claims INSERT/DELETE on every class R table, `order_index`, `export_files`, `refresh_runs`, `report_runs`, `report_run_recipients` → denied; user INSERT on `refresh_state` with `family <> '_manual'` → denied; UPDATE on R tables → no privilege; `has_table_privilege('lims_app', t, 'DELETE') = false` for `analytics.schedules`, `analytics.schedule_recipients`, `analytics.refresh_state`; system DELETE of an E row whose `expires_at` is in the future → 0 rows (P-18(c)) |
| P8 | Export built for a scoped requester contains only scoped rows; requester narrowed between request and build → intersection; requester deactivated → failed `auth.forbidden` |
| P9 | Another user's export/file → 404 (API) and SQL SELECT zero rows |
| P10 | Report run: non-recipient same-tenant user → 404; recipient → 200; schedule owner → 200 with recipient list |
| P11 | FK probe: create schedule with tenant B membership as recipient → 404 (composite FK `23503` mapped) |
| P12 | Partner, portal and patient claims of tenant A read 0 rows from every `analytics` table (08 A17 P-16 generated probe) |
| P13 | With the referral flag off: no endpoint (#1–#30), export (`top_referrers`, `dashboard`), schedule run or dashboard card returns a `net_billed_paisa` field; `getTopReferrersReport` rejects `sort=-net_billed_paisa` with `400 common.validation_failed` (08 A17 D-44) |
| E1 | `createAnalyticsExport` at aal1 → `403 auth.mfa_required`; without `analytics.data.export` → 403 |
| E2 | Quota: 11th export in an hour → 429 with Retry-After; parallel 10th/11th → exactly one accepted |
| E3 | 4th download → 410; parallel downloads at limit → one succeeds |
| E4 | Every export request and download writes one access_log row with ids/counts only (log PHI-scan passes) |
| E5 | Formula-injection: a doctor name `=HYPERLINK("http://x","click")` and the C0-0A corpus written through C8's XLSX/CSV writers and PDF data builder come out prefixed with `'` (shared `neutraliseFormula`) |
| E6 | Export header contains "Internal MIS — not a statutory register" and requester display name |
| E7 | Referral flag off → `common.feature_disabled` for GET, export, schedule-only pack |
| E8 | Referral view writes access_log `referral_report.view` |
| E9 | CI grep: no `/commission/i` in C8 paths; `g_cs_report_codes` CHECK |
| S1 | Schedule recipient without `analytics.dashboard.read` → `422 analytics.recipient_ineligible` at create; skipped at dispatch if revoked later |
| S2 | NotificationPort fake receives only `lab_name`, `schedule_name` params, template `analytics.report_ready`, purpose `scheduled_report_ready`, recipient `{kind:'staff', membershipId, requiredPermission: 'analytics.dashboard.read'}` (no e-mail address from C8; 08 A4.2/A5.4) and a link matching `/analytics/report-runs/<uuid>` |
| S3 | Schedule name with `@`, 7+ digits, `://` or `www.` (any case), or > 80 characters → `400 common.validation_failed` (08 A13 P-1); direct INSERT violating `schedules__name__ck` → `23514` (08 A5.4) |
| S4 | Dispatcher twice for one slot → one run, one send per recipient |
| X1 | Privilege escalation: user without `analytics.collections.read` cannot obtain collections via dashboard (tile omitted), export (403), schedule (omitted), `staff.analytics.collections` page (403) or #30 (403); a `finance` user (collections only) gets 403 on #16 and every non-collections report |
| X2 | Unknown query param / extra body field → 400 (REQ-SEC-080) |
| X3 | Response mappers: snapshot tests of DTO key sets (no extra fields) |

## 6. PHI and logging rules

- C8 never reads, stores, logs or returns patient names, phones, registration numbers, barcodes, result values or patient ids. The only person-linked identifiers are order/specimen UUIDs (P1) in `order_index`, `tat_facts` and the pending list.
- Logs may contain tenant/centre/family/report codes, dates, counts, export ids and aggregate `diff_paisa` in reconciliation logs; never doctor/staff names, schedule names, export content or link URLs (report-run URLs contain only a UUID but are still not logged by C8).
- Error `detail` text never contains names or amounts.
- Metrics carry `tenant_id` only on low-cardinality business metrics (CV §9.4); never referrer or membership ids.

## 7. Decisions recorded

| ID | Decision |
|---|---|
| D-C8-01 | No patient-level identifiers in any C8 output |
| D-C8-04 | Consumers do not apply `aggregate.seq` checks (dirty marking is order-insensitive) |
| D-C8-07 | Formula-injection neutralisation for all text cells in exports, using the shared `@lims/shared-ts/spreadsheet` `neutraliseFormula` (08 A13 P-9; no module copy) |
| D-C8-08 | Exports list pending tests by collection centre; the screen also shows items received at your centres (C5 RLS in the user transaction; 08 A17 D-49). The view lacks a processing-centre column, so the system-actor export cannot apply C5's processing-centre branch |
| D-C8-09 | Export files in Postgres `bytea`, 24 h, not Storage (04 D3 UNVERIFIED) |

## 8. Secrets used

None owned by C8. It uses the core DB login roles (`lims_api`, `lims_worker`) through the core pools, and no Supabase service key (04 D5; CV §10.2 default "not used"). Email provider credentials stay in C6.
