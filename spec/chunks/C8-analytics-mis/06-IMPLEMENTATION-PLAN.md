# C8 Analytics & MIS — 06 Implementation Plan

Status: DECISION, 2026-11-06. One task ≈ one PR (CV §12). Branch `c08/<topic>`. Every task's tests are written in the same PR. "AC" = acceptance criterion in `01-PRD.md` (US-nn.k).

Pre-conditions (C0 deliveries, not C8 tasks): `analytics` DDL/RLS from `05-SCHEMA.md` (C0 T0B-10.C8), `contracts/openapi/analytics.yaml` from `02-TRD.md` §5 (T0C-10.C8), event schemas, fakes (`IdentityPort`, `NotificationPort`, RenderPort if CR-C4-004 lands), seed views over synthetic source tables, worker/API cores. Until a CR is merged, the task uses the stated default.

## 1. Task list

| ID | Goal | Files / paths | Depends on | Done when | Tests | ACs |
|---|---|---|---|---|---|---|
| AN-T01 | Module skeletons + manifests | `services/api/src/modules/analytics/{index,permissions,config}.ts`, handlers stubs (all 30 operationIds returning `501` only in dev via core stub), `services/worker/src/jobs/analytics/index.ts` (subscriptions + crontab), `apps/web/src/features/analytics/nav.manifest.ts` | C0 cores | API boots with all operationIds mapped; worker manifest passes C0 CI check (subscriptions = IC §3.25 C8 list) | boot test; manifest CI | — |
| AN-T02 | Domain: period, scope, freshness, metrics, csv | `domain/{period,scope,freshness,metrics,csv,reportRegistry,families}.ts` (csv = RFC 4180 quoting only; `neutraliseFormula` is imported from `@lims/shared-ts/spreadsheet`, 08 A13 P-9) | AN-T01; C0-0A `@lims/shared-ts/spreadsheet` | pure functions complete | unit: golden-table B.S. month/FY bounds; 18:15 UTC boundary; max range; previous period; bs_month grouping exact sums; stale rule; families map; registry permissions (top_referrers family = referrer_volume only, D-44). The formula-injection corpus is C0-0A's golden test; C8 adds only the writer integration check in AN-T15 | US-02.1–7, US-16.2, US-17.3 |
| AN-T03 | Context service (resolvePeriod/resolveScope) + error mapping | `service/context.service.ts` | AN-T02, IdentityPort fake | scope intersection and 404 on foreign centre; branch→centres | unit + integration with fake actors (all-centre, A1-only, locked, aal1) | US-15.2, US-02.3–5 |
| AN-T04 | Refresh engine: dirty marks, partition replace for all 16 families, refresh_state/runs | `repository/{refresh,sourceViews,orderIndex}.repo.ts`, `service/refresh.service.ts`, `jobs/analytics/tasks/refresh_tenant.ts` | AN-T01; C0 seed views | every family rebuilds from its view (results/critical/deliveries with `centre_id`, `tests_approved`; aliquots excluded; unknown `recipient_kind` → `other`); atomic replace; marks during run survive; advisory lock per family-range tx, no row locks on marks; `refresh_state` upserted lazily (P-22) | integration `rollups_equal_views` (all families, 1× seed); failure mid-run leaves old partition + marks; concurrent runs; "final release moves to a later day" (TAT delete-by-subject, review #4); M64 only when `total_tat_seconds` present; tenant with no `refresh_state` rows reports `never_refreshed` | US-20.2–4, US-11.3 |
| AN-T05 | Event consumers (12) | `jobs/analytics/consumers/*.ts` | AN-T04 | each consumer marks correct families/dates; order_index upsert completes a cancel-before-create placeholder (`ON CONFLICT … DO UPDATE … WHERE registered_on IS NULL`); `created_by`/`expires_at` set; deliveries dirtied at bd(`delivery_created_at`) (D-48) | per event: IC example payload, duplicate delivery, unknown fields, out-of-order; date boundary at 18:15 UTC; payloads without `centre_id` (D-1), `specimen_id`/`verified_by_membership_id` (D-2), `delivery_created_at` (D-48) accepted | US-20.1–2 |
| AN-T06 | Sweeps, self-check, purge, backfill tasks + cron | `tasks/{sweep_recent,sweep_nightly,self_check,purge,backfill}.ts` | AN-T04 | cron entries in manifest; `taskOptions` 120 s for nightly/backfill (CR-C8-012); self-check R2/R3/R4 emits metric and re-marks; purge batches under `__delete__tenant` by `expires_at` (P-18(c)); backfill seeds `order_index` from `reporting.v_pub_order_report_tat` (D-50) | integration with clock injection; mismatch injection test; retention boundaries (row with `expires_at` in the future survives); backfill seeds an order with no C8 event and `report_backlog` counts it | US-20.3, R2–R4 |
| AN-T07 | Labels service | `service/labels.service.ts`, `repository/labels.repo.ts` | AN-T01 | departments/tests/referrers (incl. canonical id) from catalog views; instrument labels from `instruments.v_pub_instrument_directory`; centres/branches via ctx.core; staff names via `ctx.core.memberships.list({ membershipIds, activeOnly: false })` (P-17); inactive flags | integration with catalog/instrument fixture rows | US-04.2, US-05.2, US-08.2, US-14.1 |
| AN-T08 | Income + department income + reconciliation | `service/reports.service.ts#income/departmentIncome`, `repository/rollups.repo.ts`, handlers `getIncomeReport`, `getDepartmentIncomeReport` | AN-T03, T04, T07 | M10–M22; group_by incl. bs_month; `reconciles_with_income` | R2; negative day; HTTP contract + error tests (R1 `income_reconciles_to_registers` is an M6 integration gate with the real C4 module, not run here — review m#30) | US-03.1, US-03.3–6, US-04.1–3 |
| AN-T09 | Volume, top centres, top referrers, collections | handlers `getVolumeReport`, `getTopCentresReport`, `getTopReferrersReport`, `getCollectionsReport`, `searchAnalyticsReferrers`, `getAnalyticsFilterOptions` (incl. conditional `recipients`, D-47), `getCollectionsFilterOptions` (#30, D-46) | AN-T08 | M01–M08, M25–M32, M35–M38; top referrers volume only (D-44); `referrer_id` filter; rollup canonical; SELF; daily-cash link permission | integration + contract; R4; centre-restricted variants; `recipients` present only with `analytics.schedule.manage` (P-10 branch tests); finance user: #30 200, #16 403 | US-05, US-06, US-08 |
| AN-T10 | Referral business report | handler `getReferralIncentiveReport`, audit call | AN-T09; CR-C8-006 (access-log code `referral_report.view`, registered in 08 §4.4) | flag gate (after `assertRole`), MFA, paging, access log; SELF row without `net_billed_paisa` | flag off + aal2 holder → feature_disabled; non-holder → forbidden; aal1 → mfa_required; access_log row; CI script `__tests__/ci/no-commission.sh` (job `c8-no-commission`, CR-C8-015) | US-07.1–5 |
| AN-T11 | Tests done, quality indicators, delivery, interfaces | handlers `getTestsDoneReport`, `getQualityIndicatorsReport`, `getDeliveryReport`, `getInterfacesReport` | AN-T08 | centre scoping on results, critical values and deliveries (CR-C8-004/005); M40–M91; instrument labels | integration; centre-restricted users see only their centres' rows and an empty `tenant_wide_sections_hidden`; NULL-centre deliveries only for all-centre users | US-09, US-12, US-13, US-14 |
| AN-T12 | TAT | `repository/tat.repo.ts`, handler `getTatReport` | AN-T04 | exact percentiles; exclusions; anomalies | integration with crafted timelines (missing endpoint, negative, rejected, urgent filter) | US-11.1–6 |
| AN-T13 | Pending (live) + backlog | `service/pending.service.ts`, handlers `getPendingTestsSummary`, `listPendingTests` | AN-T04, AN-T07 | live under user RLS only (no implicit centre predicate, D-49); cursor; open_route_id gating; backlog stages | integration with C5 seed rows across centres incl. a hub user who sees processing-centre items (D-13); explicit `centre_id` filter; timeout → 503 | US-10.1–5 |
| AN-T14 | Dashboard + freshness + manual refresh | handlers `getAnalyticsDashboard`, `getAnalyticsFreshness`, `requestAnalyticsRefresh` | AN-T08–T13 | tiles, deltas (none on snapshot tiles), series, omissions by permission; throttle via `INSERT … ON CONFLICT … WHERE … RETURNING` on the `_manual` row (P-22) | integration; contract; first manual refresh on a fresh tenant → 202, second → 429; perf smoke | US-01.1–6, US-16, US-19 |
| AN-T15 | Exports (API + worker build + download + purge) | `service/export.service.ts`, `repository/exports.repo.ts`, handlers #20–#23, `tasks/build_export.ts`, `export/{XlsxWriter,CsvWriter,PdfRequest,layout}.ts`; dependency `write-excel-file` 4.1.1 | AN-T08–T14; CR-C8-002 codes (until merged: tests assert codes from the CR via generated enum branch) | quota, scope snapshot ∩ current, header block, `neutraliseFormula` from `@lims/shared-ts/spreadsheet` in every writer, 24 h/3-download limits, access logs, core streaming download helper (P-2), final-attempt `failed` (`common.internal`), `analytics.report` render data shape (TRD §10.2 step 6a) and RenderPort error mapping | integration: quota races (X16), parallel downloads (X14), revoked membership (X13), flag off during build (X19), centre shrink (US-15.5); XLSX opens and matches API rows; CSV RFC 4180; writers call `neutraliseFormula` (doctor name `=HYPERLINK(…)` stays text); `export_files` insert carries `created_by`/`expires_at`; RenderPort fake: `common.payload_too_large` → `analytics.export_too_large` | US-17.1–8, US-15.4–5 |
| AN-T15b | Renderer template for `analytics.report` | `services/renderer/templates/analytics/report/**` (bundled assets only, REQ-SEC-086) + sample data fixture matching TRD §10.2 step 6a | AN-T15; C6 renderer skeleton; C0-0C `contracts/render/analytics.report.schema.json` | template renders the fixture; no external asset | C6 contract case (2) "data violating schema" with an invalid fixture; render snapshot | US-17.4 |
| AN-T16 | Schedules + dispatcher + report runs | `service/schedule.service.ts`, `domain/schedule.ts`, handlers #24–#29, `tasks/dispatch_schedules.ts` | AN-T14; NotificationPort fake; CR-C8-007/008 | slot math (A.D./B.S./weekly), late slots > 24 h → `skipped_late`, eligibility over active recipients, omission rules, `viewer_omitted_report_codes`, recipients deactivated not deleted (D-45), absolute `staff_url` link (D-29), idempotent dispatch, run visibility | unit slot table incl. B.S. month rollover and late slots; integration with NotificationPort fake (recorded sends, params only `lab_name`,`schedule_name`; recipient `{kind:'staff', membershipId, requiredPermission:'analytics.dashboard.read'}` — 08 A4.2/A5.4); schedule name `label_text` rules: 80 chars ok, 81 rejected, `https://x`, `WWW.x` rejected (DB CHECK and service, 08 A5.4); duplicate cron run; non-recipient 404; 21st active schedule → `400 common.validation_failed` (path `''`); recipient removed then re-added → same row reactivated | US-18.1–6 |
| AN-T17 | Web: shell pieces (filter bar, export dialog, scope banner) | `apps/web/src/features/analytics/components/{ExportDialog,ScopeBanner}.tsx` (composed of kit primitives); `PeriodPicker`, `DurationText`, `FreshnessBadge` are used from `@lims/ui` (CR-C8-013 accepted); `server/*.server.ts` | AN-T01; MSW mocks; C0 kit | components composed only of `@lims/ui` | component tests; axe | US-02, US-16, US-17 UI |
| AN-T18 | Web: dashboard page | `app/(staff)/analytics/{page,loading,error}.tsx` | AN-T17 | all states of 03-APP-FLOW §5 | component + E2E (MSW) | US-01 UI |
| AN-T19 | Web: report hub + 11 report pages + collections page | `app/(staff)/analytics/reports/**`, `app/(staff)/analytics/collections/**` (route `staff.analytics.collections`, D-46), nav entry `analytics.collections` | AN-T17 | per 04-UI-UX §4 | component tests per page/state; keyboard shortcuts; finance-only user sees just "Collections history" | US-03–US-14 UI |
| AN-T20 | Web: referral, exports, schedules, report run pages | `app/(staff)/analytics/{referral-incentive,exports,schedules,report-runs}/**` | AN-T17 | per 04-UI-UX §5–§9 | component + E2E: owner exports XLSX and downloads; schedule create/edit conflict | US-07, US-17, US-18 UI |
| AN-T21 | Probes + security tests | `services/api/src/modules/analytics/__tests__/probes/**` | AN-T08–T16 | 07-SECURITY §5 complete (incl. P12 partner/portal/patient claims, P13 no `net_billed_paisa` outside the referral report) | probe suite green | US-01.6, US-15, US-05.3 |
| AN-T22 | Observability + alerts registration | metrics in services/tasks; `services/worker/src/jobs/analytics/ops/analytics.rules.yml` (TRD §13 "Alert rules for C1"); `__tests__/ci/no-commission.sh`; wiring via CR-C8-015 (08 A13 P-14) | AN-T04, T15 | metrics exported; rule file holds exactly the five rules of TRD §13 | metric unit tests; log PHI-scan test | 05-DoD §3.7 |
| AN-T23 | Performance validation | load scripts under `services/api/src/modules/analytics/__tests__/perf/` | all API tasks | TRD §12 targets at 1× and 10×; decision on sweep interval recorded in TRD | perf report | §7 success metrics |
| AN-T24 | Help + manual | `apps/web/src/features/analytics/help/**`, `docs/manual/analytics/**` | UI tasks | every screen has help; manual with synthetic screenshots | review checklist | IS-20 |

## 2. Milestones

| M | Contents | Exit |
|---|---|---|
| M1 Engine | AN-T01–T07 | all families rebuild from C0 seed views; consumers idempotent |
| M2 Core MIS API | AN-T08–T14 | dashboard + all reports pass contract, R1–R4, centre probes |
| M3 Exports & schedules | AN-T15, T16 | exports audited, quotas, link-only emails via fake |
| M4 UI | AN-T17–T20, T24 | all screens with all states; E2E on MSW |
| M5 Hardening | AN-T21–T23 | security sign-off (05-DoD §4); perf targets |
| M6 Integration | fakes → real owners (§3) | 05-DoD §5 scenarios incl. "invoice issued → dashboard income within 2 min" and R1 against real C4 |

## 3. Fake → real swaps

| Dependency | Fake / default | Swap when | Re-run |
|---|---|---|---|
| C4 views + events | C0 seed views over fixture tables; fake publisher | C4 chunk gate | R1 (M6 gate) with real B24 `getSalesRegister` / B26 `getCreditNoteRegister` (C4 publishes the B26 `net` field); consumers on real events |
| C5 views + events | seed views (already with `centre_id`, `tests_approved`, `parent_specimen_id` — CR-C8-004 accepted, built from the start) | C5 chunk gate | results/critical centre probes against real views |
| C6 views + events; NotificationPort | seed views (with `centre_id`, D-48); NotificationPort fake | C6 chunk gate; CR-C8-007 | delivery cohort + scope; `delivery_created_at` dirtying; dispatch E2E with real outbox (non-prod providers only, REQ-SEC-136) |
| C7 views + event | seed views | C7 gate | interfaces report |
| C3 views | seed views | C3 gate | labels, canonical referrer |
| C2 IdentityPort, flag | fake | C2 gate | privileged/MFA/flag tests against real |
| RenderPort | none → pdf disabled | C6 ships RenderPort (03-IC §4.16; CR-C8-009 merged into CR-C4-004, 08 R12c) | enable `LIMS_ANALYTICS_PDF_ENABLED`; PDF export tests incl. bytes returned + sha256 check, `analytics.report` ≤ 5,000 rows |
| Routes (CR-C8-008), permissions (CR-C8-001), errors (CR-C8-002), access action (CR-C8-006) | defaults in TRD §16 | merge | nav build; role matrix; code tests |

## 4. CRs relied on (raised in 02-TRD §16)

CR-C8-001 … CR-C8-014 (all accepted or merged in 08), CR-C8-015 (raised in the review fix pass, P-14). Blocking none; each has a default.

Review fix pass 2026-11-06: review/C8-analytics-mis.md + 08 Addendum A17 (P-16…P-23 as they apply, D-44…D-51) and A13 P-rules applied; tasks above updated (AN-T15b added).

08 Addendum A4/A5 applied 2026-11-06 (A4.2/A5.4 recipient `requiredPermission` from the §3.3 registry; A4.3 `label_text`; A5.4 `schedules__name__ck`).

08 Addendum A2/A3 applied 2026-11-06 (A2.6 template `analytics.report_ready` / `short_text` (superseded by A4.3 → `label_text`) / IdentityPort recipient resolution; A2.7 no engagement views consumed).

## 5. Risks and mitigations

| # | Risk | Mitigation |
|---|---|---|
| R-1 | Source views scan whole fact tables per refresh (no date-expression index) | CR-C8-011; chunked ranges; configurable sweep interval; perf test AN-T23 decides |
| R-2 | 5 s statement timeout too short for nightly ranges | CR-C8-012; 1-day chunks fallback |
| R-3 | Income mismatch vs sales register (definition of `SalesRegisterRow.total`, ASSUMPTION A-C8-03) | R1 integration test fails loudly; CR to C4 if needed; self-check alert |
| R-4 | Upstream view column renames (e.g. CR-C8-010 `method_code`) | C0 DDL from IC §6 names; contract test asserts view column lists |
| R-5 | Export exfiltration by insiders | MFA, quota, own-only downloads, 3-download/24 h cap, access logs, spike alert (07-SECURITY) |
| R-6 | Referral report compliance (B13) | flag default off, no amounts/payouts, CI word ban, view access logged |
| R-7 | Visit-days mistaken for distinct patients | explicit label + tooltip; open question PRD §11.3 |
| R-8 | Rollup volume (referrer tables ~730k rows/yr/lab) | indexes; retention; perf test at 10× |
| R-9 | Graphile job_key semantics for debounce (UNVERIFIED, C0 SP-2) | correctness relies on persistent dirty marks + 10-min sweep, not on job_key |
| R-10 | Tenant timezone ≠ Nepal | banner; CR if a tenant needs it |

## 6. Foreseen CR candidates (not yet raised)

- `catalog.v_pub_credit_party_directory` (labels) for a credit-outstanding MIS view; C8 is not a consumer of `billing.v_pub_credit_party_statement` until such a CR (08 A17 D-51).
- Coded-set display views for payment methods (`billing`), rejection reasons (`lab`) so labels need no message-catalog mapping.
- ~~Instrument/agent display labels in `instruments.v_pub_*`~~ — closed: `instruments.v_pub_instrument_directory` (`tenant_id, instrument_id, centre_id, instrument_code, display_name, vendor, model, state, is_active`; consumers C8, C9, C12 — 08 R12d/§4.9) supplies instrument labels for the interface-messages family (`labels.repo.ts`).
- Phase 2: consume `quality.v_pub_qc_summary` (C9) into a `qc` family; TAT targets from C9 for "% within target".
- Distinct-patient counts over arbitrary ranges (new frontdesk view) if the client requires it.
- Booking/queue dashboard tiles from `engagement.v_pub_booking_daily` / `engagement.v_pub_queue_daily` (C16) — a later additive C8 CR once C16 ships (08 A2.7); no C8 task, query or test consumes them until then.
