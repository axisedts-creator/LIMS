# C8 Analytics & MIS — 02 Technical Requirements (TRD)

Status: DECISION, 2026-11-06. Inputs: 00, 04, 01-CHUNK-MAP (CM), 02-CONVENTIONS (CV), 03-INTERFACE-CATALOG (IC), C3/C4/C5/C2/C0 chunk documents (for the exact view SQL they specified). Metric definitions are in `01-PRD.md` §8 (M-ids, R-rules); this file says how to compute and serve them.

---

## 1. Owned paths (CM §3)

| Path | Content |
|---|---|
| `services/api/src/modules/analytics/**` | API module (handlers, services, domain, repository, mappers, tests) |
| `services/worker/src/jobs/analytics/**` | consumers, refresh/export/dispatch/purge/self-check tasks, cron |
| `apps/web/src/app/(staff)/analytics/**` | route segment (pages, `loading.tsx`, `error.tsx`) |
| `apps/web/src/features/analytics/**` | nav manifest, BFF server functions, components, hooks, forms, help, tests |
| `docs/manual/analytics/**` | user manual pages |
| `services/renderer/templates/analytics/**` | PDF templates for RenderPort key `analytics.report` (CR-C8-009 MERGED into CR-C4-004; path ownership per 01-CM §3 as amended by 08 R14/R12c) |

Specified here, implemented by C0: DDL/RLS of schema `analytics` (`05-SCHEMA.md`), `contracts/openapi/analytics.yaml` (§5), permission/route/error/access-action additions (§16). C8 never edits `db/`, `contracts/`, `packages/*`, `*/core/`.

## 2. Stack and libraries

| Concern | Choice | Source |
|---|---|---|
| Runtime | Node.js 26.x LTS (exact patch C0) | CV §1.1 |
| API | Fastify [PIN-C0] + `fastify-openapi-glue` 4.12.0 | 04 T7 |
| Worker | Graphile Worker 0.18.0 | 04 S10, T7 |
| DB | PostgreSQL 17 (`supabase/postgres:17.6.1.136`) | 04 D9 |
| Web | Next.js App Router [PIN-C0], server-only BFF; `@lims/ui` only | 04 S4; CV §14 |
| B.S. dates | `@lims/shared-ts/bsdate` (wraps `@remotemerge/nepali-date-converter` 1.2.7) | 04 D13; C0 TRD §3.2 |
| Money | `@lims/shared-ts/money` (integer paisa) | CV §4.9 |
| Logger, errors, uuidv7, routes | `@lims/shared-ts/*` | CV §2.1 |
| XLSX writer | `write-excel-file` **4.1.1** (import `write-excel-file/node`), MIT — the same exact version C3 verified on registry.npmjs.org 2026-11-05 (C3 02-TRD §2.2). C8 adds no different version; C0's dependency review should make it one repo-wide pin (CR-C8-014) | C3 02-TRD §2.2 (VERIFIED there); choice here = DECISION |
| CSV writer | in-module (`domain/csv.ts`, RFC 4180 quoting only, UTF-8 with BOM [CONV] so Excel shows Devanagari) — no dependency | DECISION |
| Spreadsheet injection guard | `neutraliseFormula` from `@lims/shared-ts/spreadsheet` (08 R12e, A13 P-9); no module-local copy | 08 A13 P-9 |
| PDF | C6 renderer via `RenderPort.renderPdf` (03-IC §4.16; CR-C4-004 primary, CR-C8-009 merged — 08 R12c): called only from the worker task as system actor; returns the PDF bytes to C8, which stores them as its export design states (§10.2 step 8); until C6 ships it `format=pdf` → `common.feature_disabled` | 04 S14 |
| Charts | `@lims/ui` `BarChart`, `TimeSeriesChart`, `StatTile` (in-house SVG, C0 04-UI-UX §2.5) | CV §14 |
| Test runner, E2E | C0 pins | CV §11.1 |

### 2.1 Dependencies table (CV §15.1)

| Name | Exact version | Licence | Purpose | Maintenance evidence | Alternatives |
|---|---|---|---|---|---|
| `write-excel-file` | 4.1.1 | MIT | XLSX exports in the worker | as recorded by C3 02-TRD §2.2 (published 2026-06-08; runtime dep `fflate`) | `exceljs` 4.4.0 stale (C3 reasoning); SheetJS npm 0.18.5 stale |

Confined behind `services/worker/src/jobs/analytics/export/XlsxWriter.ts` (one file to replace). No other runtime dependency. No ORM, no Supabase client.

## 3. Module architecture

### 3.1 Data flow

```mermaid
flowchart LR
  subgraph Sources["Other schemas (read via v_pub_* only)"]
    FD[frontdesk.v_pub_order_daily / referrer_volume / centre_volume]
    BL[billing.v_pub_invoice_daily / department_income / payment_collection / referrer_billing]
    LB[lab.v_pub_result_daily / specimen_timeline / rejection_daily / critical_value_daily / pending_items]
    RP[reporting.v_pub_report_release / order_report_tat / delivery_daily]
    IN[instruments.v_pub_message_daily / agent_status / instrument_directory]
    CT[catalog.v_pub_department / test_directory / referrer_directory]
  end
  EV[(core.event_log → evt.analytics.*)] --> DM[consumers: mark dirty, order_index]
  DM --> DP[(analytics.dirty_partitions)]
  CR[cron: sweep 10 min / nightly 40 d] --> DP
  DP --> RF[task analytics.refresh_tenant]
  FD & BL & LB & RP & IN --> RF
  RF --> RT[(analytics rollup tables + refresh_state)]
  RT --> API[API handlers (user RLS)]
  LB -. live pending .-> API
  IN -. live agents .-> API
  CT -. labels .-> API
  API --> BFF[apps/web BFF] --> UI[analytics pages]
  API --> EXQ[(analytics.exports)] --> EXJ[task analytics.build_export] --> EXF[(analytics.export_files)]
  SCH[(analytics.schedules)] --> DSP[cron analytics.dispatch_schedules] --> NP[NotificationPort.sendEmailLink]
```

Rules:
- Every SQL statement in `repository/` references only `analytics.*` tables, `<other>.v_pub_*` views listed for C8 in IC §6, and nothing else (CV §5.13 CI grep). Core data only via `ctx.core`.
- The worker refreshes rollups as the `analytics` system actor (claims `actor_type: 'system'` → `app.has_all_centres()` = true, CV §5.8), so views return tenant-wide rows. API handlers read rollups under the **user's** claims, so RLS on `analytics.*` (05-SCHEMA §3) enforces centre scope. Repository functions also take an explicit `Scope` argument and add the same predicate (REQ-SEC-024 defence in depth; mandatory for worker paths where RLS is tenant-wide).

### 3.2 Files (CV §2.2 / §2.3 / §2.4)

```
services/api/src/modules/analytics/
├── index.ts                          # manifest: name 'analytics', openapi 'contracts/openapi/analytics.yaml', produces: [], systemPermissions
├── permissions.ts                    # analytics.dashboard.read, analytics.referral_report.read, analytics.data.export,
│                                     # analytics.collections.read (CR-C8-001), analytics.schedule.manage (CR-C8-001)
├── config.ts                         # §11 keys
├── handlers/<operationId>.ts         # one per operationId (§5)
├── service/
│   ├── context.service.ts            # resolvePeriod(), resolveScope(), loadFlags()
│   ├── dashboard.service.ts
│   ├── reports.service.ts            # one method per report_code; shared aggregation helpers
│   ├── pending.service.ts            # live pending + backlog
│   ├── freshness.service.ts
│   ├── refresh.service.ts            # manual refresh + family refresh logic (imported by worker)
│   ├── export.service.ts             # create/list/get/download; build() used by worker
│   ├── schedule.service.ts           # CRUD; dispatch() used by worker
│   └── labels.service.ts             # departments/tests/referrers/instruments (published views); centres/branches (ctx.core);
│                                     #   staff names via ctx.core.memberships.list({membershipIds}) (08 A17 P-17, D-47)
├── domain/
│   ├── period.ts                     # Period parsing, B.S. month/FY → [from,to), max range, previous period
│   ├── scope.ts                      # Scope type; intersect(); assertWithin()
│   ├── families.ts                   # Family enum, family → tables, dirty mapping from events (pure)
│   ├── metrics.ts                    # M-id formulas over typed rows (pure), ratios in bp, deltas
│   ├── reportRegistry.ts             # report_code → {permission, families, params schema, export columns}
│   ├── schedule.ts                   # slot computation (pure; injected clock)
│   ├── csv.ts                        # RFC 4180 quoting only; formula neutralisation from @lims/shared-ts/spreadsheet (P-9)
│   └── freshness.ts                  # stale rule (pure)
├── repository/
│   ├── rollups.repo.ts               # SELECT from analytics.daily_* (scope param mandatory)
│   ├── tat.repo.ts                   # percentile queries over analytics.tat_facts
│   ├── refresh.repo.ts               # dirty_partitions, refresh_state, refresh_runs, partition replace SQL (§9.2)
│   ├── sourceViews.repo.ts           # SELECT … FROM <schema>.v_pub_* (refresh + live pending/agents)
│   ├── labels.repo.ts                # catalog.v_pub_department / test_directory / referrer_directory;
│   │                                 #   instruments.v_pub_instrument_directory (instrument labels, 08 §4.9)
│   ├── orderIndex.repo.ts
│   ├── exports.repo.ts               # exports, export_files
│   └── schedules.repo.ts             # schedules, schedule_recipients, report_runs, report_run_recipients
├── mappers/*.dto.ts                  # explicit field allowlists (REQ-SEC-081)
└── __tests__/{unit,integration,contract,probes}/, __tests__/ci/no-commission.sh   # CI gate script (§13, P-14) [CONV path]

services/worker/src/jobs/analytics/
├── index.ts                          # WorkerManifest (§9.4)
├── consumers/<event_type>.ts         # 12 consumers (§8)
├── tasks/refresh_tenant.ts           # processes dirty partitions for one tenant
├── tasks/sweep_recent.ts             # cron per tenant: mark today(/yesterday) dirty, run refresh
├── tasks/sweep_nightly.ts            # cron per tenant: trailing 40 days
├── tasks/build_export.ts
├── tasks/dispatch_schedules.ts
├── tasks/self_check.ts
├── tasks/purge.ts
├── tasks/backfill.ts                 # manual (CLI-enqueued) range rebuild
├── export/{XlsxWriter.ts, CsvWriter.ts, PdfRequest.ts, layout.ts}
├── ops/analytics.rules.yml           # alert rules for C1 (§13, 08 A13 P-14; wired by CR-C8-015) [CONV path]
└── __tests__/{unit,integration}/

apps/web/src/app/(staff)/analytics/
├── page.tsx, loading.tsx, error.tsx                  # dashboard  (route staff.analytics.dashboard)
├── reports/page.tsx, loading.tsx, error.tsx          # report hub with tabs (staff.analytics.reports, CR-C8-008)
├── reports/[report_code]/page.tsx, loading.tsx, error.tsx
├── collections/page.tsx, loading.tsx, error.tsx      # staff.analytics.collections (08 A17 D-46; renders US-08 with #4)
├── referral-incentive/page.tsx, loading.tsx, error.tsx   # staff.analytics.referral_incentive (CR-C8-008)
├── exports/page.tsx, loading.tsx, error.tsx          # staff.analytics.exports (CR-C8-008)
├── schedules/page.tsx, [schedule_id]/page.tsx, new/page.tsx (+ loading/error)  # staff.analytics.schedules (CR-C8-008)
└── report-runs/[report_run_id]/page.tsx (+ loading/error)  # staff.analytics.report_run (CR-C8-008)
apps/web/src/features/analytics/
├── nav.manifest.ts, server/<operationId>.server.ts, components/, hooks/, forms/, help/, __tests__/
```

`[report_code]` is not a route parameter in `routes.yaml` (it is a fixed allowlisted segment value, not an id); the page validates it against `reportRegistry` and renders `notFound()` otherwise.

### 3.3 Report registry (`domain/reportRegistry.ts`)

| report_code | Permission(s) | Families | Live sources | Exportable | Schedulable |
|---|---|---|---|---|---|
| `dashboard` | `analytics.dashboard.read` (+ `analytics.collections.read` for the collections tile) | orders, centre_volume, income, collections, results, report_backlog | pending_items | yes | yes |
| `income` | `analytics.dashboard.read` | income | — | yes | yes |
| `department_income` | `analytics.dashboard.read` | department_income | — | yes | yes |
| `collections` | `analytics.collections.read` (CR-C8-001); page `staff.analytics.collections` (08 A17 D-46) | collections | — | yes | yes |
| `volume` | `analytics.dashboard.read` | orders, centre_volume | — | yes | yes |
| `top_referrers` | `analytics.dashboard.read` | referrer_volume (volume only; no money columns — 08 A17 D-44, B13) | — | yes | yes |
| `top_centres` | `analytics.dashboard.read` | centre_volume, income | — | yes | yes |
| `referral_incentive` | `analytics.referral_report.read` (privileged) + flag `referralIncentiveReportEnabled` | referrer_volume, referrer_billing | — | yes | yes (§9.7 rule) |
| `tests_done` | `analytics.dashboard.read` | results | — | yes | yes |
| `tat` | `analytics.dashboard.read` | tat | — | yes | yes |
| `pending_tests` | `analytics.dashboard.read` | report_backlog | pending_items | yes (no patient identifiers) | yes |
| `quality_indicators` | `analytics.dashboard.read` | rejections, specimens, critical_values | — | yes | yes |
| `delivery` | `analytics.dashboard.read` | deliveries, releases | — | yes | yes |
| `interfaces` | `analytics.dashboard.read` | interface_messages | agent_status | yes | no |

