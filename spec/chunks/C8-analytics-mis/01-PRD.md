# C8 Analytics & MIS — 01 Product Requirements (PRD)

Status: DECISION, 2026-11-06. Chunk C8, Phase 1 (04 §12: "referral-incentive reporting; daily cash report + named MIS dashboards; TAT timestamps + pending list"). Module `analytics` (Postgres schema, API module, worker jobs, web feature).
Precedence: `research/00` > `research/04` > `program/03-INTERFACE-CATALOG.md` (03-IC) > `program/01`/`02` > this file. Where this file needs something those documents do not provide, it says DECISION, [CONV], ASSUMPTION, UNVERIFIED or BLOCKED, and every contract gap is raised as a CR in `02-TRD.md` §16 ("Change requests raised"), designed here as if accepted and marked **(CR-C8-nnn)**.

Labels: **DECISION** = engineering choice made here (change by CR). **[CONV]** = value chosen here with no external fact behind it. **ASSUMPTION** = planning assumption to validate. **UNVERIFIED** / **BLOCKED (B#)** as in 04.

---

## 1. Purpose

C8 turns the facts other modules publish into the numbers a lab owner runs the business on: patients, income, tests done, reports pending (00 F1), income by department (00 F2), which doctors and collection centres send the most work (00 F3), the pending-test picture (00 F4), turnaround times (00 §3 item 15), the referral business report (00 E5, reframed by 04 L19), and the analytic history of cash collection (00 E7). It exports these as Excel/CSV/PDF and emails scheduled MIS **links** (never figures) to staff.

C8 is **read-only over the rest of the system**. It reads only:
1. published views `<schema>.v_pub_*` listed for C8 in 03-IC §6 (01 §5 R1; 02-CV §5.13), and
2. the events listed for C8 in 03-IC §3.25, which it uses only to know *what changed* (dirty marking), never as a second source of truth.

It owns the `analytics` schema: rollup tables refreshed by worker jobs from those views (REQ-ARCH-024 "dashboard counts from worker-maintained rollups, not fact scans"), plus its own export, schedule and refresh-bookkeeping tables. No other module reads `analytics` (it is last in the DAG, 01 §5 R3).

## 2. Users and roles

Role and permission codes are from 03-IC §11. Codes marked (CR) are requested in CR-C8-001 and designed as if accepted.

| Role (default, 03-IC §11) | What they do in C8 | Permissions used |
|---|---|---|
| `owner_viewer` | Owner dashboard, every MIS report, referral business report (when the tenant flag is on), exports, schedules | `analytics.dashboard.read`, `analytics.referral_report.read` (privileged), `analytics.data.export` (privileged), `analytics.collections.read` (CR), `analytics.schedule.manage` (CR) |
| `tenant_admin` | Same as owner except the referral business report (03-IC §11 grants `analytics.referral_report.read` to `owner_viewer` only); exports; schedules | `analytics.dashboard.read`, `analytics.data.export`, `analytics.collections.read` (CR), `analytics.schedule.manage` (CR) |
| `lab_manager` | Operational MIS: tests done, pending tests, TAT, quality indicators, interface health, delivery stats | `analytics.dashboard.read` |
| `finance` | Collections history (C4 owns the operational daily cash report, `billing.cash_report.read`) | `analytics.collections.read` (CR) — `finance` has no `analytics.dashboard.read` by default, so it sees only the collections report, on its own page `/analytics/collections` (route `staff.analytics.collections`, nav "Collections history"; 08 A17 D-46) |
| Centre-restricted users (any role whose membership has `all_centres = false`) | See only figures of their centres; tenant-wide-only sections are hidden (§8.3) | as their role |
| System actor (`analytics` worker) | Event consumers, refresh jobs, export builder, schedule dispatcher | declared in the worker manifest (`02-TRD.md` §9.4) |

MFA: `analytics.referral_report.read` and `analytics.data.export` are `privileged: true` → aal2 TOTP required and membership re-validated (04 A4 "data-export roles"; REQ-SEC-062/067).

## 3. Problems this chunk solves

1. The owner cannot see today's business at a glance: patients, income, tests done, reports pending (00 F1).
2. Income per department (haematology, biochemistry, radiology…) is not visible (00 F2).
3. Nobody knows which doctor and which collection centre sends the most patients (00 F3).
4. Pending tests are not visible as a lab-wide picture with age and overdue counts (00 F4; worksheets themselves are C5).
5. Turnaround time is not measured with named start/stop points (00 §3 item 15; 06-GLOSSARY "TAT" DECISION G).
6. The client ticked "track commission/incentive for referring doctors" (00 E5); 04 L19 / B13 allow only a neutral referral-business *report*, never labelled "commission", hideable by a tenant flag.
7. Daily cash collection by staff and method (00 E7) exists operationally in C4; owners also need the history (trend by month, method mix, staff comparison) without re-counting.
8. Owners want BI/MIS (00 §3 item 6) and exports to Excel (01 research §1.6 "export-to-Excel on every report"), plus scheduled MIS by email — and every export is an insider data-exfiltration channel (REQ-SEC-045, -100, -133).
9. A dashboard income figure that does not match the sales register destroys trust; C8 must reconcile exactly with C4's sales/credit-note registers.
10. Twenty branches/centres (00 G3): staff restricted to centres must see only their centres' figures (REQ-SEC-017).

## 4. Scope

### 4.1 In scope (mapped to the client baseline)

| ID | Capability | Client item | Notes |
|---|---|---|---|
| IS-01 | Owner dashboard: tiles for patient visits, income (net sales), tests done, reports pending, pending tests, collections; deltas vs previous equal-length period; small trend charts | 00 F1 | metric dictionary §8 |
| IS-02 | Period selection by A.D. date range **or** B.S. month **or** B.S. fiscal year; business day = Nepal time (Asia/Kathmandu, UTC+05:45) | 04 D12, L16; 02-CV §4.8, §13 | §8.1 |
| IS-03 | Income report: invoiced, credit notes, net sales, discount, VAT, other tax, exempt/taxable; by day, A.D. month, B.S. month, branch, centre | 00 F1; 04 L5 (credit notes only) | reconciles to C4 registers (§8.4) |
| IS-04 | Income by department | 00 F2 | `billing.v_pub_department_income` |
| IS-05 | Top referrers (orders, patient visits, tests ordered — volume only) incl. "SELF" | 00 F3 | merged doctors roll up via `canonical_referrer_id` (CR-C3-004); net billed per referrer only in IS-07 (08 A17 D-44, B13) |
| IS-06 | Top collection centres (orders, patient visits, tests ordered, net sales, collection mode) | 00 F3 | |
| IS-07 | Referral business report (internal code `referral_incentive`): per referrer per period orders, patient visits, tests ordered, net billed — **no rate, no amount payable, no payout** | 00 E5; 04 L19; B13 | tenant flag `referral_incentive_report` (C2, default off); never the word "commission" |
| IS-08 | Collections history: net collected by payment method, by staff, by centre, by day/month (cash basis) | 00 E7 | analytic view only; C4 owns the operational daily cash report and cash-session reconciliation (C4 B17/B18) |
| IS-09 | Tests done: results resulted/verified/approved/amended, abnormal, critical, auto-verified (analyte level), tests completed (test level), by department/test/processing branch, centre-scoped | 00 F1 | CR-C8-004 accepted (`centre_id`, `tests_approved` in `lab.v_pub_result_daily`) |
| IS-10 | Pending tests summary (live): counts by status, department, priority, age bucket, overdue vs TAT target; drill-down list without patient identifiers | 00 F4 | `lab.v_pub_pending_items`; worksheets are C5 |
| IS-11 | Reports pending (backlog): orders awaiting results vs ready but unreleased | 00 F1 | §8.2 M52–M54 |
| IS-12 | TAT report: pre-analytical, transport, within-lab, total (first release) and total (final release) — n, median, 90th percentile, max; by centre, processing branch, priority, specimen type | 00 §3 item 15; 01 research §2.7 | % within target is Phase 2 (C9) |
| IS-13 | Quality indicators: rejections by reason/centre/specimen type and rate; recollections; critical values detected/notified and notification time | 01 research §2.1; 04 L21 | |
| IS-14 | Delivery and release statistics: deliveries by channel/status, reports released, amended releases, release overrides | 00 D2–D4, D8; 00 §3 item 4 | |
| IS-15 | Interface health: messages per instrument/day, unmatched, quarantined, duplicates; agents by state | 00 §3 item 3; REQ-ARCH-061 | lab-manager view |
| IS-16 | Freshness indicator on every figure; manual "refresh now" | — (DECISION; REQ-ARCH-024 rollups imply staleness) | §8.5 |
| IS-17 | Exports: XLSX and CSV now; PDF through `RenderPort.renderPdf` (03-IC §4.16; CR-C8-009 merged into CR-C4-004 — 08 R12c: system actor in the worker, bytes returned to C8, ≤ 5,000 rows) once C6 ships it; privileged, MFA, quota-limited, audited | 00 §3 item 6; 01 research §1.6 | §10 of 02-TRD |
| IS-18 | Scheduled MIS emails to staff — **link only**, no figures | 00 §3 item 4/6; 04 R5, S20 | via `NotificationPort.sendEmailLink` (CR-C8-007) |
| IS-19 | Centre scoping of every figure, export and scheduled run | REQ-SEC-017; 02-CV §5.8 | §8.3 |
| IS-20 | In-app help and user-manual pages for every screen | 01 §2 training note; 02-CV §14 | `apps/web/src/features/analytics/help/`, `docs/manual/analytics/` |

### 4.2 Out of scope

| Item | Where it lives / why |
|---|---|
| Operational daily cash report, cash-session close, variance | C4 (`/billing/daily-cash`, B17/B18) — C8 shows history only and links to C4 |
| Sales register, cancelled-invoice register, credit-note register, IRD Excel/XML/PDF statutory exports | C4 (04 L26 cl.6(ठ)); C8 never presents its exports as statutory books |
| Worksheets, worklists, pending list actions | C5 |
| TAT targets/alerts/escalations, "% within target" per test, Westgard/LJ | C9 (Phase 2, 04 §12) |
| Referral payout execution, incentive rate tables, computed payable amounts, TDS | BLOCKED B13 / 04 L19 ("payouts outside the system"); see §11 |
| Generic BI builder, ad-hoc SQL, read-replica access for Metabase/Superset | 01 research §1.6 KEEP-LATER; `lims_analytics` role reserved (02-CV §5.9) |
| Cumulative antibiogram | C10 (Phase 2) |
| Inventory consumption reports | C12 (Phase 2) |
| Patient-level lists of any kind (names, phones, registration numbers, results) | never in C8 (DECISION D-C8-01, §7 of 07-SECURITY) |
| Credit-party outstanding summary | C4 statement (B23) covers it. C8 is **not** a consumer of `billing.v_pub_credit_party_statement` (08 A17 D-51); a later additive C8 CR may add it once a credit-party label source exists (`06-IMPLEMENTATION-PLAN.md` §6) |
| Marketing/CRM analytics | 04 §12 DROP list |

## 5. Phase

Phase 1 (04 §12). Report families whose source modules are Phase 1 (C3, C4, C5, C6, C7) ship in Phase 1. Quality summary from `quality.v_pub_qc_summary` (C9, Phase 2) is **not** consumed in Phase 1; it is listed as a Phase-2 addition in `06-IMPLEMENTATION-PLAN.md` §6. Booking/queue statistics (`engagement.v_pub_booking_daily` / `engagement.v_pub_queue_daily`, owned by C16) are **not** consumed by C8; booking/queue dashboard tiles come as a later additive C8 CR once C16 ships (08 A2.7).

## 6. User stories and acceptance criteria

Conventions in criteria: "tenant A/B", "centre A1/A2" are the synthetic seed tenants (02-CV §11.2). Money in paisa unless shown. "Business date" per §8.1. Each numbered criterion is a test (05-DoD §2).

### US-01 Owner dashboard (00 F1)
As an owner, I want one page with today's patients, income, tests done and reports pending, so I see the business at a glance.
1. Given rollups refreshed for tenant A, When an `owner_viewer` (all centres) opens `/analytics` with no period, Then the period defaults to "Today" (business date in Asia/Kathmandu) and tiles show M04 patient visits, M12 net sales, M42 results approved (labelled "Results approved") with M08 tests ordered as sub-value, M52 reports pending, M50 pending tests, M27 net collected.
2. Given the same, Then each tile shows a delta against the immediately preceding period of equal length (Today vs Yesterday) as absolute and percent; percent is omitted when the previous value is 0.
3. Given a user without `analytics.dashboard.read`, When they request `GET /v1/analytics/dashboard`, Then `403 auth.forbidden` and the nav entry is hidden.
4. Given rollups whose family `income` last succeeded 45 min ago, When the dashboard loads, Then the income tile shows the stale marker and "Updated <time>" (§8.5) while still showing the last values.
5. Given a centre-restricted user (centre A1 only), When the dashboard loads, Then every figure (including M42 results approved) equals the figure computed from A1 rows only; rows without a centre (credit-party invoices/payments) are not included. No Phase-1 tile is tenant-wide-only (§8.3); if a later family is, its tile is replaced by the notice `analytics.scope.tenant_wide_only`.
6. Given tenant B data exists, When a tenant A user loads the dashboard, Then no tenant B row contributes (probe compares with A-only expected totals).

### US-02 Period selection in A.D. and B.S. (04 D12, L16)
1. Given `bs_month=<Y>-<M>`, When any report is requested, Then the server converts it with `@lims/shared-ts/bsdate` to `business_date_from = bsToAd({Y,M,1})` and `business_date_to = bsToAd(first day of next B.S. month)` (exclusive), and returns both A.D. bounds and the B.S. label in `period`.
2. Given `fiscal_year_bs=2082/83`, Then bounds are `fiscalYearBs().startsOn` to `endsOn + 1 day` (exclusive) — FY starts Shrawan 1 (04 L16).
3. Given more than one of {`business_date_from`/`business_date_to`, `bs_month`, `fiscal_year_bs`}, Then `400 common.validation_failed`.
4. Given a range longer than 366 days, Then `422 analytics.range_too_large`.
5. Given a B.S. month outside 1975–2099 B.S., Then `422 common.date_out_of_range`.
6. Given an invoice issued at `2026-11-05T18:14:59.999Z` and another at `2026-11-05T18:15:00.000Z`, Then they fall on business dates 2026-11-05 and 2026-11-06 respectively (Asia/Kathmandu midnight = 18:15 UTC).
7. Tests derive every B.S. boundary from the shared golden table (`packages/test-fixtures/bsdate/golden-2000-2099.json`); no hard-coded conversion appears in tests or docs (C0 04-UI-UX §2.3 rule).

### US-03 Income report and reconciliation (00 F1, 04 L5)
1. Given invoices issued, one later cancelled (credit note), and one partial credit note in the period, When the income report is requested, Then M10 = Σ net of all invoices issued in the period (cancelled ones included on their issue date), M11 = Σ net of all credit notes issued in the period, M12 = M10 − M11.
2. **Reconciliation (R1, M6 integration gate only):** Given data written through the real C4 module, When C4's B24 sales register (`getSalesRegister`, all statuses) and B26 credit-note register (`getCreditNoteRegister`) are summed for the same business-date range and centre filter, Then Σ register `total` = M10 and Σ credit-note `net` = M11, to the paisa (integration test `income_reconciles_to_registers`). `billing.v_pub_invoice_daily` is the C4-owned figure C8 copies. C4 must publish the B26 row shape with field `net` (hand-off to C4; ASSUMPTION A-C8-03: `SalesRegisterRow.total` = `invoices.net_paisa`; if not, the test fails and a CR goes to C4). Not run against seeded views (that would be tautological).
3. **Reconciliation (R2):** Σ over departments of M21 for the period = M12 (department totals include credit-note lines as negatives on the credit-note date).
4. An invoice cancelled in the period but issued before it reduces M12 of the cancellation date; M12 for a day may be negative and is shown with a minus sign.
5. Given `group_by=bs_month`, Then rows are B.S. months labelled `YYYY-MM B.S.` with A.D. bounds, summing the daily rows of that month exactly.
6. The report header states "Income = invoiced (incl. VAT/other tax) minus credit notes; cash collected is a separate report" (`analytics.income.basis_note`).

### US-04 Income by department (00 F2)
1. Given lines in haematology and biochemistry and a package line with `department_id` NULL, Then rows show each department name from `catalog.v_pub_department` and one row "Multiple departments" for NULL (C4 05-SCHEMA §6 note).
2. Given a department deactivated in C3, Then its historic income still shows with its name and an "(inactive)" suffix.
3. R2 holds for every period and centre filter.

### US-05 Top referrers (00 F3)
1. Given orders with referrers D1 (5 orders), D2 (3), and no referrer (2), When top referrers is requested sorted by orders, Then rows are D1, D2, "SELF" with orders 5, 3, 2 (cancelled orders excluded — `frontdesk.v_pub_referrer_volume` excludes them).
2. Given D3 merged into D1 in C3 (`canonical_referrer_id` = D1), Then D3's orders are added to D1's row; `rollup=none` shows them separately.
3. Top referrers shows volume only (M30–M32). Net billed per referrer (M33) appears only in the referral business report (US-07: flag `referralIncentiveReportEnabled`, privileged `analytics.referral_report.read` at aal2, access log `referral_report.view`) — 08 A17 D-44. No top-referrers endpoint, export, schedule or dashboard card returns a money figure.
4. `limit` 1–100 (default 20) [CONV]; ties broken by referrer display name then id.

### US-06 Top collection centres (00 F3)
1. Given orders from centres A1 and A2 and home collection, Then rows per centre with collection-mode split, orders, patient visits, tests ordered and net sales.
2. A centre-restricted user sees only their centres' rows (no rank among other centres is revealed).

### US-07 Referral business report (00 E5; 04 L19; B13)
1. Given the tenant flag `referral_incentive_report` = false (C2 default — C2 PRD AC-C5.1), When a user holding `analytics.referral_report.read` at aal2 requests `GET /v1/analytics/reports/referral-incentive`, Then `403 common.feature_disabled`, the nav entry is hidden, and the report code is rejected for exports/schedules with the same error. Users without the permission get `auth.forbidden`, and holders at aal1 get `auth.mfa_required`, before the flag is checked (CV §10.1 order; review m#36).
2. Given the flag on and a user holding `analytics.referral_report.read` at aal1, Then `403 auth.mfa_required`; at aal2, Then rows per referrer: orders, patient visits, tests ordered, net billed (M33), for the period, with the note that credit-party charges count on their charge date (`analytics.referrers.billed_note`); the "SELF" row shows net billed as "—" (not available: billing rows always carry a referrer); an `access_log` row `referral_report.view` (CR-C8-006) is written.
3. No UI string, column header, export header, file name, API field, email template or log key in C8 contains "commission" (case-insensitive) — CI grep over `services/api/src/modules/analytics/**`, `services/worker/src/jobs/analytics/**`, `apps/web/src/features/analytics/**`, `apps/web/src/app/(staff)/analytics/**`, `docs/manual/analytics/**`.
4. The report has no rate, percentage, payable amount, payout status or "pay" action (B13 default "no payout features").
5. UI title is "Referral business report" (`analytics.referral.title`).

### US-08 Collections history (00 E7)
1. Given ledger payments by two staff with three methods and one reversal, When collections is requested `group_by=method`, Then rows per method show entries, reversals, gross collected, reversed, net collected; totals equal `billing.v_pub_payment_collection` for the same dates (R3).
2. Given `group_by=staff`, Then staff display names come from `ctx.core.user` via the membership; an inactive membership shows its name with "(inactive)".
3. Given a user with `analytics.dashboard.read` but not `analytics.collections.read`, Then the collections tile on the dashboard and the report are hidden and the API returns `403 auth.forbidden`.
4. The page shows a link "Today's cash report and session close → Billing" to route `staff.billing.daily_cash` when the user holds `billing.cash_report.read`; C8 shows no session/variance data.
5. Payments of credit parties have no centre (`ledger_entries.centre_id` NULL) and are visible only to all-centre users (§8.3).
6. Given a `finance` user (holds `analytics.collections.read`, not `analytics.dashboard.read`), When they open `/analytics/collections` (route `staff.analytics.collections`), Then the collections report renders with filter options from `getCollectionsFilterOptions` (centres, branches, payment methods in their scope); the nav shows only "Collections history" in the analytics group (08 A17 D-46).

### US-09 Tests done (00 F1)
1. Given results resulted/verified/approved/amended on different days, Then each count lands on the date of its own event (first result, verification, approval, amendment) as published by `lab.v_pub_result_daily`.
2. Rows group by department or test (labels from `catalog.v_pub_department` / `catalog.v_pub_test_directory`) and processing branch.
3. Centre scoping applies (CR-C8-004 accepted: `lab.v_pub_result_daily.centre_id` = the order's collection centre); the result columns are captioned "Results (analyte level)" and a "Tests completed" column (M47, order tests approved) is shown.

### US-10 Pending tests and reports pending (00 F1, F4)
1. Given 10 pending order tests visible to the user, When pending tests is requested, Then counts by `item_status`, department, priority and age bucket (<4 h, 4–24 h, 1–3 d, >3 d [CONV]) are returned live from `lab.v_pub_pending_items` under the caller's own RLS context: centre scoping comes only from C5's policy, so hub users also see items received at their processing centres (08 A13 D-13; 08 A17 D-49). Exports of this list filter by collection centre only (D-C8-08).
2. An item is "overdue" when `tat_target_seconds` is present and `age_seconds > tat_target_seconds`; items without a target are counted as "no target".
3. The drill-down list shows: department, test code/name, priority, item status, centre, age, overdue flag, and an "Open" link to `staff.lab.order_results` only when the user holds `lab.result.read`. It shows **no** patient name, registration no, barcode or result.
4. The label states the age anchor: "Age since receipt (or since registration if not yet received)" (C5 05-SCHEMA §4 note).
5. Reports pending (M52) = orders registered in the last 30 days [CONV `LIMS_ANALYTICS_BACKLOG_LOOKBACK_DAYS`], not cancelled, with no released report; split into M53 awaiting results and M54 ready but unreleased (§8.2).

### US-11 TAT report (00 §3 item 15; 01 research §2.7)
1. Given specimens with collected/in-transit/received/first-verified timestamps and orders with first/final release, Then the report gives n, median, p90 and max per segment M60–M64, each labelled with its start and stop points (06-GLOSSARY TAT DECISION G).
2. A specimen with a missing endpoint is excluded from that segment; a negative duration is excluded and counted in `anomalies`.
3. Rejected specimens (`rejected_at` present) and aliquots (`parent_specimen_id` present, CR-C8-004) are excluded from all specimen segments. The final-report segment (M64) counts an order only once every report family is final, on the day the last one became final (review #4).
4. A sample is anchored on the business date of its stop event (e.g. within-lab on the first-verified date), so late completions land in the period in which they complete.
5. Filters: centre, processing branch, priority, specimen type. Median/p90 are exact (`percentile_cont`) over the filtered samples.
6. "% within target" is not shown in Phase 1 (C9).

### US-12 Quality indicators (01 research §2.1; 04 L21)
1. Rejections by reason (coded set display from C5's codes, codes shown as-is when no label is available), centre and specimen type; rate = rejections × 100 / specimens received, both on their own event dates, labelled "per 100 received".
2. Critical values: detected, notified, % notified per day, with daily median and max notification seconds; for multi-day ranges the median column shows per-day values only and the range summary shows the maximum (medians are not additive).
3. Critical-value statistics are centre-scoped (CR-C8-004 accepted: `lab.v_pub_critical_value_daily.centre_id`).

### US-13 Delivery and release statistics (00 D2–D4, D8)
1. Deliveries by channel × status counts per day from `reporting.v_pub_delivery_daily`; every count is anchored on the delivery's **creation** date (cohort; 08 A17 D-48), so a later status change updates the creation day; failure share = failed ÷ (sent + failed + suppressed) per creation-day cohort, labelled as such.
2. Reports released per day by kind (final/partial/preliminary/amended) and release basis; override releases highlighted.
3. Delivery statistics are centre-scoped (CR-C8-005 accepted, D-48); deliveries not linked to a report (`centre_id` NULL) are visible only to all-centre users.

### US-14 Interface health (00 §3 item 3; REQ-ARCH-061)
1. Messages, patient records, QC records, unmatched, quarantined, duplicates per instrument per day; instrument label = `display_name` (`instrument_code`) from `instruments.v_pub_instrument_directory` (08 R12d), "(inactive)" when `is_active` is false; short id only when the directory has no row.
2. Agents by state (online/offline/backlog/degraded) live from `instruments.v_pub_agent_status`.

### US-15 Centre scoping (REQ-SEC-017)
1. For every report, export and report run, a user restricted to centres {A1} receives figures computed only from rows with `centre_id = A1`.
2. A `centre_id` filter value outside the caller's scope returns `404 common.not_found` (no existence oracle — 02-CV §4.6).
3. Rows with no centre (`centre_id` NULL in the source) are visible only to all-centre users.
4. An export or report run created by an all-centre user and opened later by a centre-restricted recipient shows only the recipient's centres (scope = recipient's current scope ∩ schedule scope).
5. A membership whose centre list shrinks after an export was requested: the export job uses the intersection of the snapshot and the membership's current centres at build time.

### US-16 Freshness (DECISION)
1. Every report response carries `freshness` per family used: `refreshed_at`, `is_stale`, `stale_reason` ∈ {`refresh_lagging`, `refresh_failed`, `never_refreshed`}.
2. `is_stale` = true when the family's oldest unprocessed dirty mark is older than 20 min [CONV] **or** its last success is older than 30 min [CONV] **or** its last attempt failed.
3. Live sources (pending tests, agent status) report `refreshed_at` = response time and are never stale.

### US-17 Exports (00 §3 item 6; REQ-SEC-045/100/133)
1. Given a user with `analytics.data.export` at aal2, When `POST /v1/analytics/exports` with `{report_code, format: xlsx|csv, params}` and an `Idempotency-Key`, Then `202` with an export in status `queued`; the build job produces the file within 60 s p95 for ≤ 10,000 rows [CONV] and status becomes `ready`.
2. The file contains only aggregate rows (and, for pending tests, the non-identifying drill fields of US-10.3); header block: tenant display name, report title, period (A.D. and B.S.), scope (centre names or "All centres"), generated at, export id, "Exported by <display name>", freshness, and the line "Internal MIS — not a statutory register" (`analytics.export.not_statutory`).
3. A text cell beginning with `=`, `+`, `-`, `@`, TAB or CR is prefixed with `'` (CSV/formula injection; DECISION D-C8-07).
4. Format `pdf` returns `403 common.feature_disabled` until C6 ships RenderPort (03-IC §4.16; no phase stub, 08 R9).
5. Quota: more than 10 exports per user per rolling hour or 50 per tenant per business day [CONV] → `429 common.rate_limited` with `Retry-After`.
6. Range > 366 days → `422 analytics.range_too_large`; rows > 100,000 [CONV] → export `failed` with `analytics.export_too_large` (CR-C8-002).
7. Download (`GET …/file`) is allowed only to the requester, at most 3 times [CONV], within 24 h [CONV]; afterwards `410 analytics.export_unavailable` (CR-C8-002). Each download writes `access_log` `data.export` with `{export_id, report_code, rows, phase: 'download'}`; creation writes `{phase: 'request'}`.
8. A user can list and see only their own exports; another user's export id → `404 common.not_found`.

### US-18 Scheduled MIS emails, link-only (04 R5, S20)
1. Given a schedule "Daily MIS" (reports: dashboard, income, department_income, pending_tests; frequency daily at 07:00 Nepal time; period rule `previous_business_day`; recipients M1, M2), When the dispatcher runs at or after 07:00, Then one report run is created and `NotificationPort.sendEmailLink` is called once per eligible recipient with recipient `{kind:'staff', membershipId, requiredPermission}` (`requiredPermission` from the report registry, 02-TRD §3.3 — `analytics.dashboard.read`; 08 A4.2/A5.4), template `analytics.report_ready`, purpose `scheduled_report_ready` (CR-C8-007), params `{lab_name, schedule_name}` only (`schedule_name` validated by C6 as param kind `label_text`: ≤ 80 characters, plain text, no URLs (`://` or `www.` rejected), HTML-escaped — 08 A4.3), and `linkUrl` = staff-web route `staff.analytics.report_run` (CR-C8-008) with the run id.
2. The email contains no figure, no patient data and no doctor/staff name — link-only, no PHI in the body (template params are validated by C6, 04 R5; 08 A2.6). C8 passes only `{kind:'staff', membershipId, requiredPermission}`; C6 resolves the recipient's e-mail through `IdentityPort.getStaffNotificationContact` (staff profile e-mail; `eligible: false` or no e-mail → `suppressed_no_contact`), not through FrontdeskPort (08 A2.6 as corrected by A4.2).
3. A recipient whose membership is inactive or who no longer holds `analytics.dashboard.read` at dispatch time is skipped (`skipped_ineligible`) and the schedule owner sees it in the run log.
4. Opening the link requires a staff login; only recipients of that run (and the schedule owner) can open it, others get `404 common.not_found`; figures are computed at open time from current rollups with the viewer's scope ∩ schedule scope.
5. Re-running the dispatcher for the same due slot does not send twice (idempotency key `<schedule_id>:<slot_start>:<membership_id>`).
6. A schedule containing `referral_incentive`: recipients without `analytics.referral_report.read` receive the run with that report omitted; while the tenant flag is off the run omits it for everyone (`omitted_report_codes`), and a schedule whose only report is `referral_incentive` is not dispatched (`skipped_flag_off`).

### US-19 Manual refresh
1. Given a user with `analytics.dashboard.read`, When `POST /v1/analytics/refresh` with families, Then today's (and yesterday's before 06:00 Nepal time [CONV]) partitions of those families are marked dirty and a refresh is enqueued; `202`.
2. More than one manual refresh per tenant per 5 min [CONV] → `429 common.rate_limited`.

### US-20 Event-driven freshness and correctness (system)
1. Given `billing.invoice.issued.v1` delivered twice, Then exactly one inbox row exists and the `income`, `department_income`, `referrer_billing` partitions of the issue business date are marked dirty once (upsert).
2. Given events arriving out of order, Then the result after refresh equals a full recompute from views (dirty marking is order-insensitive; no state is taken from payloads except `analytics.order_index`).
3. Given a full nightly refresh of the trailing 40 days [CONV], Then every rollup row equals the corresponding view aggregate for those dates (integration test `rollups_equal_views`).
4. Given a refresh run that fails mid-way, Then no partial partition is visible (delete+insert of a partition happens in one transaction) and the dirty marks remain.

## 7. Success metrics

| Metric | Target | Measured by |
|---|---|---|
| Dashboard API p95 (31-day period, 20 centres, 1× reference data) | ≤ 300 ms [CONV] | load test (02-TRD §12) |
| Share of time each family is not stale (business hours) | ≥ 99 % [CONV] | `lims_analytics_family_stale` gauge |
| Income reconciliation mismatches (R1/R2/R3) | 0 in CI; 0 in nightly self-check | integration test; `lims_analytics_reconciliation_mismatch_total` |
| Cross-tenant / cross-centre leaks | 0 | probe suite (07-SECURITY §5) |
| Exports with an access-log row | 100 % | audit test |
| "commission" occurrences in C8 paths | 0 | CI grep |

## 8. Metric dictionary (binding for 02-TRD queries and tests)

### 8.1 Time rules

- **Business date** = `(anchor_timestamp AT TIME ZONE 'Asia/Kathmandu')::date`, identical to every `v_pub_*` view's `business_date` (03-IC §6 header; C4/C5 05-SCHEMA view SQL). A business day runs 00:00–24:00 Nepal time = 18:15 UTC of the previous A.D. day to 18:15 UTC (UTC+05:45, 02-CV §4.8).
- C8 never re-derives a business date from a different timezone. In v1 `TenantSettings.timezone` accepts only `Asia/Kathmandu` (C2 rejects other values; 08 A13 P-15) and the views use the literal `AT TIME ZONE 'Asia/Kathmandu'`. C8 still reads `timezone` and, should it ever differ, shows the banner `analytics.tz.fixed_nepal` ("Business days are counted in Nepal time (UTC+05:45)") as a defensive guard; a per-tenant timezone needs a CR that adds stored `business_date` columns (P-15).
- Periods are half-open `[business_date_from, business_date_to)`. B.S. months and fiscal years are converted only by `@lims/shared-ts/bsdate` (`bsToAd`, `fiscalYearBs`, `daysInBsMonth`) (04 D13).
- B.S. grouping (`group_by=bs_month`) maps each business date to its B.S. month with `adToBs`, then sums daily rows. Fiscal-year labels use `fiscalYearBs(date).long` (e.g. `2082/83`).
- Every displayed date uses `DateText` with the tenant `calendarDisplay` (default `AD`); period headers always show both calendars (DECISION, mirrors 04 L11 practice for money reports).

### 8.2 Metrics

"Additive" = may be summed across days and centres. Source column names are the 03-IC §6 contract.

| ID | Name (UI) | Source (view.column) | Anchor | Formula / inclusion / exclusion | Additive | Centre-scopable |
|---|---|---|---|---|---|---|
| M01 | Orders registered | `frontdesk.v_pub_order_daily.orders_registered` | registered_at | all orders that reached `registered`, incl. later cancelled; `pre_registered` orders excluded (registered_at NULL) | yes | yes |
| M02 | Orders cancelled | `…order_daily.cancelled_orders` | registered_at | orders registered on that date whose current status is `cancelled` — **past days change** when an order is cancelled later | yes | yes |
| M03 | Net orders | M01 − M02 | registered_at | | yes | yes |
| M04 | Patient visits | `…order_daily.patients_distinct` | registered_at | Σ of distinct patients per (centre, day). Over a range or across centres this counts **patient-days**, not distinct persons; UI label "Patient visits" with tooltip `analytics.metric.patient_visits.help` | yes (as visit-days) | yes |
| M05 | New patients | `…order_daily.new_patients` | registered_at | patients whose first-ever order is on that date | yes | yes |
| M06 | Urgent orders | `…order_daily.urgent_orders` | registered_at | | yes | yes |
| M07 | OPD / IPD orders | `…opd_orders`, `…ipd_orders` | registered_at | | yes | yes |
| M08 | Tests ordered | `frontdesk.v_pub_centre_volume.order_items` | registered_at | active items of non-cancelled orders | yes | yes |
| M10 | Invoiced | `billing.v_pub_invoice_daily.net_paisa` | invoice issued_at | net (= exempt + taxable + VAT + other tax, C4 05-SCHEMA `invoices__totals__ck`) of every invoice issued, incl. later cancelled and periodic credit bills | yes | yes (NULL centre → all-centre only) |
| M11 | Credit notes | `…invoice_daily.credit_notes_paisa` | credit note issued_at | full and partial credit notes | yes | yes |
| M12 | **Net sales ("Income")** | M10 − M11 | — | headline income; may be negative on a day | yes | yes |
| M13 | Gross | `…gross_paisa` | issued_at | invoice side only | yes | yes |
| M14 | Discounts | `…discount_paisa` | issued_at | invoice side only | yes | yes |
| M15 | VAT | `…vat_paisa` | issued_at | invoice side only (credit-note tax split is not published — M11 is tax-inclusive) | yes | yes |
| M16 | Other tax | `…other_tax_paisa` | issued_at | slot for Health Service Tax (04 L25, BLOCKED B7) — column label from C4's tax code display when available, else "Other tax" | yes | yes |
| M17/M18 | Exempt / Taxable | `…exempt_paisa`, `…taxable_paisa` | issued_at | | yes | yes |
| M19 | Invoices issued | `…invoices_issued` | issued_at | count | yes | yes |
| M20 | Invoices cancelled | `…invoices_cancelled` | cancelled_at | count | yes | yes |
| M21 | Department net sales | `billing.v_pub_department_income.net_paisa` | line issue / credit-note date | NULL `department_id` = "Multiple departments" | yes | yes |
| M22 | Billed lines | `…department_income.line_count` | issued_at | credit lines count 0 | yes | yes |
| M25 | Collected (gross) | `billing.v_pub_payment_collection.gross_collected_paisa` | ledger business_date | payments only | yes | yes (NULL centre → all-centre only) |
| M26 | Reversed/refunded | `…reversed_paisa` | ledger business_date | positive number | yes | yes |
| M27 | Net collected | `…net_collected_paisa` | ledger business_date | cash basis; ≠ M12 | yes | yes |
| M28/M29 | Payment entries / reversal entries | `…entries`, `…reversals` | | counts | yes | yes |
| M30 | Referred orders | `frontdesk.v_pub_referrer_volume.orders` | registered_at | non-cancelled orders; `referrer_id` NULL = "SELF" | yes | yes |
| M31 | Referred patient visits | `…referrer_volume.patients_distinct` | registered_at | as M04 | yes (visit-days) | yes |
| M32 | Referred tests ordered | `…referrer_volume.order_items` | registered_at | | yes | yes |
| M33 | Referred net billed | `billing.v_pub_referrer_billing.net_billed_paisa` | invoice issued_at / credit charge date / credit note date | cash invoices net + credit-party charges (gross − discount, pre-tax) − credit notes; **not equal** to the referrer's share of M12. Served **only** in the referral business report (US-07; 08 A17 D-44) | yes | yes |
| M35–M37 | Centre orders / patient visits / tests ordered | `frontdesk.v_pub_centre_volume.*` | registered_at | split by `collection_mode` | yes | yes |
| M38 | Centre net sales | M12 grouped by `centre_id` | | | yes | yes |
| M40–M46 | Results resulted / verified / approved / amended / auto-verified / critical / abnormal | `lab.v_pub_result_daily.*` | own event date (first resulted, verification, approval, amendment, detection) | analyte-level counts; abnormal counted on first-resulted date | yes | yes (order's collection centre, CR-C8-004) |
| M47 | Tests completed | `lab.v_pub_result_daily.tests_approved` (CR-C8-004) | approval date | order tests reaching approved | yes | yes |
| M50 | Pending tests | `lab.v_pub_pending_items` (live) | now | items with `item_status` in C5's pending set | n/a (snapshot) | yes (C5 RLS) |
| M51 | Overdue pending | M50 where `tat_target_seconds` present and `age_seconds > tat_target_seconds` | now | | n/a | yes |
| M52 | Reports pending | `analytics.order_index` ⟕ `reporting.v_pub_order_report_tat` | snapshot (≤ 10 min) | orders registered within lookback, not cancelled, `first_released_at` absent | n/a | yes |
| M53 | – awaiting results | M52 where some specimen of the order (from `lab.v_pub_specimen_timeline`, status not `rejected`/`recollection_ordered`/`discarded`) lacks `all_approved_at`, or no such specimen exists | | | n/a | yes |
| M54 | – ready, not released | M52 − M53 | | | n/a | yes |
| M60 | TAT pre-analytical | `lab.v_pub_specimen_timeline` | received_at | `received_at − collected_at` ("Collection → receipt at lab") | n/a (percentiles) | yes |
| M61 | TAT transport | same | received_at | `received_at − in_transit_at` ("Centre scan-out → lab scan-in") | n/a | yes |
| M62 | TAT within-lab | same | first_verified_at | `first_verified_at − received_at` ("Receipt → first verified result") | n/a | yes |
| M63 | TAT total (first report) | `reporting.v_pub_order_report_tat` | first_released_at | `first_released_at − registered_at` ("Registration → first report released") | n/a | yes |
| M64 | TAT total (final report) | same | final_released_at | `final_released_at − registered_at`, only for orders whose every report family is final (`total_tat_seconds` present); when a later family becomes final the sample moves to that day | n/a | yes |
| M70 | Rejections | `lab.v_pub_rejection_daily.rejections` | rejected_at | | yes | yes |
| M71 | Recollections ordered | `…recollections_ordered` | rejected_at | | yes | yes |
| M72 | Rejections per 100 received | M70 × 100 ÷ M73 | | shown with one decimal; "—" when M73 = 0 | ratio of sums | yes |
| M73 | Specimens received | `lab.v_pub_specimen_timeline` count with `received_at` | received_at | aliquots (`parent_specimen_id` present) excluded (CR-C8-004); also excluded from the specimen TAT segments M60–M62 | yes | yes |
| M75–M78 | Critical detected / notified / median / max notify seconds | `lab.v_pub_critical_value_daily.*` | detected_at | `notified` = reached + read-back confirmed (C5 note) | detected, notified: yes; median: no; max: max | yes (CR-C8-004) |
| M80 | Deliveries by status | `reporting.v_pub_delivery_daily.{queued,sent,delivered,read,failed,suppressed}` | delivery creation date for every status (cohort; 08 A17 D-48) | per channel/purpose/recipient kind (unknown `recipient_kind` counted as `other`, 08 A13 D-3); failure share is per creation-day cohort | yes | yes (NULL centre = non-report delivery → all-centre only; CR-C8-005) |
| M85–M87 | Reports released / amended releases / override releases | `reporting.v_pub_report_release` | released_at | count of versions; `report_kind = 'amended'` (addenda — `report_kind = 'addendum'`, 08 R1 — are not counted as amended); `release_basis = 'override'` | yes | yes |
| M90 | Interface messages (+ patient, QC, unmatched, quarantined, duplicates) | `instruments.v_pub_message_daily.*` | per C7 view | | yes | yes |
| M91 | Agents by state | `instruments.v_pub_agent_status.state` (live) | now | | n/a | yes |

Money is always integer paisa on the wire and in storage (02-CV §4.9); the UI renders with `MoneyText grouping='lakh'`. Ratios are returned as basis points (integer, `_bp`) and formatted by the UI.

### 8.3 Centre-scope availability

| Family | Source has `centre_id`? | Visible to centre-restricted users |
|---|---|---|
| orders, centre_volume, referrer_volume, income, department_income, collections, referrer_billing, results, specimens, rejections, critical_values, tat, releases, deliveries, interface_messages, report_backlog, pending (live), agents (live) | yes (may be NULL on some rows; `results`/`critical_values` by CR-C8-004, `deliveries` by CR-C8-005 — all accepted) | yes — rows of their centres; NULL-centre rows hidden |
| (none in Phase 1) | — | a later family without a centre column would be replaced by `analytics.scope.tenant_wide_only` |

### 8.4 Reconciliation rules (tests and nightly self-check)

| Rule | Statement | Where checked |
|---|---|---|
| R1 | For any period and centre filter: M10 = Σ C4 B24 sales-register `total` (all statuses) and M11 = Σ C4 B26 credit-note-register `net`, same business dates (Asia/Kathmandu) | M6 integration gate only, with the real C4 module (`income_reconciles_to_registers`); not run against seeded views |
| R2 | Σ_department M21 = M12 | unit (SQL fixtures) + nightly self-check |
| R3 | rollup sums = view sums for every family and date in the trailing 7 days | nightly self-check `analytics.self_check` → metric + log, never auto-"fixes" figures silently (it re-marks dirty and alerts) |
| R4 | Σ_method M27 = Σ_staff M27 = Σ_centre M27 (incl. NULL centre) | unit |

### 8.5 Freshness

| Term | Definition |
|---|---|
| Family | a group of rollup tables refreshed together (02-TRD §9.1 table) |
| `refreshed_at` | finish time of the last successful refresh run of the family for this tenant |
| Stale | oldest dirty mark of the family older than 20 min [CONV `LIMS_ANALYTICS_STALE_DIRTY_MINUTES`], or last success older than 30 min [CONV `LIMS_ANALYTICS_STALE_SUCCESS_MINUTES`], or last attempt failed |
| Expected lag | ≤ 2 min after an evented change (debounce 60 s + run); ≤ 10 min for changes that emit no C8 event (payments, partial credit notes, first results) via the 10-minute sweep; ≤ 24 h for changes to dates older than yesterday that emit no event or are dirtied on a different day (nightly 40-day sweep) — this includes a specimen rejected after receipt (its TAT facts sit on the receipt day) and order items added/removed after registration (tests ordered M08/M32/M37 of the registration day; C8 consumes no items-changed event) (review m#25) |

## 9. Dependencies (contracts only)

| Contract | Owner | Use | Until owner merges |
|---|---|---|---|
| Views in 03-IC §6.1–§6.6 listing C8 as consumer | C4, C5, C6, C7, C3 | rollup sources and labels | C0 seed views over synthetic fixture tables (`packages/test-fixtures`) |
| Events in 03-IC §3.25 listing C8 | C4, C5, C6, C7 | dirty marking; `order_index` | fake publisher in tests |
| `IdentityPort.assertRole`, `getActor`, `getTenantSettings` (`referralIncentiveReportEnabled`, `calendarDisplay`, `timezone`) | C2 | authz, scope, flag | `@lims/fakes` IdentityPort fake |
| `ctx.core` (tenant, centres, branches, membership, user, membershipPermissions, `memberships.list` — 08 A17 D-47) | C0 | labels, staff names and recipient picker (P-17), scope re-validation | C0 core |
| `NotificationPort.sendEmailLink` | C6 | scheduled links | fake (CR-C8-007) |
| `RenderPort.renderPdf` | C6 (03-IC §4.16; CR-C4-004 primary, CR-C8-009 merged) | PDF export (worker, system actor; returns PDF bytes to C8) | feature disabled until C6 ships it |
| Routes `staff.billing.daily_cash`, `staff.lab.order_results`, `staff.analytics.*` (CR-C8-008) incl. `staff.analytics.collections` (08 A17 D-46) | C0 `routes.yaml` (03-IC §7) | links | — |

## 10. Blocked items and defaults built meanwhile

| Blocker | Effect on C8 | Default built now |
|---|---|---|
| B13 referral-incentive compliance position | report content and visibility | reporting only; no rate/amount/payout; tenant flag (default off) hides it entirely; never "commission" |
| B7 VAT / Health Service Tax | M15/M16 labels | columns shown as published; "Other tax" label until C4 tax-code display exists |
| B6/L8 invoice series granularity | none (C8 sums amounts, not numbers) | — |
| B15 retention | rollup retention | per-tenant `retentionYears` (default 5) + current FY |
| B3 test list | labels | synthetic catalog |
| B2 analyser models | interface health rows | whatever C7 publishes |

## 11. Open questions (owner: founder → client)

1. B13: if management later approves incentive *calculation*, which basis (net billed? per test?) and does TDS reporting per PAN belong in C8? (01 research §4.6.) Until then nothing beyond §6 US-07.
2. Should `finance` see the full dashboard? Default no (03-IC §11 grants); finance has its own collections page (D-46).
3. Is "patient visits" (visit-days) acceptable for the owner's "patients" tile, or is a distinct-person count over a range required? The latter needs a new view (CR candidate).