Scheduled-report recipient permission (08 A4.2/A5.4): the `requiredPermission` C8 puts on the staff recipient of a `scheduled_report_ready` notification is taken from this registry. Every schedule recipient must hold `analytics.dashboard.read` (the permission of the run landing, `getReportRun` #29, and the base eligibility gate of §9.6 step 5); the other registry permissions (`analytics.collections.read`, `analytics.referral_report.read`) only decide which reports of the pack that recipient sees (omission rule, §9.6 step 5). So `requiredPermission` = `analytics.dashboard.read` for every pack (binding: 08 A7.6). Only permission names from 03-IC §11 are used.

Net billed per referrer (M33) is served **only** by `referral_incentive` (flag, privileged permission at aal2, access log `referral_report.view`); no other endpoint, export, schedule or dashboard card returns `net_billed_paisa` (08 A17 D-44; 07-BLOCKERS B13).

Unknown `report_code` (in path, export body or schedule body) → `404 analytics.report_unknown` (IC §8). Coded set `analytics.g_cs_report_codes` (05-SCHEMA §4) holds the same list for FK integrity.

## 4. Period and scope resolution (every report endpoint)

`service/context.service.ts`:

```ts
export interface PeriodQuery { business_date_from?: IsoDate; business_date_to?: IsoDate; bs_month?: string; fiscal_year_bs?: string }
export interface Period { from: IsoDate; to: IsoDate /* exclusive */; labelAd: string; labelBs: string; bsMonth?: string; fiscalYearBs?: string; days: number }
export function resolvePeriod(q: PeriodQuery, today: IsoDate, maxDays: number): Period;
export interface Scope { readonly all: boolean; readonly centreIds: readonly Uuidv7[] }   // effective scope
export async function resolveScope(ctx: HandlerContext, requested: { centreIds?: readonly Uuidv7[]; branchIds?: readonly Uuidv7[] }): Promise<Scope>;
```

resolvePeriod (pure, unit-tested against the golden table):
1. Exactly one of {both `business_date_from` and `business_date_to`}, `bs_month`, `fiscal_year_bs`, or none. One date bound without the other, or two selectors → `400 common.validation_failed` (`errors[].path` = the offending param).
2. None → today (business date of `ctx.now()` in Asia/Kathmandu) → `[today, today+1)`.
3. `bs_month = 'YYYY-MM'` → `from = bsToAd({y, m, 1})`, `to = bsToAd(first day of next B.S. month)`; B.S. out of 1975–2099 → `422 common.date_out_of_range`.
4. `fiscal_year_bs = 'YYYY/YY'` → `fy = fiscalYearBs(bsToAd({y, 4, 1}))`; check `fy.long === input`; `from = fy.startsOn`, `to = fy.endsOn + 1 day`.
5. `from >= to` → `400 common.validation_failed`; `days > maxDays` (`LIMS_ANALYTICS_MAX_RANGE_DAYS`, 366 [CONV]) → `422 analytics.range_too_large`.
6. `previous(period)` = same number of days immediately before `from` (dashboard deltas).

resolveScope:
1. `profile = await ctx.ports.IdentityPort.getActor(ctx)` (memoised per request).
2. Requested `centre_id` values (≤ 20) must each be in `profile.centreScope.centreIds` unless `profile.centreScope.all`; else `404 common.not_found` (no oracle). `branch_id` values (≤ 20) must exist in `ctx.core.branches(ctx)`; a branch filter is converted to the set of its centres (`ctx.core.centres(ctx, {branchId})`) ∩ caller scope.
3. Effective scope: `{ all: profile.centreScope.all && no filter, centreIds: … }`.
4. Families without a centre column (PRD §8.3) are served only when `scope.all`; otherwise the response section is omitted and its family listed in `scope.tenant_wide_sections_hidden`. With CR-C8-004 and CR-C8-005 accepted (03-IC §6.3/§6.4; 08 A17 D-48), **no Phase-1 family is tenant-wide-only**, so the list is empty in Phase 1; the field stays in the contract for later families. Rows whose `centre_id` is NULL (credit-party invoices and payments, non-report deliveries) are still visible only to all-centre readers (scope predicate §6, RLS 05-SCHEMA §3).

## 5. Endpoints (`contracts/openapi/analytics.yaml`, prefix `/v1/analytics`)

Common to all: `security: [bearerJwt]` (called by the BFF), `tags: [analytics]`, `x-rate-limit-tier: general` (CV §10.3) unless stated, responses `401/403/404/422/429/500` with codes listed. All query objects `additionalProperties: false`; unknown params → `400 common.validation_failed`. No PHI in any query string (REQ-SEC-098): queries carry only ids, codes and dates; the referrer search is a POST body.

Shared components:
- `PeriodQuery` (query params): `business_date_from` (date), `business_date_to` (date), `bs_month` (string `^[0-9]{4}-(0[1-9]|1[0-2])$`), `fiscal_year_bs` (string `^[0-9]{4}/[0-9]{2}$`).
- `ScopeQuery`: `centre_id` (array of uuid, `style: form, explode: false`, maxItems 20), `branch_id` (same, maxItems 20).
- `Period` (response): `{business_date_from, business_date_to, days, label_ad, label_bs, bs_month?, fiscal_year_bs?, timezone: enum [Asia/Kathmandu]}`.
- `ScopeEcho`: `{all_centres: boolean, centre_ids: uuid[] ≤ 50, tenant_wide_sections_hidden: string[] ≤ 20 (family codes)}`.
- `Freshness`: `{family: string (x-coded-set analytics.families), refreshed_at?: IsoUtc, is_stale: boolean, stale_reason?: enum [refresh_lagging, refresh_failed, never_refreshed], live: boolean}`.
- `ReportEnvelope`: `{report_code, period: Period, scope: ScopeEcho, freshness: Freshness[] ≤ 20, generated_at: IsoUtc}`; every report response is `allOf[ReportEnvelope, {<report fields>}]`.
- `Count` = integer ≥ 0; `Paisa` = integer (may be negative where stated); `Bp` = integer basis points (0–1,000,000); `Seconds` = integer ≥ 0.
- `GroupKey`: `{key: string ≤ 64, label: string ≤ 200, label_bs?: string ≤ 32, is_inactive?: boolean}` — `key` is a date, `YYYY-MM`, B.S. `YYYY-MM`, uuid, or code.

| # | operationId | Method + path | Permission | Idem. | Request | 200 response | Errors (`x-error-codes`) |
|---|---|---|---|---|---|---|---|
| 1 | `getAnalyticsDashboard` | GET `/dashboard` | `analytics.dashboard.read` | none | PeriodQuery + ScopeQuery | `DashboardDto` (§5.1); collections tile only when the caller holds `analytics.collections.read` (omitted, not 403) | `common.validation_failed`, `common.date_out_of_range`, `analytics.range_too_large`, `common.not_found` (scope), `auth.forbidden`; **#1 only** (not inherited by "as #1"): `common.dependency_unavailable` (503, live pending read timed out, §6.7) |
| 2 | `getIncomeReport` | GET `/reports/income` | `analytics.dashboard.read` | none | Period+Scope, `group_by` enum [day, ad_month, bs_month, branch, centre] default day | `IncomeReport` | as #1 |
| 3 | `getDepartmentIncomeReport` | GET `/reports/department-income` | `analytics.dashboard.read` | none | Period+Scope, `group_by` enum [department, department_ad_month, department_bs_month] default department, `department_id` uuid[] ≤ 50 | `DepartmentIncomeReport` | as #1 |
| 4 | `getCollectionsReport` | GET `/reports/collections` | `analytics.collections.read` (CR-C8-001) | none | Period+Scope, `group_by` enum [method, staff, staff_method, centre, day, ad_month, bs_month] default method, `payment_method_code` string[] ≤ 20 (x-coded-set billing.payment_methods) | `CollectionsReport` | as #1 |
| 5 | `getVolumeReport` | GET `/reports/volume` | `analytics.dashboard.read` | none | Period+Scope, `group_by` enum [day, ad_month, bs_month, branch, centre] | `VolumeReport` | as #1 |
| 6 | `getTopReferrersReport` | GET `/reports/top-referrers` | `analytics.dashboard.read` | none | Period+Scope, `sort` enum [-orders, -patient_visits, -tests_ordered] default -orders (08 A17 D-44), `limit` 1–100 default 20, `rollup` enum [canonical, none] default canonical, `referrer_id` uuid[] ≤ 20 (narrows to those referrers; with `rollup=canonical` matched on the canonical id) | `TopReferrersReport` (volume only) | as #1 |
| 7 | `getTopCentresReport` | GET `/reports/top-centres` | `analytics.dashboard.read` | none | Period+Scope, `sort` enum [-orders, -net_sales_paisa, -patient_visits, -tests_ordered], `limit` 1–50 default 20 | `TopCentresReport` | as #1 |
| 8 | `getReferralIncentiveReport` | GET `/reports/referral-incentive` | `analytics.referral_report.read` (privileged) | none | Period+Scope, `group_by` enum [referrer, referrer_ad_month, referrer_bs_month], `rollup`, `referrer_id` uuid[] ≤ 20 (as #6), `cursor`, `limit` ≤ 200 default 50 | `ReferralIncentiveReport` (paged) | as #6 + `common.feature_disabled`, `auth.mfa_required`, `common.invalid_cursor` |
| 9 | `getTestsDoneReport` | GET `/reports/tests-done` | `analytics.dashboard.read` | none | Period, `processing_branch_id` uuid[] ≤ 20, `department_id` uuid[] ≤ 50, `group_by` enum [department, test, processing_branch, day, ad_month, bs_month] | `TestsDoneReport` | as #1 |
| 10 | `getTatReport` | GET `/reports/tat` | `analytics.dashboard.read` | none | Period+Scope, `segment` enum[] [pre_analytical, transport, within_lab, total_first_release, total_final_release] default all, `priority` enum [routine, urgent], `specimen_type_code` string[] ≤ 20, `processing_branch_id` uuid[] ≤ 20, `group_by` enum [none, centre, processing_branch, priority, specimen_type, day, ad_month, bs_month] default none | `TatReport` | as #1 |
| 11 | `getPendingTestsSummary` | GET `/reports/pending-tests/summary` | `analytics.dashboard.read` | none | ScopeQuery, `department_id` uuid[] ≤ 50, `priority` enum [routine, urgent], `processing_branch_id` uuid[] ≤ 20 | `PendingSummary` | `common.validation_failed`, `common.not_found`, `auth.forbidden`, `common.dependency_unavailable` (503, §6.7) |
| 12 | `listPendingTests` | GET `/reports/pending-tests/items` | `analytics.dashboard.read` | none | ScopeQuery + filters of #11 + `item_status` enum[] [awaiting_collection, awaiting_receipt, in_process, resulted, verified] (the C5 view's pending set, C5 05-SCHEMA §4), `overdue_only` boolean, `sort` enum [-age_seconds, age_seconds] default -age_seconds, `cursor`, `limit` ≤ 200 default 50 | page of `PendingItemDto` | as #11 + `common.invalid_cursor` |
| 13 | `getQualityIndicatorsReport` | GET `/reports/quality-indicators` | `analytics.dashboard.read` | none | Period+Scope, `group_by` enum [reason, centre, specimen_type, day, ad_month, bs_month] | `QualityIndicatorsReport` | as #1 |
| 14 | `getDeliveryReport` | GET `/reports/delivery` | `analytics.dashboard.read` | none | Period+Scope, `group_by` enum [channel, day, ad_month, bs_month] | `DeliveryReport` | as #1 |
| 15 | `getInterfacesReport` | GET `/reports/interfaces` | `analytics.dashboard.read` | none | Period+Scope | `InterfacesReport` | as #1 |
| 16 | `getAnalyticsFilterOptions` | GET `/filter-options` | `analytics.dashboard.read` (08 A17 D-46) | none | — | `{centres:[{id,label,branch_id,is_active}] ≤ 200, branches:[{id,label,is_active}] ≤ 50, departments:[{id,label,is_active}] ≤ 200, payment_methods:[{code,display}] ≤ 50, specimen_types:[{code}] ≤ 100, recipients?:[{membership_id, display_name}] ≤ 200}` within caller scope. `recipients` + only when the caller holds `analytics.schedule.manage` (P-10 conditional; otherwise omitted) = `ctx.core.memberships.list({ permission: 'analytics.dashboard.read' })` (08 A17 D-47/P-17; active user memberships of the tenant; request-memoised) | `auth.forbidden` |
| 17 | `searchAnalyticsReferrers` | POST `/referrers/search` | `analytics.dashboard.read` | none | `{query: string 2–60}` | `{data:[{referrer_id, label, is_active}] ≤ 20}` | `common.validation_failed` |
| 18 | `getAnalyticsFreshness` | GET `/freshness` | `analytics.dashboard.read` | none | — | `{data: Freshness[]}` | — |
| 19 | `requestAnalyticsRefresh` | POST `/refresh` | `analytics.dashboard.read` | optional | `{families?: string[] ≤ 20}` (default all) | `202 {queued_families: string[], next_allowed_at: IsoUtc}` | `common.rate_limited`, `common.validation_failed` |
| 20 | `createAnalyticsExport` | POST `/exports` | `analytics.data.export` (privileged) + `registry[report_code].permission` when the body names that report (P-10; §10.1 step 2) | **required** | `{report_code, format: enum [xlsx, csv, pdf], params: ExportParams}` | `202 ExportDto` | `analytics.report_unknown`, `common.feature_disabled` (pdf, referral flag off), `analytics.range_too_large`, `common.validation_failed`, `common.date_out_of_range`, `common.rate_limited` (quota), `auth.forbidden` (report permission), `auth.mfa_required`, `common.not_found` (scope), `common.idempotency_key_required`, `common.idempotency_key_reused`, `common.idempotency_in_progress` |
| 21 | `listAnalyticsExports` | GET `/exports` | `analytics.data.export` | none | `status` enum[], `cursor`, `limit` ≤ 50 | page of `ExportDto` (own only) | `common.invalid_cursor` |
| 22 | `getAnalyticsExport` | GET `/exports/{export_id}` | `analytics.data.export` | none | — | `ExportDto` | `common.not_found` |
| 23 | `downloadAnalyticsExport` | GET `/exports/{export_id}/file` | `analytics.data.export` (privileged) | none | — | `200` binary (`Content-Type` per format, `Content-Disposition: attachment; filename="<code>_<from>_<to>.<ext>"`, `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`) | `common.not_found`, `analytics.export_not_ready` (CR-C8-002), `analytics.export_unavailable` (CR-C8-002), `auth.mfa_required` |
| 24 | `listReportSchedules` | GET `/schedules` | `analytics.schedule.manage` (CR-C8-001) | none | `is_active` boolean, `cursor`, `limit` ≤ 50 | page of `ScheduleDto` | — |
| 25 | `createReportSchedule` | POST `/schedules` | `analytics.schedule.manage` | **required** | `ScheduleInput` | `201 ScheduleDto` | `analytics.report_unknown`, `analytics.recipient_ineligible` (CR-C8-002), `common.validation_failed` (incl. the per-tenant cap: more than `LIMS_ANALYTICS_MAX_SCHEDULES_PER_TENANT` active schedules → `400` with `errors[0].path = ''`, 08 A13 P-1), `common.not_found` (scope/recipient), `common.idempotency_key_required`, `common.idempotency_key_reused`, `common.idempotency_in_progress` |
| 26 | `getReportSchedule` | GET `/schedules/{schedule_id}` | `analytics.schedule.manage` | none | — | `ScheduleDto` + last 20 runs | `common.not_found` |
| 27 | `updateReportSchedule` | PUT `/schedules/{schedule_id}` (`If-Match`) | `analytics.schedule.manage` | optional | `ScheduleInput` | `ScheduleDto` | as #25 + `common.version_conflict`, `common.precondition_required` |
| 28 | `deactivateReportSchedule` | POST `/schedules/{schedule_id}/deactivate` (`If-Match`) | `analytics.schedule.manage` | optional | `{}` | `ScheduleDto` | `common.version_conflict`, `common.precondition_required` |
| 29 | `getReportRun` | GET `/report-runs/{report_run_id}` | `analytics.dashboard.read` | none | — | `ReportRunDto` | `common.not_found` (not a recipient/owner, other tenant) |
| 30 | `getCollectionsFilterOptions` | GET `/filter-options/collections` | `analytics.collections.read` (08 A17 D-46) | none | — | `{centres, branches, payment_methods}` — same shapes and limits as #16, within caller scope | `auth.forbidden` |

Endpoint count 30 (08 A17 D-46). Every operation carries `x-permission`, `x-idempotency`, `x-rate-limit-tier: general`, examples from synthetic data (CV §4.12).

### 5.1 Response schemas (fields; all objects `additionalProperties: false`)

```yaml
Tile:            { value: integer, previous?: integer, delta?: integer, delta_bp?: integer, unit: enum [count, paisa, seconds] }
                 # previous/delta omitted for snapshot tiles (reports_pending, reports_ready_unreleased, pending_tests,
                 # pending_overdue — PRD §8.2 M50–M54 "n/a (snapshot)"); present on every other tile; delta_bp omitted when previous = 0
DashboardDto:    allOf ReportEnvelope +
  tiles: { patient_visits: Tile, new_patients: Tile, net_orders: Tile, tests_ordered: Tile,
           net_sales_paisa: Tile, invoiced_paisa: Tile, credit_notes_paisa: Tile,
           results_approved: Tile,               # centre-scoped via daily_results.centre_id (CR-C8-004 accepted)
           net_collected_paisa?: Tile,           # omitted without analytics.collections.read
           reports_pending: Tile, reports_ready_unreleased: Tile, pending_tests: Tile, pending_overdue: Tile }
  series: { days: [ { business_date, net_sales_paisa, patient_visits, net_orders } ] ≤ 366 }   # for TimeSeriesChart
  department_top: [ { department_id?, label, is_multiple, net_paisa, share_bp } ] ≤ 10
IncomeRow:       GroupKey + { invoices_issued, invoices_cancelled, gross_paisa, discount_paisa, exempt_paisa, taxable_paisa,
                              vat_paisa, other_tax_paisa, invoiced_paisa, credit_notes_paisa, net_sales_paisa }
IncomeReport:    ReportEnvelope + { rows: IncomeRow[] ≤ 400, totals: IncomeRow(without key/label), basis_note_key: string }
DepartmentIncomeReport: { rows: [ GroupKey + { department_id?, is_multiple: boolean, period_key?, line_count, gross_paisa,
                              discount_paisa, net_paisa, share_bp } ] ≤ 5000, totals: {line_count, gross_paisa, discount_paisa, net_paisa},
                          reconciles_with_income: boolean }            # R2 evaluated on the response
CollectionsReport: { rows: [ GroupKey + { entries, reversals, gross_collected_paisa, reversed_paisa, net_collected_paisa } ] ≤ 5000,
                     totals: {…}, daily_cash_route_id?: enum [staff.billing.daily_cash] }   # present when user holds billing.cash_report.read
VolumeReport:    { rows: [ GroupKey + { orders_registered, orders_cancelled, net_orders, patient_visits, new_patients, urgent_orders,
                              opd_orders, ipd_orders, tests_ordered } ] ≤ 400, totals }
TopReferrersReport: { rows: [ { rank, referrer_id?, label, is_self, is_inactive, orders, patient_visits, tests_ordered } ] ≤ 100,
                      totals: { orders, patient_visits, tests_ordered } }     # volume only, no money field (08 A17 D-44, B13)
TopCentresReport: { rows: [ { rank, centre_id, label, branch_id, orders, patient_visits, tests_ordered, net_sales_paisa,
                              by_mode: { walk_in, home, centre, partner } } ] ≤ 50, totals }
ReferralIncentiveReport: { rows: [ { referrer_id?, label, is_self, period_key?, period_label?, orders, patient_visits, tests_ordered,
                              net_billed_paisa? } ] ≤ 200, totals, billed_note_key, page: { next_cursor?, limit } }
                 # net_billed_paisa omitted on the SELF row (is_self): billing.v_pub_referrer_billing has no rows without a referrer,
                 # so the figure is not available; UI shows "—" (review m#28). The only response carrying net_billed_paisa (D-44).
TestsDoneReport: { rows: [ GroupKey + { results_resulted, results_verified, results_approved, results_amended, auto_verified,
                              critical_count, abnormal_count, tests_approved } ] ≤ 5000, totals }
                 # results_* = analyte-level counts (M40–M46, label "analyte level"); tests_approved = order tests approved (M47)
TatRow:          { segment, key?, label?, n, median_seconds?, p90_seconds?, max_seconds?, anomalies }    # stats omitted when n = 0
TatReport:       { rows: TatRow[] ≤ 2000, segment_definitions: [ { segment, start_label_key, stop_label_key } ] }
PendingSummary:  envelope(no period) + { total, overdue, no_target, by_status: [ {item_status, count} ], by_priority: [...],
                   by_department: [ {department_id, label, count, overdue} ] ≤ 200, by_age_bucket: [ {bucket: enum [lt_4h, h4_24, d1_3, gt_3d], count} ],
                   backlog: { reports_pending, awaiting_results, ready_unreleased, oldest_registered_at?, by_centre: [...] ≤ 200 },
                   age_anchor_note_key }
PendingItemDto:  { order_item_id, order_id, centre_id, processing_branch_id?, department_id, test_id, test_code, test_label,
                   priority, item_status, age_seconds, tat_target_seconds?, is_overdue, open_route_id?: enum [staff.lab.order_results] }
QualityIndicatorsReport: { rejections: { rows: [ GroupKey + {rejections, recollections_ordered, specimens_received, per_100_received_bp} ], totals },
                           critical_values: { rows: [ { business_date, detected, notified, notified_bp, median_notify_seconds?, max_notify_seconds? } ] ≤ 366,
                                              totals: { detected, notified, notified_bp, max_notify_seconds? } } }   # centre-scoped (CR-C8-004)
DeliveryReport:  { deliveries: { rows: [ GroupKey + { queued, sent, delivered, read, failed, suppressed, failure_share_bp } ], totals },
                   releases: { rows: [ GroupKey + { released, final, partial, preliminary, amended, overrides } ], totals } }
                 # deliveries centre-scoped via v_pub_delivery_daily.centre_id (CR-C8-005, 08 A17 D-48); NULL-centre rows all-centre only
InterfacesReport: { instruments: [ { instrument_id, instrument_code?, label?, is_active?, centre_id, messages, patient_records, qc_records,
                                     unmatched, quarantined, duplicates } ] ≤ 200,
                    agents: { by_state: [ { state, count } ], agents: [ { agent_id, centre_id, state, last_heartbeat_at, agent_version, queue_depth } ] ≤ 200 } }
                 # instrument_code/label (= display_name)/is_active from instruments.v_pub_instrument_directory (08 R12d); omitted if no directory row
ExportParams:    { business_date_from?, business_date_to?, bs_month?, fiscal_year_bs?, centre_id?: uuid[] ≤ 20, branch_id?: uuid[] ≤ 20,
                   group_by?: string ≤ 32, filters?: { department_id?: uuid[] ≤ 50, processing_branch_id?: uuid[] ≤ 20,
                   priority?: enum [routine, urgent], segment?: enum[] [pre_analytical, transport, within_lab, total_first_release, total_final_release],
                   payment_method_code?: string[] ≤ 20, rollup?: enum [canonical, none], referrer_id?: uuid[] ≤ 20,
                   item_status?: enum[] [awaiting_collection, awaiting_receipt, in_process, resulted, verified], overdue_only?: boolean } }
ExportDto:       { id, report_code, format, status: enum [queued, building, ready, failed, expired], params: ExportParams,
                   requested_at, ready_at?, expires_at?, row_count?, size_bytes?, downloads_used, downloads_allowed, failure_code? }
ScheduleInput:   { name: string 1–80, report_codes: string[] 1–10, frequency: enum [daily, weekly, monthly_ad, monthly_bs],
                   send_time_local: string ^([01][0-9]|2[0-3]):(00|15|30|45)$, weekday?: integer 1–7 (ISO; required iff weekly),
                   period_rule: enum [previous_business_day, previous_7_days, month_to_date_ad, previous_ad_month, month_to_date_bs,
                                      previous_bs_month, fiscal_year_to_date],
                   scope: { all_centres: boolean, centre_ids?: uuid[] ≤ 20 }, recipient_membership_ids: uuid[] 1–20 }
ScheduleDto:     ScheduleInput + { id, version, is_active, next_run_at?, created_at, owner_membership_id, last_run?: ReportRunSummary }
                 # recipient_membership_ids lists active schedule_recipients rows only (is_active = true; 08 A17 D-45)
ReportRunDto:    { id, schedule_id, schedule_name, report_codes, period: Period, scope_all_centres, scope_centre_ids, created_at,
                   effective_scope: ScopeEcho, viewer_omitted_report_codes: string[],
                   recipients?: [ { membership_id, display_name, outcome } ] (owner only) }
                 # viewer_omitted_report_codes: the caller's report_run_recipients.omitted_report_codes; for the schedule owner who is not a
                 # recipient, the run-level report_runs.omitted_report_codes. S7 renders only report_codes minus these (review m#20).
                 # display_name via ctx.core.memberships.list({ membershipIds, activeOnly: false }) (P-17)
```

Mappers return exactly these fields (REQ-SEC-081). No field anywhere is named or labelled with "commission".

### 5.2 Handler pattern (CV §2.2)

```ts
// handlers/getIncomeReport.ts
export const getIncomeReport: Handler<'getIncomeReport'> = async (req, ctx) => {
  await ctx.ports.IdentityPort.assertRole(ctx, { permission: 'analytics.dashboard.read' });
  const period = resolvePeriod(req.query, businessToday(ctx.now()), cfg.maxRangeDays);
  const scope = await resolveScope(ctx, { centreIds: req.query.centre_id, branchIds: req.query.branch_id });
  const out = await ctx.services.analytics.reports.income(ctx, { period, scope, groupBy: req.query.group_by ?? 'day' });
  return { status: 200, body: toIncomeReportDto(out) };
};
```

`assertRole` is called before any read (CV §10.1). For `centre_id` filters, scope resolution (§4) is the object-level check. For `getReferralIncentiveReport`: `assertRole('analytics.referral_report.read')` (privileged → aal2 + membership re-validation in C2), then `getTenantSettings({keys:['referralIncentiveReportEnabled']})`; false → `403 common.feature_disabled`; then `ctx.audit.access({action:'referral_report.view', entityType:'analytics_report', outcome:'allowed', detail:{report_code, from, to, rows}})` (CR-C8-006).

## 6. Query specifications

All rollup reads are `SELECT … FROM analytics.<table> WHERE tenant_id = $tenant AND business_date >= $from AND business_date < $to AND <scope predicate> [AND filters] GROUP BY …`. Scope predicate (`repository/scope.sql.ts`):

```sql
-- $all boolean, $centres uuid[]
AND ($all OR (centre_id IS NOT NULL AND centre_id = ANY ($centres)))
```

### 6.1 Income (M10–M20)

```sql
SELECT <group_key>,
       sum(invoices_issued)::bigint, sum(invoices_cancelled)::bigint, sum(gross_paisa)::bigint, sum(discount_paisa)::bigint,
       sum(exempt_paisa)::bigint, sum(taxable_paisa)::bigint, sum(vat_paisa)::bigint, sum(other_tax_paisa)::bigint,
       sum(net_paisa)::bigint AS invoiced_paisa, sum(credit_notes_paisa)::bigint,
       (sum(net_paisa) - sum(credit_notes_paisa))::bigint AS net_sales_paisa
FROM analytics.daily_income
WHERE tenant_id = $1 AND business_date >= $2 AND business_date < $3 AND ($4 OR (centre_id IS NOT NULL AND centre_id = ANY ($5)))
GROUP BY <group_key> ORDER BY <group_key>;
```
`<group_key>`: `business_date` (day); `date_trunc('month', business_date)::date` (ad_month); `branch_id`; `centre_id`. `bs_month`: query by `business_date`, then aggregate in `domain/metrics.ts` by `formatBs(adToBs(d)).slice(0,7)` (exact integer sums). Totals = sum of rows (computed in SQL with `GROUPING SETS ((<key>), ())` for exactness).

### 6.2 Department income (M21, R2)

From `analytics.daily_department_income`; labels joined in service from `catalog.v_pub_department` (`labels.repo.ts`: `SELECT department_id, name, is_active FROM catalog.v_pub_department WHERE tenant_id = $1`). `reconciles_with_income` = (Σ `net_paisa` over all departments for the same period/scope) == M12 from §6.1; false → response still returned, `lims_analytics_reconciliation_mismatch_total{rule="R2"}` incremented, warn log `reconciliation_mismatch` (ids/dates only).

### 6.3 Collections (M25–M29)

From `analytics.daily_collections`; `staff` key = `collected_by_membership_id` (NULL for gateway captures, `capture_kind = 'gateway'` — C4 CHECK per 08 R8; label "Online gateway"); label = `displayName` from `ctx.core.memberships.list({ membershipIds, activeOnly: false })` (≤ 200 ids per call, batched; request-memoised; 08 A17 P-17/D-47); `isActive = false` → `is_inactive`. `method` label from `billing.g_cs_payment_methods` is **not** readable (foreign table) → label = code mapped through the message catalog `analytics.payment_method.<code>` with fallback to the code (DECISION; coded-set display view is a CR candidate).

### 6.4 Volume, centres, referrers

- Volume: `analytics.daily_orders` (+ `tests_ordered` from `analytics.daily_centre_volume` summed by the same key).
- Top centres: `daily_centre_volume` grouped by `centre_id` (+ `collection_mode` pivot) joined in SQL to `daily_income` net sales by `centre_id`; rank by `sort`; ties: label, id.
- Top referrers reads `daily_referrer_volume` only (orders, patient visits, tests ordered — 08 A17 D-44). The referral report reads `daily_referrer_volume` and `daily_referrer_billing`. Both group by `coalesce(canonical_referrer_id, referrer_id)` when `rollup = canonical`. `canonical_referrer_id` comes from `catalog.v_pub_referrer_directory` (CR-C3-004, accepted in C3 05-SCHEMA §10.4) and is resolved **at query time** (merges apply retroactively): the service loads the directory map once per request (`SELECT referrer_id, display_name, is_active, canonical_referrer_id FROM catalog.v_pub_referrer_directory WHERE tenant_id = $1`) and aggregates in memory over ≤ (days × referrers) rows; when that row count exceeds 50,000 [CONV] the SQL path joins a `VALUES` list of the map instead. `referrer_id` NULL → key `self`, label `analytics.referrer.self` ("SELF"); in the referral report the SELF row omits `net_billed_paisa` (no billing rows without a referrer). A `referrer_id` filter keeps keys whose (canonical, when `rollup = canonical`) id is in the list.
- Referral report paging: cursor = base64url `{sort_value, key}` (CV §4.3).

### 6.5 Tests done (M40–M47)

`analytics.daily_results` grouped by department/test/processing_branch/date with the scope predicate on `centre_id` (CR-C8-004 accepted: `lab.v_pub_result_daily.centre_id` = the order's collection centre, `tests_approved` = order tests approved — C5 05-SCHEMA §4); labels from catalog views. M40–M46 are analyte-level counts (column caption "analyte level"); M47 `tests_approved` is test-level.

### 6.6 TAT (M60–M64)

```sql
SELECT segment, <group_key>, count(*) FILTER (WHERE NOT is_anomaly) AS n,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_seconds) FILTER (WHERE NOT is_anomaly) AS median_seconds,
       percentile_cont(0.9) WITHIN GROUP (ORDER BY duration_seconds) FILTER (WHERE NOT is_anomaly) AS p90_seconds,
       max(duration_seconds) FILTER (WHERE NOT is_anomaly) AS max_seconds,
       count(*) FILTER (WHERE is_anomaly) AS anomalies
FROM analytics.tat_facts
WHERE tenant_id = $1 AND segment = ANY ($2) AND business_date >= $3 AND business_date < $4
  AND ($5 OR (centre_id IS NOT NULL AND centre_id = ANY ($6))) [AND priority = $7] [AND specimen_type_code = ANY ($8)] [AND processing_branch_id = ANY ($9)]
GROUP BY segment, <group_key>;
```
Percentiles are rounded half-up to whole seconds in the mapper. Segment labels: `analytics.tat.<segment>.start` / `.stop` (PRD §8.2).

### 6.7 Pending (live) and backlog (snapshot)

Live summary — runs in the **user's** transaction so C5's RLS on `lab.order_tests` applies through the invoker view (C5 05-SCHEMA §4 note). Centre scope comes **only** from C5 RLS (08 A17 D-49): hub users also see items received at their processing centres (08 A13 D-13); there is no implicit centre predicate. An explicit `centre_id` filter in ScopeQuery (already validated against the caller's scope, §4) adds `AND centre_id = ANY ($2)`:
```sql
SELECT item_status, priority, department_id,
       CASE WHEN age_seconds < 14400 THEN 'lt_4h' WHEN age_seconds < 86400 THEN 'h4_24'
            WHEN age_seconds < 259200 THEN 'd1_3' ELSE 'gt_3d' END AS age_bucket,
       count(*) AS n,
       count(*) FILTER (WHERE tat_target_seconds IS NOT NULL AND age_seconds > tat_target_seconds) AS overdue,
       count(*) FILTER (WHERE tat_target_seconds IS NULL) AS no_target
FROM lab.v_pub_pending_items
WHERE tenant_id = $1 [AND centre_id = ANY ($2) -- only when centre_id/branch_id filters are given] [filters]
GROUP BY 1,2,3,4;
```
List: same view, `ORDER BY age_seconds DESC, order_item_id`, keyset cursor `{age_seconds, order_item_id}`; `limit` ≤ 200. `age_seconds` uses `now()` inside the view, so cursor stability across pages is approximate (documented in UI help). Test labels from `catalog.v_pub_test_directory`. `open_route_id` is included only if `IdentityPort.getActor` permissions contain `lab.result.read`.

Backlog: `SELECT … FROM analytics.report_backlog WHERE tenant_id = $1 AND <scope>` (rebuilt by the refresh, §9.2).

Live-read guard: the live summary uses `SET LOCAL statement_timeout` via the core default (5 s); on `57014` the core maps to `503 common.dependency_unavailable` and the UI shows the error state with retry.

### 6.8 Quality, delivery, interfaces

Straight sums from `daily_rejections`, `daily_specimens` (received count for the denominator, aliquots excluded), `daily_critical_values` (per-day rows; totals: Σ detected, Σ notified, max of max), `daily_deliveries`, `daily_releases`, `daily_interface_messages`, each with the scope predicate (critical values and deliveries are centre-scoped since CR-C8-004/005). Instrument labels: `SELECT instrument_id, instrument_code, display_name, is_active FROM instruments.v_pub_instrument_directory WHERE tenant_id = $1` (`labels.repo.ts`; 08 R12d). Agents live: `SELECT agent_id, centre_id, state, last_heartbeat_at, agent_version, queue_depth FROM instruments.v_pub_agent_status WHERE tenant_id = $1 AND <scope>`.

## 7. Ports

### 7.1 Implemented

None. C8 owns no port (CM §5.1). Manifest `ports: {}`.

### 7.2 Consumed (signatures from IC §4; never re-declared)

| Port.method | Where | Purpose |
|---|---|---|
| `IdentityPort.assertRole(ctx, {permission, centreId?})` | every handler | authz (CV §10.1) |
| `IdentityPort.getActor(ctx)` → `ActorProfile` | `resolveScope`, link permissions | `centreScope`, `permissions` |
| `IdentityPort.getTenantSettings(ctx, {keys})` | referral report, exports/schedules containing it; UI calendar | `referralIncentiveReportEnabled`, `calendarDisplay`, `timezone` |
| `NotificationPort.sendEmailLink(ctx, SendBase & {linkUrl})` | `dispatch_schedules` (worker, system actor) | link-only email, no PHI in the body (CR-C8-007 adds C8 as consumer and purpose `scheduled_report_ready`). Template `analytics.report_ready`; `schedule_name` is C6 param kind `label_text` (≤ 80, plain text, no URLs — `://` or `www.` rejected — HTML-escaped; 08 A4.3). Recipient `{kind:'staff', membershipId, requiredPermission}` with `requiredPermission` from §3.3 (08 A4.2/A5.4, A7.6). `linkUrl` is an absolute URL with origin `LIMS_ORIGIN_STAFF_WEB` (param kind `staff_url`, 08 A13 D-29), built in §9.6 step 6. C6 resolves the staff recipient's e-mail through `IdentityPort.getStaffNotificationContact({membershipId, requiredPermission})` (CR-C6-018), not FrontdeskPort; `eligible: false` or `email: null` → `suppressed_no_contact`; Phase-1 suppression of staff recipients is lifted for purpose `scheduled_report_ready` only (08 A2.6 as corrected by A4.2) |
| `RenderPort.renderPdf(ctx, {templateKey:'analytics.report', data, idempotencyKey: export_id})` → `{contentBase64, sha256, byteSize, pageCount}` | `build_export` (pdf; worker, system actor only) | 03-IC §4.16 (08 R12c): data validated against `contracts/render/analytics.report.schema.json`, whose exact shape C8 defines in §10.2 step 6a (C0-0C transcribes it, as 08 A5.1 did for `partners.access_slip`); ≤ 5,000 rows (more → `failed` `analytics.export_too_large`, checked before the call). Error mapping: `reporting.render_unavailable` → task retry; `reporting.template_invalid` → `failed` `common.internal` + alert (a C8 data bug) [CONV: no more specific registered code]; `common.payload_too_large` (> 10 MB output) → `failed` `analytics.export_too_large`; `auth.forbidden` (non-system actor — a wiring bug) → `failed` `common.internal` + alert; C6 stores nothing — C8 writes the bytes to `analytics.export_files` |

Core (not ports): `ctx.core.tenant/branches/centres/centre/membership/user/membershipPermissions`, `ctx.core.memberships.list` (08 A17 D-47: staff names and the recipient picker, P-17), `ctx.audit.access`, `ctx.rateLimit.consume('general', …)` (core does this per request), `buildRoute` from `@lims/shared-ts/routes`.

## 8. Events

### 8.1 Produced

None (`produces: []`; IC §3.25 lists no C8-produced event).

### 8.2 Consumed (IC §3.25 rows listing C8) — `services/worker/src/jobs/analytics/consumers/`

All consumers run inside the core wrapper (C0 TRD §7.3: tenant tx, `analytics.event_inbox` dedupe on `event_id`, known-fields validation). Handlers perform only (a) `analytics.order_index` maintenance and (b) `markDirty(family, business_date)` upserts, then enqueue `analytics.refresh_tenant` (§9.3). They never take metric values from payloads. Because the effect is "mark dirty", they are **order-insensitive**: stale `aggregate.seq` checks (CV §7.4 step 3) are not needed and are deliberately not applied (DECISION D-C8-04; the nightly sweep is the safety net).

`bd(ts)` = `(ts::timestamptz AT TIME ZONE 'Asia/Kathmandu')::date` evaluated **in SQL** in the same statement (same expression as the views).

| Event | Handler effect | Families dirtied (date) |
|---|---|---|
| `frontdesk.order.created.v1` | order_index upsert (SQL below) | orders, centre_volume, referrer_volume @ bd(registered_at); report_backlog @ snapshot |
| `frontdesk.order.cancelled.v1` | `UPDATE analytics.order_index SET cancelled_at = $cancelled_at WHERE tenant_id = $t AND order_id = $o AND cancelled_at IS NULL`; if no row (order predates C8 or event reordering), insert a placeholder row `(tenant_id, order_id, cancelled_at, source_event_id, created_by, expires_at) VALUES ($t, $o, $cancelled_at, $event_id, $actor, now() + interval '400 days') ON CONFLICT (tenant_id, order_id) DO NOTHING` with `registered_at`/`registered_on` NULL — a later `order.created` fills the rest (upsert below) | orders, centre_volume, referrer_volume @ `registered_on` (if known); report_backlog |
| `billing.invoice.issued.v1` | — | income, department_income, referrer_billing @ bd(issued_at) |
| `billing.invoice.cancelled.v1` | — | income, department_income, referrer_billing @ bd(cancelled_at) |
| `lab.specimen.status_changed.v1` | — | specimens @ bd(changed_at); tat @ bd(changed_at) when `to_status ∈ {received, verified, rejected}`; rejections @ bd(changed_at) when `to_status ∈ {rejected, recollection_ordered}`; report_backlog |
| `lab.result.verified.v1` | — | results, tat @ bd(verified_at) |
| `lab.result.approved.v1` | — | results @ bd(approved_at); report_backlog |
| `lab.result.amended.v1` | — | results @ bd(amended_at) |
| `lab.critical_value.detected.v1` | — | critical_values, results @ bd(detected_at) |
| `instruments.agent.health_changed.v1` | — | interface_messages @ today (agent state itself is read live) |
| `reporting.report.released.v1` | — | releases, tat @ bd(released_at); report_backlog |
| `reporting.delivery.status_changed.v1` | — | deliveries @ bd(`delivery_created_at`) — the C6 view anchors every count on the delivery's creation date (cohort, 08 A17 D-48); when `delivery_created_at` is absent (optional field, R13 additive), deliveries @ bd(changed_at), and the nightly 40-day sweep corrects the cohort day (D-48) |

`order_index` upsert (`frontdesk.order.created.v1`; review #5 — completes a cancel-before-create placeholder, never overwrites a complete row):
```sql
INSERT INTO analytics.order_index (tenant_id, order_id, centre_id, branch_id, referrer_id, registered_at, registered_on,
       source_event_id, created_by, expires_at)
VALUES ($t, $o, $centre_id, $branch_id, $referrer_id, $registered_at, ($registered_at::timestamptz AT TIME ZONE 'Asia/Kathmandu')::date,
       $event_id, $actor, $registered_at::timestamptz + interval '400 days')
ON CONFLICT (tenant_id, order_id) DO UPDATE
   SET centre_id = EXCLUDED.centre_id, branch_id = EXCLUDED.branch_id, referrer_id = EXCLUDED.referrer_id,
       registered_at = EXCLUDED.registered_at, registered_on = EXCLUDED.registered_on, expires_at = EXCLUDED.expires_at
 WHERE analytics.order_index.registered_on IS NULL;
```
`$actor` = the analytics system actor id from the job claims (`sub`), used for every `created_by` written by C8's worker (review m#16). `expires_at` = `coalesce(registered_at, created_at) + 400 days` (08 A17 D-45).

`markDirty`:
```sql
INSERT INTO analytics.dirty_partitions (tenant_id, family, business_date, first_marked_at, last_marked_at, reason, created_by)
VALUES ($t, $family, $d, now(), now(), 'event', $actor)
ON CONFLICT (tenant_id, family, business_date) DO UPDATE SET last_marked_at = now();
```
(`report_backlog` uses the sentinel `business_date = '1970-01-01'` meaning "snapshot"; CHECK in 05-SCHEMA.) Then `app.enqueue_job('analytics.refresh_tenant', {tenant_id}, 'analytics.refresh_tenant:' || tenant_id, now() + interval '60 seconds', 5)` (debounce [CONV] `LIMS_ANALYTICS_DEBOUNCE_SECONDS`). Whether a second enqueue with the same `job_key` while a job is locked creates a new job depends on Graphile Worker 0.18.0 `job_key_mode` semantics (C0 SP-2, UNVERIFIED here); correctness does not depend on it because dirty rows persist and the 10-minute sweep processes leftovers.

Idempotency test per consumer: duplicate delivery (same `event_id`) → one inbox row, unchanged dirty row count; unknown extra payload fields ignored (CV §7.2).

Conditionally absent fields and open enums (08 A13 P-4/P-5): consumers read only the date fields of the table above and, for `order.created`/`order.cancelled`, the `order_index` columns. They tolerate the absence of `centre_id` on `billing.invoice.issued.v1` (periodic credit bills, D-1), of `specimen_id` and `verified_by_membership_id` on `lab.result.verified.v1` (D-2) and of `delivery_created_at` on `reporting.delivery.status_changed.v1` (D-48); none of those fields is read. `recipient_kind` (`x-extensible`, D-3 adds `phone_otp`) is not read from events; the `deliveries` refresh maps any value outside the known set to `other` (§9.2). Contract tests: an example payload without each optional field is accepted.

## 9. Background jobs

### 9.1 Families

| Family | Target table(s) | Source view | Date column in source | Replace granularity |
|---|---|---|---|---|
| `orders` | `daily_orders` | `frontdesk.v_pub_order_daily` | `business_date` | date range |
| `centre_volume` | `daily_centre_volume` | `frontdesk.v_pub_centre_volume` | `business_date` | date range |
| `referrer_volume` | `daily_referrer_volume` | `frontdesk.v_pub_referrer_volume` | `business_date` | date range |
| `income` | `daily_income` | `billing.v_pub_invoice_daily` | `business_date` | date range |
| `department_income` | `daily_department_income` | `billing.v_pub_department_income` | `business_date` | date range |
| `collections` | `daily_collections` | `billing.v_pub_payment_collection` (`payment_method_code` per IC; CR-C8-010) | `business_date` | date range |
| `referrer_billing` | `daily_referrer_billing` | `billing.v_pub_referrer_billing` | `business_date` | date range |
| `results` | `daily_results` | `lab.v_pub_result_daily` | `business_date` | date range |
| `specimens` | `daily_specimens` | `lab.v_pub_specimen_timeline` (aggregated) | `collected_at`, `received_at`, `rejected_at` | date range |
| `rejections` | `daily_rejections` | `lab.v_pub_rejection_daily` | `business_date` | date range |
| `critical_values` | `daily_critical_values` | `lab.v_pub_critical_value_daily` | `business_date` | date range |
| `tat` | `tat_facts` | `lab.v_pub_specimen_timeline`, `reporting.v_pub_order_report_tat` | stop timestamps | date range (by fact business_date) |
| `releases` | `daily_releases` | `reporting.v_pub_report_release` (aggregated) | `released_at` | date range |
| `deliveries` | `daily_deliveries` | `reporting.v_pub_delivery_daily` | `business_date` | date range |
| `interface_messages` | `daily_interface_messages` | `instruments.v_pub_message_daily` | `business_date` | date range |
| `report_backlog` | `report_backlog` | `analytics.order_index` + `reporting.v_pub_order_report_tat` + `lab.v_pub_specimen_timeline` | — | whole snapshot |

### 9.2 Partition replace (one transaction per family per contiguous date range; `refresh.repo.ts`)

```sql
-- Example: income, tenant $1, range [$2, $3), run $4
DELETE FROM analytics.daily_income WHERE tenant_id = $1 AND business_date >= $2 AND business_date < $3;
INSERT INTO analytics.daily_income (tenant_id, business_date, branch_id, centre_id, invoices_issued, invoices_cancelled,
       gross_paisa, discount_paisa, exempt_paisa, taxable_paisa, vat_paisa, other_tax_paisa, net_paisa, credit_notes_paisa,
       refresh_run_id, refreshed_at)
SELECT v.tenant_id, v.business_date, v.branch_id, v.centre_id, v.invoices_issued, v.invoices_cancelled,
       v.gross_paisa, v.discount_paisa, v.exempt_paisa, v.taxable_paisa, v.vat_paisa, v.other_tax_paisa, v.net_paisa,
       v.credit_notes_paisa, $4, now()
FROM billing.v_pub_invoice_daily v
WHERE v.tenant_id = $1 AND v.business_date >= $2 AND v.business_date < $3;
DELETE FROM analytics.dirty_partitions
 WHERE tenant_id = $1 AND family = 'income' AND business_date >= $2 AND business_date < $3 AND last_marked_at <= $run_started_at;
INSERT INTO analytics.refresh_state (tenant_id, family, last_success_at, last_attempt_at, last_error_code,
       consecutive_failures, last_run_id, created_by)
VALUES ($1, 'income', now(), now(), NULL, 0, $4, $actor)
ON CONFLICT (tenant_id, family) DO UPDATE
   SET last_success_at = now(), last_attempt_at = now(), last_error_code = NULL, consecutive_failures = 0, last_run_id = $4;
```
Failure path (separate transaction, §9.3): `INSERT INTO analytics.refresh_state (tenant_id, family, last_attempt_at, last_error_code, consecutive_failures, created_by) VALUES ($1, $family, now(), $code, 1, $actor) ON CONFLICT (tenant_id, family) DO UPDATE SET last_attempt_at = now(), last_error_code = EXCLUDED.last_error_code, consecutive_failures = analytics.refresh_state.consecutive_failures + 1`. `refresh_state` rows are created lazily on first use in any path (08 A17 P-22); a family with no row reports `never_refreshed` (PRD §8.5).
- Readers see old or new partitions, never a mix (MVCC).
- A dirty mark that arrives during the run (`last_marked_at > run_started_at`) survives and is processed next time.
- Specimens aggregation:
```sql
INSERT INTO analytics.daily_specimens (tenant_id, business_date, centre_id, processing_branch_id, specimen_type_code, priority,
       collected, received, rejected, refresh_run_id, refreshed_at)
SELECT tenant_id, d, centre_id, processing_branch_id, specimen_type_code, priority,
       count(*) FILTER (WHERE k = 'c'), count(*) FILTER (WHERE k = 'r'), count(*) FILTER (WHERE k = 'x'), $4, now()
FROM (SELECT tenant_id, centre_id, processing_branch_id, specimen_type_code, priority, 'c' AS k,
             (collected_at AT TIME ZONE 'Asia/Kathmandu')::date AS d FROM lab.v_pub_specimen_timeline
      WHERE tenant_id = $1 AND collected_at >= $from_ts AND collected_at < $to_ts AND parent_specimen_id IS NULL
      UNION ALL SELECT …, 'r', (received_at AT TIME ZONE 'Asia/Kathmandu')::date … WHERE received_at >= $from_ts AND received_at < $to_ts AND parent_specimen_id IS NULL
      UNION ALL SELECT …, 'x', (rejected_at AT TIME ZONE 'Asia/Kathmandu')::date … WHERE rejected_at >= $from_ts AND rejected_at < $to_ts AND parent_specimen_id IS NULL) s
GROUP BY tenant_id, d, centre_id, processing_branch_id, specimen_type_code, priority;
```
  with `$from_ts = ($2::timestamp AT TIME ZONE 'Asia/Kathmandu')`, `$to_ts = ($3::timestamp AT TIME ZONE 'Asia/Kathmandu')` (local midnights as instants). Aliquots (`parent_specimen_id IS NOT NULL`, CR-C8-004 accepted) are excluded, so M73 counts primary specimens only.
- TAT facts (`subject_id` = specimen_id or order_id). A stop timestamp can move to a later day (e.g. `final_released_at` when a second report family becomes final), so the fact's PK `(tenant_id, segment, subject_id)` may already exist outside the range (review #4). One transaction, three statements:
  1. `DELETE FROM analytics.tat_facts WHERE tenant_id = $1 AND business_date >= $2 AND business_date < $3;`
  2. `DELETE FROM analytics.tat_facts f WHERE f.tenant_id = $1 AND (f.segment, f.subject_id) IN (SELECT n.segment, n.subject_id FROM (<new-rows SELECT below>) n);` — removes the subject's fact on its old day;
  3. `INSERT INTO analytics.tat_facts … <new-rows SELECT below>`.
  Statements 2 and 3 evaluate the same SELECT; if the source changed between them and statement 3 raises `23505`, the transaction rolls back, the dirty marks stay and the task retries (§9.3). The old day's partition is correct afterwards because the fact simply moved.
```sql
INSERT INTO analytics.tat_facts (tenant_id, segment, subject_id, centre_id, processing_branch_id, priority, specimen_type_code,
       started_at, stopped_at, business_date, duration_seconds, is_anomaly, refresh_run_id, refreshed_at)
SELECT tenant_id, 'pre_analytical', specimen_id, centre_id, processing_branch_id, priority, specimen_type_code,
       collected_at, received_at, (received_at AT TIME ZONE 'Asia/Kathmandu')::date,
       floor(extract(epoch FROM (received_at - collected_at)))::bigint, received_at < collected_at, $4, now()
FROM lab.v_pub_specimen_timeline
WHERE tenant_id = $1 AND received_at >= $from_ts AND received_at < $to_ts AND collected_at IS NOT NULL AND rejected_at IS NULL
  AND parent_specimen_id IS NULL
UNION ALL
SELECT tenant_id, 'transport', specimen_id, centre_id, processing_branch_id, priority, specimen_type_code,
       in_transit_at, received_at, (received_at AT TIME ZONE 'Asia/Kathmandu')::date,
       floor(extract(epoch FROM (received_at - in_transit_at)))::bigint, received_at < in_transit_at, $4, now()
FROM lab.v_pub_specimen_timeline
WHERE tenant_id = $1 AND received_at >= $from_ts AND received_at < $to_ts AND in_transit_at IS NOT NULL AND rejected_at IS NULL
  AND parent_specimen_id IS NULL
UNION ALL
SELECT tenant_id, 'within_lab', specimen_id, centre_id, processing_branch_id, priority, specimen_type_code,
       received_at, first_verified_at, (first_verified_at AT TIME ZONE 'Asia/Kathmandu')::date,
       floor(extract(epoch FROM (first_verified_at - received_at)))::bigint, first_verified_at < received_at, $4, now()
FROM lab.v_pub_specimen_timeline
WHERE tenant_id = $1 AND first_verified_at >= $from_ts AND first_verified_at < $to_ts AND received_at IS NOT NULL AND rejected_at IS NULL
  AND parent_specimen_id IS NULL
UNION ALL
SELECT tenant_id, 'total_first_release', order_id, centre_id, NULL, NULL, NULL, registered_at, first_released_at,
       (first_released_at AT TIME ZONE 'Asia/Kathmandu')::date,
       floor(extract(epoch FROM (first_released_at - registered_at)))::bigint, first_released_at < registered_at, $4, now()
FROM reporting.v_pub_order_report_tat
WHERE tenant_id = $1 AND first_released_at >= $from_ts AND first_released_at < $to_ts AND registered_at IS NOT NULL
UNION ALL
SELECT tenant_id, 'total_final_release', order_id, centre_id, NULL, NULL, NULL, registered_at, final_released_at,
       (final_released_at AT TIME ZONE 'Asia/Kathmandu')::date,
       floor(extract(epoch FROM (final_released_at - registered_at)))::bigint, final_released_at < registered_at, $4, now()
FROM reporting.v_pub_order_report_tat
WHERE tenant_id = $1 AND final_released_at >= $from_ts AND final_released_at < $to_ts AND registered_at IS NOT NULL
  AND total_tat_seconds IS NOT NULL;     -- every report family of the order is final (review #4b; PRD M64)
```
Aliquots (`parent_specimen_id IS NOT NULL`) are excluded from the three specimen segments (CR-C8-004 accepted).
  Priority for order-level segments is not in `v_pub_order_report_tat`; those rows carry NULL priority/specimen type and are excluded when those filters are set (documented in UI help). For anomalies, `duration_seconds` is stored as `abs()`-free raw value and excluded from stats (`is_anomaly`).
- Releases aggregation: `SELECT tenant_id, (released_at AT TIME ZONE 'Asia/Kathmandu')::date, centre_id, report_kind, release_basis, count(*) … FROM reporting.v_pub_report_release WHERE released_at in range GROUP BY …`. `report_kind` may be `addendum` (08 R1; enum `x-extensible`, 08 R13): `addendum` is stored as its own value; any unknown future value is stored as `amended` for display (the documented consumer rule of `reporting.report.released.v1`).
- Results / critical values: straight copies of `lab.v_pub_result_daily` (incl. `centre_id`, `tests_approved`) and `lab.v_pub_critical_value_daily` (incl. `centre_id`) — CR-C8-004 accepted.
- Deliveries: copy of `reporting.v_pub_delivery_daily` incl. `centre_id` (CR-C8-005, D-48), with `recipient_kind` mapped `CASE WHEN v.recipient_kind IN ('patient','referrer','centre','partner','staff','phone_otp') THEN v.recipient_kind ELSE 'other' END` (08 A13 D-3: an unknown `x-extensible` value counts as `other`; the column has no closed CHECK, P-4) and summed over the mapped key.
- Report backlog (whole snapshot, `LIMS_ANALYTICS_BACKLOG_LOOKBACK_DAYS` = 30 [CONV]):
```sql
DELETE FROM analytics.report_backlog WHERE tenant_id = $1;
INSERT INTO analytics.report_backlog (tenant_id, centre_id, stage, age_bucket, orders, oldest_registered_at, refresh_run_id, refreshed_at)
WITH o AS (
  SELECT oi.order_id, oi.centre_id, oi.registered_at FROM analytics.order_index oi
  WHERE oi.tenant_id = $1 AND oi.cancelled_at IS NULL AND oi.registered_at >= now() - make_interval(days => $2)),
rel AS (
  SELECT r.order_id FROM reporting.v_pub_order_report_tat r
  WHERE r.tenant_id = $1 AND r.first_released_at IS NOT NULL AND r.registered_at >= now() - make_interval(days => $2)),
sp AS (
  SELECT s.order_id, bool_and(s.all_approved_at IS NOT NULL) AS all_approved
  FROM lab.v_pub_specimen_timeline s
  WHERE s.tenant_id = $1 AND s.status NOT IN ('rejected','recollection_ordered','discarded')
    AND s.order_id IN (SELECT order_id FROM o)
  GROUP BY s.order_id)
SELECT $1, o.centre_id,
       CASE WHEN sp.all_approved IS TRUE THEN 'ready_unreleased' ELSE 'awaiting_results' END,
       CASE WHEN now() - o.registered_at < interval '4 hours' THEN 'lt_4h' WHEN now() - o.registered_at < interval '24 hours' THEN 'h4_24'
            WHEN now() - o.registered_at < interval '3 days' THEN 'd1_3' ELSE 'gt_3d' END,
       count(*), min(o.registered_at), $3, now()
FROM o LEFT JOIN sp ON sp.order_id = o.order_id
WHERE o.order_id NOT IN (SELECT order_id FROM rel)
GROUP BY 2, 3, 4;
```
- Every family statement runs under the core transaction `statement_timeout` (5 s default, C0 TRD §6.4) except the two tasks with the `WorkerManifest.taskOptions` override (CR-C8-012 accepted; 08 §4.11): `analytics.sweep_nightly` and `analytics.backfill` run at 120 s (§9.4). Ranges are processed in chunks of `LIMS_ANALYTICS_SWEEP_CHUNK_DAYS` (7 [CONV]) for every task. CR-C8-011 (accepted) adds the expression indexes that make date-bounded view reads index-driven; their immutability on PostgreSQL 17 is UNVERIFIED (C0 confirms in the migration PR). Only if C0 reports them unusable does the nightly fall back to 1-day chunks; the performance test (§12) decides whether the 10-minute sweep must slow to 30 minutes.

### 9.3 Tasks

| Identifier | Trigger | Scope | max_attempts | Behaviour |
|---|---|---|---|---|
| `analytics.refresh_tenant` | consumers (debounced), `requestAnalyticsRefresh`, sweeps | per tenant (payload `{tenant_id}`) | 5 | `run_started_at = now()`; read `SELECT family, business_date FROM analytics.dirty_partitions WHERE tenant_id = $1 ORDER BY family, business_date` in a short read (no `FOR UPDATE`; no row locks on `dirty_partitions` are held, so consumers' `ON CONFLICT DO UPDATE` never waits); group into contiguous ranges per family (≤ `LIMS_ANALYTICS_SWEEP_CHUNK_DAYS` per transaction). Per family-range transaction: `SELECT pg_advisory_xact_lock(hashtext('analytics:' \|\| $tenant \|\| ':' \|\| $family))` [CONV], then §9.2 replace, then delete marks with `last_marked_at <= run_started_at` (review m#32; the guard keeps marks made during the run). Record a `refresh_runs` row per family (`expires_at = started_at + 90 days`); on failure upsert `refresh_state` (failure path §9.2) in a separate tx and rethrow (Graphile backoff) |
| `analytics.sweep_recent` | cron `*/10 * * * *` (UTC) | `per_tenant` | 3 | mark dirty: every family @ today; @ yesterday too while local time < 06:00 [CONV]; report_backlog snapshot; then run `refresh_tenant` logic inline |
| `analytics.sweep_nightly` | cron `45 20 * * *` (UTC = 02:30 Asia/Kathmandu) | `per_tenant` | 3 | mark all families dirty for `[today − 40 d, today)` [CONV `LIMS_ANALYTICS_NIGHTLY_DAYS`], run refresh; then enqueue `analytics.self_check` |
| `analytics.self_check` | after nightly | per tenant | 2 | for trailing 7 days and every family: compare Σ rollup vs Σ view (R3), Σ department vs income (R2), collections by method vs by staff (R4). Mismatch → re-mark the dates dirty, metric `lims_analytics_reconciliation_mismatch_total{rule,family}`, log `reconciliation_mismatch {family, business_date}`; never edits figures directly |
| `analytics.build_export` | `createAnalyticsExport` (enqueued in the same tx, `job_key = export_id`) | per tenant | 3 | §10 |
| `analytics.dispatch_schedules` | cron `*/15 * * * *` | `per_tenant` | 5 | §9.6 |
| `analytics.purge` | cron `15 21 * * *` (03:00 Asia/Kathmandu) | `per_tenant` | 3 | §9.5 |
| `analytics.backfill` | manual: `pnpm worker:enqueue analytics.backfill --tenant <id> --from <date> --to <date> [--family f]` (C0 replay/enqueue tooling) | per tenant | 3 | per 7-day step: seed `order_index` from `reporting.v_pub_order_report_tat` (SQL below; 08 A17 D-50), mark the range dirty and run refresh; used at first deploy and after a CR changes a source view |

All cron schedules are in the worker manifest (REQ-ARCH-042). Times are UTC 5-field (C0 TRD §7.2).

`analytics.backfill` order_index seed (08 A17 D-50; C8 is a listed consumer of the view, P-21). Seeded rows have `branch_id`/`referrer_id` NULL and serve `report_backlog` only; the view keeps only `state = 'open'` report rows, so cancelled orders are not seeded:
```sql
INSERT INTO analytics.order_index (tenant_id, order_id, centre_id, registered_at, registered_on, created_by, expires_at)
SELECT t.tenant_id, t.order_id, t.centre_id, t.registered_at, (t.registered_at AT TIME ZONE 'Asia/Kathmandu')::date, $actor,
       t.registered_at + interval '400 days'
FROM reporting.v_pub_order_report_tat t
WHERE t.tenant_id = $1 AND t.registered_at >= $from_ts AND t.registered_at < $to_ts
ON CONFLICT (tenant_id, order_id) DO NOTHING;
```

### 9.4 Worker manifest

```ts
export const manifest: WorkerManifest = {
  module: 'analytics',
  tasks: { 'analytics.refresh_tenant': refreshTenant, 'analytics.sweep_recent': sweepRecent, 'analytics.sweep_nightly': sweepNightly,
           'analytics.self_check': selfCheck, 'analytics.build_export': buildExport, 'analytics.dispatch_schedules': dispatchSchedules,
           'analytics.purge': purge, 'analytics.backfill': backfill },
  subscriptions: {
    'frontdesk.order.created.v1': onOrderCreated, 'frontdesk.order.cancelled.v1': onOrderCancelled,
    'billing.invoice.issued.v1': onInvoiceIssued, 'billing.invoice.cancelled.v1': onInvoiceCancelled,
    'lab.specimen.status_changed.v1': onSpecimenStatusChanged, 'lab.result.verified.v1': onResultVerified,
    'lab.result.approved.v1': onResultApproved, 'lab.result.amended.v1': onResultAmended,
    'lab.critical_value.detected.v1': onCriticalValueDetected, 'instruments.agent.health_changed.v1': onAgentHealthChanged,
    'reporting.report.released.v1': onReportReleased, 'reporting.delivery.status_changed.v1': onDeliveryStatusChanged,
  },
  crontab: [
    { identifier: 'analytics.sweep_recent',       schedule: '*/10 * * * *', tenantScope: 'per_tenant' },
    { identifier: 'analytics.sweep_nightly',      schedule: '45 20 * * *',  tenantScope: 'per_tenant' },
    { identifier: 'analytics.dispatch_schedules', schedule: '*/15 * * * *', tenantScope: 'per_tenant' },
    { identifier: 'analytics.purge',              schedule: '15 21 * * *',  tenantScope: 'per_tenant' },
  ],
  maxAttempts: { 'analytics.refresh_tenant': 5, 'analytics.build_export': 3, 'analytics.dispatch_schedules': 5 },
  taskOptions: { 'analytics.sweep_nightly': { statementTimeoutMs: 120000 },      // CR-C8-012 accepted (08 §4.11)
                 'analytics.backfill':      { statementTimeoutMs: 120000 } },
};
// services/api/src/modules/analytics/index.ts
export const manifest: ModuleManifest = { name: 'analytics', openapi: 'contracts/openapi/analytics.yaml', handlers, ports: {},
  produces: [], systemPermissions: [] };   // the system actor needs no permission: it calls no assertRole; NotificationPort/RenderPort
                                          // calls are system-context port calls (IC §4.6 "System actors hold the permissions declared")
```
Subscriptions equal IC §3.25 consumer lists for C8 (12 events; CI check C0 TRD §7.2).

### 9.5 Retention (`analytics.purge`; values B15-aware)

| Table (class) | Keep | Rule |
|---|---|---|
| `daily_*` rollups, `report_backlog` (R) | `retentionYears` (IdentityPort, default 5) + current FY | `DELETE … WHERE business_date < fiscalYearBs(today − retentionYears years).startsOn` |
| `tat_facts` (R) | 3 fiscal years [CONV] | by `business_date` |
| `order_index` (E) | 400 days [CONV] | `expires_at < now()`; `expires_at = coalesce(registered_at, created_at) + 400 days` (08 A17 D-45) |
| `refresh_runs` (E) | 90 days [CONV] | `expires_at < now()`; `expires_at = started_at + 90 days` (D-45) |
| `export_files` (E) | until `expires_at` or downloads exhausted | delete row; parent `exports.status = 'expired'` |
| `exports` (E, metadata) | 400 days [CONV] | `requested_at < now() − 400 days` (its `expires_at` column is the file expiry, not the row's); access_log keeps the audit ≥ 5 y (04 D11) |
| `report_runs`, `report_run_recipients` (E) | 400 days [CONV] | `expires_at < now()`; `expires_at = created_at + 400 days` (D-45) |
| `analytics.event_inbox` | 90 days | C0 core purge (C0 TRD §7.6) |

The purge runs in the `per_tenant` task as the module's system actor (08 A17 P-18(c)); every E-table DELETE policy is `<t>__delete__tenant` and allows only `actor_type = 'system'` plus the row's retention predicate (05-SCHEMA §3). No `lims_owner` DEFINER and no 08 §4.7 row are needed. `schedules` and `schedule_recipients` (M) are never deleted.

### 9.6 Schedule dispatch

1. `SELECT … FROM analytics.schedules WHERE tenant_id = $1 AND is_active AND next_run_at <= now() FOR UPDATE SKIP LOCKED LIMIT 50`.
2. For each: `slot_start = next_run_at`; compute period from `period_rule` relative to the slot's local date (`domain/schedule.ts`, pure, injected clock):

| period_rule | Period (local business dates, `[from,to)`) |
|---|---|
| `previous_business_day` | [slot_date − 1, slot_date) |
| `previous_7_days` | [slot_date − 7, slot_date) |
| `month_to_date_ad` | [first of slot A.D. month, slot_date) — if slot_date is the 1st, the previous A.D. month |
| `previous_ad_month` | previous A.D. calendar month |
| `month_to_date_bs` / `previous_bs_month` | same with B.S. months via `bsdate` |
| `fiscal_year_to_date` | [`fiscalYearBs(slot_date − 1).startsOn`, slot_date) |

2a. If `now() − slot_start > 24 h` [CONV] (worker down; 03-APP-FLOW X18), insert the run with `state = 'skipped_late'` (`ON CONFLICT … DO NOTHING` as step 4), send nothing, and go to step 7 — no burst of old e-mails (review m#19).
3. If `report_codes` contains `referral_incentive` and the tenant flag is off, **DECISION:** the run proceeds without that report and records `omitted_report_codes = ['referral_incentive']`; a pack whose only report is `referral_incentive` is not dispatched (run state `skipped_flag_off`).
4. `INSERT INTO analytics.report_runs (…, created_by, expires_at) VALUES (…, $actor, now() + interval '400 days') ON CONFLICT (tenant_id, schedule_id, slot_start) DO NOTHING RETURNING id` — no row → already dispatched → step 7. Each `report_run_recipients` row written in steps 5–6 carries a new `id`, the run's `schedule_id` (composite FK to `report_runs (tenant_id, id, schedule_id)`), `created_by = $actor` and `expires_at = now() + 400 days` (08 A17 D-45).
5. For each **active** recipient row (`schedule_recipients.is_active`, 08 A17 D-45): eligible iff `ctx.core.membership().isActive` and not locked, `membershipPermissions` ∋ `analytics.dashboard.read` (and ∋ every report-specific permission of the pack, else that recipient gets the run with those reports omitted). Ineligible → `report_run_recipients.outcome = 'skipped_ineligible'`.
6. Eligible → `NotificationPort.sendEmailLink(ctx, { recipient: {kind:'staff', membershipId, requiredPermission: 'analytics.dashboard.read' /* §3.3, 08 A4.2/A5.4 */}, templateCode: 'analytics.report_ready', purpose: 'scheduled_report_ready', params: { lab_name: tenant.displayName, schedule_name }, idempotencyKey: \`${schedule_id}:${slot_start}:${membership_id}\`, related: { entityType: 'report_run', entityId: report_run_id }, linkUrl: new URL(buildRoute('staff.analytics.report_run', { report_run_id }), cfg.staffWebOrigin).href })` — an absolute URL with origin `LIMS_ORIGIN_STAFF_WEB` (C6 param kind `staff_url`, 08 A13 D-29) — within the same transaction (NotificationPort writes its outbox row in `ctx.tx`, IC §4.8). Store `delivery_id` and `status` (`queued`/`suppressed_*`).
   - `schedule_name` is free text typed by staff; the service (and `schedules__name__ck`, 05-SCHEMA §4) mirrors C6 `label_text` (08 A4.3/A5.4): length 1–80, rejects `://` and `www.` (case-insensitive), and keeps its own rejection of digit sequences ≥ 7 and `@` [CONV] to keep phones/emails out; C6 validates params again (04 R5) — `schedule_name` uses C6 param kind `label_text` (≤ 80 characters, plain text, no URLs, HTML-escaped; 08 A4.3). C8 sends only `{kind:'staff', membershipId, requiredPermission}`; C6 resolves the e-mail address through `IdentityPort.getStaffNotificationContact` (08 A4.2). A name failing the rule → `400 common.validation_failed` at create/update (unchanged). `related: { entityType: 'report_run', entityId: report_run_id }` (`SendBase.related.entityType` += `report_run`, CR-C8-007 accepted in 08 R13).
7. `UPDATE analytics.schedules SET next_run_at = nextSlot(…), last_run_id = … WHERE …`.

`nextSlot`: daily → next local date at `send_time_local`; weekly → next `weekday`; `monthly_ad` → 1st of next A.D. month; `monthly_bs` → 1st of next B.S. month; converted to UTC with the fixed +05:45 offset of Asia/Kathmandu (DECISION; Nepal has no DST in the supported range — the golden-table period starts 2000 B.S.; any future offset change requires a CR).

### 9.7 Manual refresh

`requestAnalyticsRefresh` (user transaction; 08 A17 P-22 — the `_manual` row is the one row kind a user writes first, allowed by `refresh_state__insert__tenant_manual`, 05-SCHEMA §3):
```sql
INSERT INTO analytics.refresh_state (tenant_id, family, last_manual_at, created_by)
VALUES ($1, '_manual', now(), $actor_id)
ON CONFLICT (tenant_id, family) DO UPDATE SET last_manual_at = now()
 WHERE analytics.refresh_state.last_manual_at IS NULL
    OR analytics.refresh_state.last_manual_at < now() - make_interval(mins => $2)   -- $2 = LIMS_ANALYTICS_MANUAL_REFRESH_MINUTES (5)
RETURNING last_manual_at;
```
No row returned → throttled → `429 common.rate_limited` with `Retry-After` = seconds until `last_manual_at + 5 min` (read in the same tx). Otherwise mark the requested families dirty @ today (and yesterday before 06:00) with `reason = 'manual'` and enqueue `refresh_tenant` with `run_at = now()`. The first manual refresh of a tenant inserts the row; there is no seeding step (review #2).

## 10. Exports

### 10.1 Request (API, `createAnalyticsExport`)

1. `assertRole('analytics.data.export')` (privileged: aal2 + membership re-validation in C2).
2. Report permission (P-10 conditional, `+ registry[report_code].permission when the body names that report`): `assertRole(registry[report_code].permission)` immediately after the registry lookup (unknown code → `404 analytics.report_unknown` first); referral → flag check (`common.feature_disabled`). Hand-written test per branch.
3. `format = 'pdf'` and RenderPort not registered (`LIMS_ANALYTICS_PDF_ENABLED=false`) → `403 common.feature_disabled`.
4. Validate `params` with the same period/scope resolution as the report endpoint (errors identical).
5. Quota (domain quota, not a CV §10.3 tier): `SELECT count(*) FROM analytics.exports WHERE tenant_id = $1 AND requested_by_membership_id = $2 AND requested_at > now() - interval '1 hour'` ≥ 10 [CONV `LIMS_ANALYTICS_EXPORTS_PER_USER_HOUR`] → `429 common.rate_limited` (Retry-After = seconds until the oldest of those falls out); tenant: count with `requested_on = today` ≥ 50 [CONV `LIMS_ANALYTICS_EXPORTS_PER_TENANT_DAY`] → same.
6. Insert `analytics.exports` (status `queued`, scope snapshot `scope_all_centres`, `scope_centre_ids`, `params`, `downloads_allowed` = 3 [CONV]) → `ctx.audit.access({action:'data.export', entityType:'analytics_export', entityId, outcome:'allowed', detail:{report_code, format, phase:'request', from, to}})` → `app.enqueue_job('analytics.build_export', {tenant_id, export_id}, export_id)` → `202`.

### 10.2 Build (worker, `analytics.build_export`)

1. Load export row (`FOR UPDATE`); status ≠ `queued`/`building` → return.
2. Re-validate the requester: `ctx.core.membership({membershipId})` active and not locked; `membershipPermissions` ∋ `analytics.data.export` and the report permission; referral flag still on. Fail → status `failed`, `failure_code = 'auth.forbidden'` (or `common.feature_disabled`).
3. Effective scope = snapshot ∩ current membership scope (`allCentres`, `centreIds`); empty intersection → `failed` `auth.forbidden`.
4. Build rows with the **same service functions** as the API (`reports.service.ts`) passing the explicit scope (worker RLS is tenant-wide, so the scope argument is the enforcement — unit/probe tests cover it). Pending-tests export: the worker reads as the system actor, so C5 RLS does not narrow it; the explicit scope filters on `centre_id` (collection centre) only, because the view exposes no `processing_centre_id`. Exports list by collection centre; the screen (user transaction, C5 RLS, §6.7) also shows items received at the user's centres — file header says "Filtered by collection centre" (DECISION D-C8-08 as reworded by 08 A17 D-49).
5. Rows > 100,000 [CONV `LIMS_ANALYTICS_EXPORT_MAX_ROWS`] → `failed` `analytics.export_too_large`.
6. Write: XLSX via `XlsxWriter` (sheet "Report" + sheet "About" with the header block of PRD US-17.2), CSV via `CsvWriter` (header block as `#`-prefixed lines, then header row, then rows), PDF via `RenderPort.renderPdf({templateKey:'analytics.report', data, idempotencyKey: export_id})`, which returns the bytes (base64, ≤ 10 MB) — C8 decodes them and checks `sha256`; PDF exports are capped at 5,000 rows (RenderPort limit, 08 §4.14). Money columns as integer paisa **and** a formatted NPR column `amount_npr` with two decimals from `@lims/shared-ts/money` (no float maths). Every text cell passes `neutraliseFormula` from `@lims/shared-ts/spreadsheet` for XLSX, CSV and PDF data (08 R12e, A13 P-9; no module-local copy).
6a. `analytics.report` render data (C8 defines it; C0-0C transcribes it to `contracts/render/analytics.report.schema.json`; all objects `additionalProperties: false`; every string ≤ 200 characters):
```json
{ "tenantDisplayName": "string", "reportTitle": "string", "periodLabelAd": "string", "periodLabelBs": "string",
  "scopeLabel": "string", "generatedAtLocal": "string", "exportId": "uuid string", "exportedBy": "string",
  "freshnessNote": "string", "notStatutoryNote": "string",
  "columns": [ { "key": "string ^[a-z0-9_]{1,40}$", "label": "string", "kind": "text | count | paisa | seconds | bp" } ],   // 1–40
  "rows":    [ { "<column key>": "string | integer" } ] }                                                                     // 0–5,000
```
   Values are pre-formatted by C8 except `count`/`paisa`/`seconds`/`bp`, which are integers (the template formats them: paisa in lakh grouping, seconds as durations, bp as one-decimal percent). Required: every top-level key. RenderPort errors are mapped as §7.2.
7. `size_bytes` > 20 MB [CONV `LIMS_ANALYTICS_EXPORT_MAX_BYTES`] → `failed` `analytics.export_too_large`.
8. Insert `analytics.export_files (tenant_id, export_id, content, sha256, content_type, created_by, expires_at)` with `created_by = $actor` and `expires_at` = the export's new `expires_at` (review m#16); update export `status='ready'`, `ready_at`, `expires_at = now() + 24 h` [CONV], `row_count`, `size_bytes`, `sha256`.
8a. Final attempt: when `helpers.job.attempts >= helpers.job.max_attempts` (the C0 SP-2 mechanism for reading the attempt count; Graphile Worker 0.18.0 field names UNVERIFIED here) and the step fails, set `status = 'failed'`, `failure_code = 'common.internal'` in a separate tx before rethrowing (03-APP-FLOW E4; review m#19). Earlier attempts reset `building → queued` (E6).
9. DECISION D-C8-09: files are stored in Postgres (`bytea`), not Supabase Storage, because (a) they are small and short-lived, (b) Storage RLS with self-hosted claims is UNVERIFIED (04 D3), (c) RenderPort returns bytes to the caller, so no storage is needed for PDFs either (08 R12c). If they move to Storage later they use bucket `analytics-exports` under the 08 §4.8 rules (`ctx.storage`, CR-C2-011) after the SP-4 probe.

### 10.3 Download (`downloadAnalyticsExport`)

Served through the core streaming download helper (08 A13 P-2: `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff`, `Cache-Control: no-store`; the BFF proxies the stream; every call writes an access-log row; never a signed URL — the bytes are in Postgres anyway, D-C8-09). `SELECT … FROM analytics.exports WHERE tenant_id = $1 AND id = $2` under user RLS (policy: own rows only) → not found → 404. `status ≠ ready` → `409 analytics.export_not_ready` (queued/building) or `410 analytics.export_unavailable` (expired/failed/downloads exhausted). In one tx: `UPDATE analytics.exports SET downloads_used = downloads_used + 1 WHERE … AND downloads_used < downloads_allowed AND status = 'ready' RETURNING …` (0 rows → 410); stream `export_files.content`; `ctx.audit.access({action:'data.export', …, detail:{phase:'download', rows, sha256_prefix8}})`. When `downloads_used` reaches the limit the purge deletes the file at the next run.

## 11. Configuration keys (`config.ts`; env `LIMS_ANALYTICS_*`; global unless "tenant")

| Key | Default | Meaning |
|---|---|---|
| `LIMS_ANALYTICS_MAX_RANGE_DAYS` | 366 [CONV] | max period length for any report/export |
| `LIMS_ANALYTICS_DEBOUNCE_SECONDS` | 60 [CONV] | consumer → refresh delay |
| `LIMS_ANALYTICS_SWEEP_CHUNK_DAYS` | 7 [CONV] | dates per refresh transaction |
| `LIMS_ANALYTICS_NIGHTLY_DAYS` | 40 [CONV] | trailing window of the nightly sweep |
| `LIMS_ANALYTICS_STALE_DIRTY_MINUTES` | 20 [CONV] | stale rule |
| `LIMS_ANALYTICS_STALE_SUCCESS_MINUTES` | 30 [CONV] | stale rule |
| `LIMS_ANALYTICS_BACKLOG_LOOKBACK_DAYS` | 30 [CONV] | reports-pending window |
| `LIMS_ANALYTICS_YESTERDAY_UNTIL_LOCAL` | `06:00` [CONV] | sweep also refreshes yesterday until this local time |
| `LIMS_ANALYTICS_MANUAL_REFRESH_MINUTES` | 5 [CONV] | manual refresh throttle per tenant |
| `LIMS_ANALYTICS_EXPORTS_PER_USER_HOUR` | 10 [CONV] | quota |
| `LIMS_ANALYTICS_EXPORTS_PER_TENANT_DAY` | 50 [CONV] | quota |
| `LIMS_ANALYTICS_EXPORT_MAX_ROWS` | 100000 [CONV] | |
| `LIMS_ANALYTICS_EXPORT_MAX_BYTES` | 20971520 [CONV] | 20 MB |
| `LIMS_ANALYTICS_EXPORT_TTL_HOURS` | 24 [CONV] | |
| `LIMS_ANALYTICS_EXPORT_DOWNLOADS` | 3 [CONV] | |
| `LIMS_ANALYTICS_PDF_ENABLED` | false | true only when C6 ships RenderPort (03-IC §4.16; RenderPort has no phase stub, 08 R9) |
| `LIMS_ANALYTICS_MAX_SCHEDULES_PER_TENANT` | 20 [CONV] | active schedules per tenant; exceeded → `400 common.validation_failed`, `errors[0].path = ''` (#25) |
| `LIMS_ORIGIN_STAFF_WEB` (`cfg.staffWebOrigin`) | set by C1 (03-IC §7) | origin of the absolute `staff_url` in scheduled e-mails (§9.6 step 6, 08 A13 D-29); read only |
| `LIMS_ANALYTICS_TAT_RETENTION_FY` | 3 [CONV] | |
| Tenant (IdentityPort): `referralIncentiveReportEnabled` | false (C2 seed) | B13 flag |
| Tenant: `retentionYears` | 5 (04 I8, B15) | rollup retention |
| Tenant: `calendarDisplay`, `timezone` | `AD`, `Asia/Kathmandu` | display; tz banner |

## 12. Performance targets (derived from 04 §14; [CONV] targets, ASSUMPTION inputs)

Inputs (04 §14): 500 patients/day/lab; 20 centres; 5,000 order items/day; 15,000–25,000 result rows/day; peak hour 25 %; ~60 concurrent staff; N = 10 labs.

Rollup sizes per lab (ASSUMPTION — validated by the 1×/10× seed):
| Table | Rows/day | Arithmetic | Rows/year |
|---|---|---|---|
| `daily_orders`, `daily_income` | ≤ 20 | one per centre-day | ≤ 7,300 |
| `daily_department_income` | ≤ 200 | 20 centres × ≤ 10 departments | ≤ 73,000 |
| `daily_collections` | ≤ 240 | ~60 staff × ≤ 4 methods | ≤ 87,600 |
| `daily_referrer_volume` / `_billing` | ≤ 2,000 | 20 centres × ≤ 100 active referrers/day (ASSUMPTION) | ≤ 730,000 |
| `daily_results` | ≤ 3,000 | ≤ 10 branches × ≤ 300 tests/day | ≤ 1.1 M |
| `tat_facts` | ≈ 3,500 | ~1,000 specimens × 3 segments + 500 orders × 2 | ≈ 1.3 M |

| Operation | Target p95 | Reasoning |
|---|---|---|
| `getAnalyticsDashboard` (31 days, all centres) | ≤ 300 ms | ≤ 6 index range scans; largest = results 31 × 3,000 = 93k rows aggregated (index `(tenant_id, business_date)`) |
| other report GETs, ≤ 31 days | ≤ 500 ms | |
| report GETs, 366 days | ≤ 1.5 s | referrers 730k rows worst case → aggregation in SQL |
| `getTatReport` 366 days | ≤ 2 s | percentile sort over ≤ 1.3 M rows; index `(tenant_id, segment, business_date)` |
| live pending summary | ≤ 300 ms | C5 partial index `order_tests__tenant_id_pending__p_idx` |
| export ≤ 10,000 rows | ready ≤ 60 s p95 | |
| refresh lag after an evented change | ≤ 2 min p95 | debounce 60 s + run |
| `sweep_recent` per tenant | ≤ 30 s wall | 16 families × 1–2 dates; N = 10 → ≤ 5 min of worker time per hour per tenant |
| API load from dashboards | ≤ 0.1 req/s/lab | ≈ 5 dashboard users × 1 auto-refresh / 5 min [CONV] + interaction — negligible vs 6–12 req/s/lab (04 §14) |

Load test: seed generator at 1× and 10× (05-DoD §3.5), measure the targets above and the source-view scan times inside `sweep_recent`; if `sweep_recent` > 120 s per tenant at 1× before CR-C8-011, raise the sweep interval to 30 min by config and record in this TRD.

## 13. Observability

Logs (CV §9; no PHI; ids, family codes, dates, counts only):
| Event key | Fields |
|---|---|
| `analytics_refresh_run` | tenant_id, family, from, to, rows_written, duration_ms, outcome, run_id |
| `analytics_refresh_failed` | tenant_id, family, error_code, attempt |
| `reconciliation_mismatch` | tenant_id, rule, family, business_date, diff_paisa (amount allowed: aggregate, not patient-linked) |
| `analytics_export_requested` / `_built` / `_downloaded` / `_failed` | tenant_id, export_id, report_code, format, rows, size_bytes, failure_code |
| `analytics_schedule_dispatched` | tenant_id, schedule_id, run_id, recipients_sent, recipients_skipped |

Metrics:
| Metric | Type | Labels |
|---|---|---|
| `lims_analytics_refresh_duration_seconds` | histogram | family |
| `lims_analytics_refresh_failures_total` | counter | family |
| `lims_analytics_family_stale` | gauge 0/1 | tenant_id, family |
| `lims_analytics_dirty_partitions` | gauge | family |
| `lims_analytics_reconciliation_mismatch_total` | counter | rule, family |
| `lims_analytics_exports_total` | counter | tenant_id, format, outcome |
| `lims_analytics_export_rows` | histogram | report_code |
| `lims_analytics_export_downloads_total` | counter | tenant_id |
| `lims_analytics_schedule_sends_total` | counter | outcome |
| standard `lims_http_*`, `lims_jobs_*` | | (CV §9.4) |

#### Alert rules for C1 (08 A13 P-14)

C8 keeps the rule file in its own path, `services/worker/src/jobs/analytics/ops/analytics.rules.yml` [CONV], and C1 wires it into `infra/` through **CR-C8-015** (§16). Routes are C1's receivers (C1 02-TRD §11.3: `page` → `oncall-email`, `warn` → `ops-digest-email`). Thresholds are the existing [CONV] values.

| Alert | expr | for | severity | route |
|---|---|---|---|---|
| `AnalyticsFamilyStale` | `max by (tenant_id, family) (lims_analytics_family_stale) == 1` | 60m | warn | `ops-digest-email` |
| `AnalyticsRefreshFailing` | `sum by (family) (increase(lims_analytics_refresh_failures_total[30m])) >= 3` | 0m | page | `oncall-email` |
| `AnalyticsReconciliationMismatch` | `sum by (rule, family) (increase(lims_analytics_reconciliation_mismatch_total[15m])) > 0` (money integrity) | 0m | page | `oncall-email` |
| `AnalyticsExportSpike` (REQ-SEC-045/133) | `sum by (tenant_id) (increase(lims_analytics_exports_total[24h])) > 3 * (sum by (tenant_id) (increase(lims_analytics_exports_total[14d])) / 14) and sum by (tenant_id) (increase(lims_analytics_exports_total[24h])) >= 10` | 0m | page (security owner) | `oncall-email` |
| `AnalyticsConsumerDeadLetter` | `increase(lims_core_dead_letters_total{task=~"(evt\\.)?analytics\\..*"}[5m]) > 0` | 0m | warn | `ops-digest-email` |

The earlier per-user condition "any single user ≥ 20 downloads in 24 h" cannot be a metric rule: metrics never carry membership ids (§13 above; CV §9.4). Per-user downloads are bounded by design (≤ 10 exports/h × 3 downloads) and every download is in `access_log`; a per-user spike rule needs an access-log based detector, which is not specified here (open, reported to the lead).

#### CI jobs for C0-0A (08 A13 P-14)

| Job id | Trigger paths | Runner OS | Command |
|---|---|---|---|
| `c8-no-commission` | `services/api/src/modules/analytics/**`, `services/worker/src/jobs/analytics/**`, `apps/web/src/features/analytics/**`, `apps/web/src/app/(staff)/analytics/**`, `docs/manual/analytics/**`, `services/renderer/templates/analytics/**` | Linux (standard CI image) | `services/api/src/modules/analytics/__tests__/ci/no-commission.sh` — fails on any case-insensitive `commission` in those paths (PRD US-07.3) [CONV script name] |

#### Access log (08 A13 P-3)

Every `ctx.audit.access` call, as operation → `action` → `entityType`; both actions are in the 03-IC §13.1 seed and no other action is used by C8:

| Operation | action | entityType | detail |
|---|---|---|---|
| `getReferralIncentiveReport` (#8) | `referral_report.view` (CR-C8-006) | `analytics_report` | `{report_code, from, to, rows}` |
| `createAnalyticsExport` (#20) | `data.export` | `analytics_export` | `{report_code, format, phase: 'request', from, to}` |
| `downloadAnalyticsExport` (#23) | `data.export` | `analytics_export` | `{phase: 'download', rows, sha256_prefix8}` |

## 14. Error codes used

From IC §8: `common.validation_failed`, `common.invalid_cursor`, `common.not_found`, `common.version_conflict`, `common.precondition_required`, `common.idempotency_key_required`, `common.idempotency_key_reused`, `common.idempotency_in_progress`, `common.date_out_of_range`, `common.feature_disabled`, `common.rate_limited`, `common.internal`, `common.dependency_unavailable`, `auth.forbidden`, `auth.mfa_required`, `auth.account_locked`, `auth.session_expired`, `analytics.range_too_large`, `analytics.report_unknown`.
New (CR-C8-002): `analytics.export_not_ready` (409), `analytics.export_unavailable` (410), `analytics.export_too_large` (422), `analytics.recipient_ineligible` (422). C8 emits only `analytics.*` codes it owns plus core-emitted `common.*`/`auth.*` (IC §8 rule).

## 15. Test strategy

| Layer | What | Fakes / data |
|---|---|---|
| Unit | `period.ts` (golden-table-driven B.S. month/FY bounds, max range, previous period, `bs_month` grouping sums); `scope.ts`; `families.ts` event→dirty mapping; `metrics.ts` (M03, M12, M72 bp rounding, deltas); `schedule.ts` slots incl. B.S. month rollover and 18:15 UTC boundary; `csv.ts` (RFC 4180 quoting, BOM; the neutralisation corpus is C0-0A's golden test of `@lims/shared-ts/spreadsheet` — C8 keeps an integration check that both writers and the PDF data builder call `neutraliseFormula`); `freshness.ts`; mappers (field allowlists) | none |
| Integration (DB) | partition replace correctness and atomicity; `rollups_equal_views` for every family over seeded data; R2/R4 (R1 `income_reconciles_to_registers` is an **M6 integration gate only**, run against the real C4 module's B24 `getSalesRegister` Σ `total` and B26 `getCreditNoteRegister` Σ `net` — seeded views would make it tautological; review m#30); TAT exclusion rules (aliquots, rejected, missing endpoints, partial final release); "final release moves to a later day" (review #4: PK conflict avoided, fact moves); backlog stages; manual-refresh throttle on a tenant with no `refresh_state` row (first call 202, second 429); consumers (duplicate, unknown fields, out-of-order, cancel-before-create placeholder); quota and download limit races (two parallel downloads at limit → one 410) | compose Postgres + C0 seed views; fake event publisher |
| Contract — HTTP | every operation validated against `analytics.yaml` (request + response), one test per `x-error-codes` entry | fastify-openapi-glue validation |
| Contract — ports consumed | IdentityPort / NotificationPort / RenderPort fakes from `@lims/fakes` (programmable aal, flags, failures) | `@lims/fakes` |
| Contract — events consumed | each IC §3 example payload + unknown fields + duplicate delivery | ajv known-fields |
| Probes | §5 of `07-SECURITY.md`: cross-tenant for all 30 operations and all owned tables; cross-centre for every report; export/run scope; partner/portal/patient claims read 0 rows (P-16) | two synthetic tenants × 2 centres |
| UI | component tests per screen state (empty/loading/error/stale/permission-denied/tenant-wide-only); axe scan; E2E: owner opens dashboard → switches to B.S. month → exports XLSX → downloads | MSW 3.0.3 mocks from the spec; Prism 5.16.0 |
| Copy lint | CI grep: no `/commission/i` in C8 paths (PRD US-07.3) | — |
| Performance | §12 targets at 1× and 10× | seed generator |

## 16. Change requests raised

> Status per `program/08-CR-REGISTER.md` (2026-11-06). CR texts below are kept as history.

| CR | Status |
|---|---|
| CR-C8-001 | ACCEPTED in 08 |
| CR-C8-002 | ACCEPTED in 08 |
| CR-C8-003 | ACCEPTED in 08 |
| CR-C8-004 | ACCEPTED in 08 |
| CR-C8-005 | ACCEPTED in 08 |
| CR-C8-006 | ACCEPTED-MODIFIED in 08 — Code `referral_report.view` (2-segment rule, R20). |
| CR-C8-007 | ACCEPTED in 08 |
| CR-C8-008 | ACCEPTED-MODIFIED in 08 — Route `staff.analytics.exports` permission renamed `analytics.data.export` (R19). |
| CR-C8-009 | MERGED in 08 into CR-C4-004 |
| CR-C8-010 | ACCEPTED in 08 |
| CR-C8-011 | ACCEPTED in 08 |
| CR-C8-012 | ACCEPTED in 08 |
| CR-C8-013 | ACCEPTED in 08 |
| CR-C8-014 | ACCEPTED in 08 |
| CR-C8-015 | RAISED 2026-11-06 (08 A13 P-14) — C1 wires `services/worker/src/jobs/analytics/ops/analytics.rules.yml` and C0-0A wires CI job `c8-no-commission` (§13); awaiting 08 register row |
| Review fix pass | Review fix pass 2026-11-06 — review/C8-analytics-mis.md + 08 Addendum A17 (plus A13 rules P-1…P-15 that apply to C8) applied. A17: P-16 (`pred_t` with `app.is_staff_or_system()`), P-17/D-47 (staff names, recipient picker), P-18/D-45 (E classes, `expires_at`, `__delete__tenant`, mandatory-column exceptions, `schedule_recipients` M), P-21, P-22 (lazy `refresh_state`, `_manual` INSERT policy), D-44 (top referrers volume only), D-46 (#30, collections route), D-48 (delivery cohort anchor + `centre_id`), D-49 (live pending = C5 RLS), D-50 (`order_index` seed), D-51 (not a consumer of `v_pub_credit_party_statement`); A16.1 cast; A13: P-1, P-2, P-3, P-4/D-3, P-5/D-1/D-2, P-6, P-9, P-10, P-14, P-15, D-29; A7.6. CR-C8-004/005/012/013 now built as accepted (no "until CR" branches). |
| 08 Addendum A4/A5 | 08 Addendum A4/A5 applied 2026-11-06 — A4.2/A5.4: staff recipient `{kind:'staff', membershipId, requiredPermission}`, `requiredPermission` from §3.3 registry (`analytics.dashboard.read`; `analytics.report.read` does not exist); C6 resolves via `IdentityPort.getStaffNotificationContact`. A4.3: `schedule_name` = C6 kind `label_text` (not `short_text`). A5.4: `schedules__name__ck` = length 1–80, no `://` / `www.` (case-insensitive), no `@`, no 7-digit run. Other A4/A5 items: no C8 impact. |
| 08 Addendum A2/A3 | 08 Addendum A2/A3 applied 2026-11-06 — A2.6: template code `analytics.report_ready` (was `analytics_report_ready`), `schedule_name` = C6 param kind `short_text` (≤ 80; superseded by A4.3 → `label_text`), staff recipient e-mail resolved by C6 through `IdentityPort` for purpose `scheduled_report_ready`, link-only, no PHI. A2.7: C8 is not a consumer of `engagement.v_pub_booking_daily` / `v_pub_queue_daily` (C8 docs never consumed them; nothing removed); booking/queue tiles = future additive C8 CR after C16 ships. A3: no C8 impact. |

**08 Addenda applied (08 A25 P-60: one row per addendum A1–A29; final check 2026-11-06)**

| Addendum | Status for C8 |
|---|---|
| A1 | not applicable |
| A2 | applied 2026-11-06 — A2.6, A2.7 (PRD, TRD, PLAN) |
| A3 | not applicable |
| A4 | applied 2026-11-06 — A4.2, A4.3 (PRD, TRD, AF, SCH, PLAN, SEC) |
| A5 | applied 2026-11-06 — A5.1, A5.4 (PRD, TRD, UI, SCH, PLAN, SEC) |
| A6 | not applicable |
| A7 | applied 2026-11-06 — A7.6 (TRD, AF) |
| A8 | not applicable |
| A9 | not applicable |
| A10 | not applicable |
| A11 | not applicable |
| A12 | not applicable |
| A13 | applied 2026-11-06 — P-1, P-2, P-3, P-4, P-5, P-6, P-9, P-10, P-14, P-15, D-1, D-2, D-3, D-13, D-29 (PRD, TRD, AF, SCH, PLAN, SEC) |
| A14 | not applicable |
| A15 | not applicable |
| A16 | applied 2026-11-06 — A16.1 (TRD, SCH, SEC) |
| A17 | applied 2026-11-06 — P-16, P-17, P-18, P-21, P-22, P-23, D-44, D-45, D-46, D-47, D-48, D-49, D-50, D-51 (PRD, TRD, AF, UI, SCH, PLAN, SEC) |
| A18 | not applicable |
| A19 | not applicable (A19 P-40 cites this chunk's existing port idempotency keys as already compliant; D-106/D-109/D-110/D-123 change other chunks or program docs) |
| A20 | not applicable |
| A21 | not applicable |
| A22 | not applicable |
| A23 | not applicable |
| A24 | not applicable |
| A25 | not applicable (D-200 reuses C8's CR-C8-012 `taskOptions`; no C8 change) |
| A26 | not applicable |
| A27 | not applicable |
| A28 | not applicable |
| A29 | not applicable |


Designed as if accepted; each is non-blocking unless stated, with the default built meanwhile.

```
Title: CR-C8-001: Permission codes analytics.collections.read and analytics.schedule.manage
From chunk: C8            To owner: C0-0C (contracts/permissions.yaml)
Type: api                  Blocking? no — default: both checks fall back to analytics.dashboard.read in the fake registry
Problem: Collections by staff/method (PRD US-08) must not be visible to every analytics.dashboard.read holder (lab_manager);
  schedules send to other staff (US-18) and need their own grant. IC §11 has neither.
Proposed: - { code: analytics.collections.read, privileged: false, roles: [owner_viewer, tenant_admin, finance] }
          - { code: analytics.schedule.manage,  privileged: false, roles: [owner_viewer, tenant_admin] }
Backward compatible? yes (additive). Tenant/security impact: narrows access. Tests: role matrix tests in probes.
```
```
Title: CR-C8-002: Error codes for analytics exports and schedules
From chunk: C8            To owner: C0-0C (contracts/errors.yaml)
Type: api                  Blocking? no
Proposed entries:
- { code: analytics.export_not_ready,   http: 409, owner: C8, title: "Export not ready", meaning: "Queued or building" }
- { code: analytics.export_unavailable, http: 410, owner: C8, title: "Export no longer available", meaning: "Expired, failed or download limit reached" }
- { code: analytics.export_too_large,   http: 422, owner: C8, title: "Export too large", meaning: "Row or size cap exceeded; narrow the period" }
- { code: analytics.recipient_ineligible, http: 422, owner: C8, title: "Recipient not eligible", meaning: "Membership inactive or lacks the report permission" }
Backward compatible? yes. Tests: one per code (CV §11.4).
```
```
Title: CR-C8-003: Table class R (derived rollup) in 02-CONVENTIONS §5.2
From chunk: C8            To owner: doc owner + C0-0B
Type: schema               Blocking? no — DDL in C8 05-SCHEMA already follows the proposed class
Problem: analytics.daily_* and tat_facts are rebuildable aggregates replaced by delete+insert. Class E requires id + expires_at;
  class M requires version/updated_*; neither fits, and a per-row UUID on ~2 M rows/lab/year is pure overhead.
Proposed: Class R — derived, rebuildable from v_pub_* views; natural composite PK with tenant_id leading; mandatory columns
  tenant_id, refresh_run_id, refreshed_at; INSERT/DELETE only by the owning module's system actor (RLS on actor_type = 'system');
  no UPDATE; no audit trigger (source tables are audited); excluded from audit_log.
Backward compatible? yes. Security: RLS still tenant + centre on SELECT.
```
```
Title: CR-C8-004: lab published views — centre and test-level columns, aliquot parent
From chunk: C8            To owner: C0-0B (C5 must agree)
Type: schema               Blocking? no — default: results and critical-value sections tenant-wide only; aliquots counted
Problem: 00 F1 "tests done" per centre and for centre-restricted users needs centre_id; counts are analyte-level (results),
  not tests; TAT/received counts need to exclude aliquots (IC §10.1 S5 aliquots start at received).
Proposed (additive columns, IC §6.3):
  lab.v_pub_result_daily: + centre_id (order's collection centre; grouping key), + tests_approved bigint
      (order tests whose status became 'approved' on business_date)
  lab.v_pub_critical_value_daily: + centre_id (grouping key)
  lab.v_pub_specimen_timeline: + parent_specimen_id
Backward compatible? yes (new grouping key splits rows; C9/C12 consumers that sum are unaffected; C5/C9/C12 to confirm).
Tenant/security impact: none (ids only). Tests: view returns per-centre rows; sums unchanged.
```
```
Title: CR-C8-005: reporting.v_pub_delivery_daily centre_id + anchor definitions for C6 views
From chunk: C8            To owner: C0-0B (C6 must agree; C6 docs not yet written)
Type: schema               Blocking? no — default: delivery stats tenant-wide only
Proposed: v_pub_delivery_daily + centre_id (report's order centre; NULL for non-report deliveries); C6 05-SCHEMA states that
  business_date = Asia/Kathmandu date of the transition into each status column; v_pub_order_report_tat has one row per
  registered order once C6 has created its report shell (else C8 relies on analytics.order_index — no change needed).
Backward compatible? yes.
```
```
Title: CR-C8-006: access-log action code analytics.referral_report.view
From chunk: C8            To owner: C0-0B (audit.g_cs_access_actions seed)
Type: schema               Blocking? no — default: data.export with detail.phase='view' until merged
Problem: viewing the referral business report is a sensitive read (04 L19; REQ-SEC-096) distinct from export.
Proposed: seed row ('analytics.referral_report.view', 'Referral business report viewed').
```
```
Title: CR-C8-007: C8 as NotificationPort consumer; purpose scheduled_report_ready; template analytics.report_ready
From chunk: C8            To owner: C0-0C (C6 must agree)
Type: port                 Blocking? no — default: fake NotificationPort records sends; dispatcher runs against it
Problem: Scheduled MIS (PRD US-18) must go through the only messaging gateway (CM §5.1); C8 is not a listed consumer and
  NotificationPurpose has no value for it.
Proposed: CM §5.1 / IC §4.8 consumers + C8; NotificationPurpose += 'scheduled_report_ready'; SendBase.related.entityType
  += 'report_run' (optional); C6 template registry: analytics.report_ready (08 A2.6 code; channel email; params lab_name ≤ 100, schedule_name ≤ 80 [C6 kind label_text, 08 A4.3];
  body "Your scheduled report <schedule_name> from <lab_name> is ready. Sign in to view: <link>"); recipient kind staff only (`{kind:'staff', membershipId, requiredPermission}`, 08 A4.2).
Backward compatible? yes (union/enum extension). Security: link-only (04 R5, S20); params non-PHI; staff recipients only.
```
```
Title: CR-C8-008: routes.yaml entries for analytics pages
From chunk: C8            To owner: C0-0C
Type: api                  Blocking? no — default: only staff.analytics.dashboard exists; other pages reachable from the dashboard
Proposed (origin staff_web, owner C8):
  - { id: staff.analytics.reports,            path: /analytics/reports,                       permission: analytics.dashboard.read }
  - { id: staff.analytics.referral_incentive, path: /analytics/referral-incentive,            permission: analytics.referral_report.read }
  - { id: staff.analytics.exports,            path: /analytics/exports,                       permission: analytics.export }
  - { id: staff.analytics.schedules,          path: /analytics/schedules,                     permission: analytics.schedule.manage }
  - { id: staff.analytics.report_run,         path: /analytics/report-runs/{report_run_id},   permission: analytics.dashboard.read }
Backward compatible? yes. Security: params are UUIDs only (IC §7 rule).
```
```
Title: CR-C8-009: RenderPort template key analytics.report + path services/renderer/templates/analytics/
From chunk: C8            To owner: C0-0C + C6 + doc owner (extends CR-C4-004)
Type: port                 Blocking? no — default: format=pdf → common.feature_disabled
Proposed: RenderPort.renderPdf templateKey union += 'analytics.report'; C8 owns services/renderer/templates/analytics/**
  (bundled assets only, REQ-SEC-086); data = {header block, columns, rows ≤ 5,000 for PDF [CONV]}.
```
```
Title: CR-C8-010: billing.v_pub_payment_collection column name
From chunk: C8            To owner: C0-0B (C4 to align its 05-SCHEMA §6)
Type: schema / bug         Blocking? no
Problem: IC §6.2 names the column payment_method_code; C4 05-SCHEMA §6 view SQL selects method_code without alias.
  IC has precedence (00-README); C8 reads payment_method_code.
Proposed: C0 DDL uses `method_code AS payment_method_code`; C4 updates its document.
```
```
Title: CR-C8-011: Expression indexes so date-bounded reads of v_pub views use indexes
From chunk: C8            To owner: C0-0B (C4, C5, C6, C7 agree)
Type: schema (performance) Blocking? no — default: 1-day chunks; sweep interval configurable
Problem: views group by (ts AT TIME ZONE 'Asia/Kathmandu')::date; C8's predicate on business_date can only use an index on that
  expression; otherwise each refresh scans the tenant's whole fact table (lab.results ≈ 9 M rows/lab/year at 25k/day, 04 §14).
Proposed: CREATE INDEX CONCURRENTLY … ON billing.invoices (tenant_id, ((issued_at AT TIME ZONE 'Asia/Kathmandu')::date));
  likewise billing.invoices(cancelled_at), billing.credit_notes(issued_at), billing.invoice_lines via invoices, billing.ledger_entries
  (business_date — plain column), billing.credit_charges(charged_at), frontdesk.orders(registered_at), lab.results(first_resulted_at),
  lab.verifications(occurred_at), lab.approvals(occurred_at), lab.critical_value_log(detected_at), lab.specimens(collected_at,
  received_at, rejected_at — plain timestamptz indexes suffice for C8's range predicates on the timeline view), reporting/instruments
  equivalents. Immutability of timezone(text, timestamptz) for index expressions: UNVERIFIED here — C0 confirms on PG 17 in the migration
  PR (if not immutable, owners expose a stored business_date column like billing.ledger_entries already has).
Tests: EXPLAIN of each C8 refresh query shows an index scan on the seeded 10× dataset.
```
```
Title: CR-C8-012: Per-task statement timeout override in WorkerManifest
From chunk: C8            To owner: C0-0D
Type: shared-lib           Blocking? no — default: 1-day chunks within 5 s
Proposed: WorkerManifest.taskOptions?: { [task]: { statementTimeoutMs?: number (≤ 300000) } } applied via set_config in the task tx.
```
```
Title: CR-C8-013: UI kit additions PeriodPicker, DurationText, FreshnessBadge
From chunk: C8            To owner: C0-0D
Type: ui-kit               Blocking? no — default: composed locally from Select + DateRangePicker + Badge + Tooltip (04-UI-UX §2)
Proposed: PeriodPicker {value: PeriodValue; presets: ('today'|'yesterday'|'this_bs_month'|'last_bs_month'|'this_fy'|'last_fy'|
  'this_ad_month'|'last_ad_month'|'custom')[]; calendar}; DurationText {seconds; style: 'short'|'long'};
  FreshnessBadge {refreshedAt?: IsoUtc; isStale: boolean; reason?}. C4 (daily cash by B.S. date) can reuse PeriodPicker.
```
```
Title: CR-C8-015: Alert rules and CI job for C8 (08 A13 P-14)
From chunk: C8            To owner: C1 (alert rules) + C0-0A (CI job)
Type: infra/CI             Blocking? no — until wired, the rules are reviewed in the PR and the script runs locally
Proposed: C1 includes services/worker/src/jobs/analytics/ops/analytics.rules.yml (the five rules of §13 "Alert rules for C1",
  thresholds verbatim) in its Prometheus rule set, adding team and runbook_url; replaces any C8 row in C1 02-TRD §11.3 "Imported rules".
  C0-0A adds job c8-no-commission (§13 "CI jobs for C0-0A") to the PR pipeline.
Backward compatible? yes.
```
```
Title: CR-C8-014: One repo-wide pin of write-excel-file 4.1.1
From chunk: C8            To owner: C0-0A (dependency review)
Type: shared-lib           Blocking? no
Proposed: C3 and C8 (and C4 BL-T19) use the same exact version; C0 records it in its dependency review (CV §15.1).
```
