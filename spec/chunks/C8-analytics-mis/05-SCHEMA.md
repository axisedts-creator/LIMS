# C8 Analytics & MIS — 05 Schema (`analytics`) — specification for C0-0B

Status: DECISION, 2026-11-06. This is the spec C0 transcribes into `db/migrations/*_analytics__*.sql` and `db/policies/analytics.sql`. Naming per CV §3; RLS per CV §5.8 (group role `lims_app`, X9); composite FKs per 04 D8. `analytics` is last in the DAG (CM §5 R3): it may reference `core` and nothing in other module schemas by FK (it reads them only through `v_pub_*` views); no schema references `analytics`.

**No FK into `billing`, `lab`, `frontdesk`, `reporting`, `instruments` or `catalog`** — rollup rows carry their ids as plain `uuid` (the source rows are owned elsewhere, and CV §5.4 forbids FKs into `billing`). FKs into `core.collection_centres`/`core.branches` are also **not** declared on rollup tables: a rollup is a copy of a view row, and deleting nothing in core is ever possible anyway (core M tables are never deleted, CV §5.6); omitting them keeps the delete+insert refresh cheap. FKs to `core` are declared on C8's own configuration tables (schedules, recipients, exports).

## 1. Table inventory

| Table | Class | Centre-scoped | PHI class (IC §1) | Written by | Retention |
|---|---|---|---|---|---|
| `analytics.g_cs_families` | G | — | P0 | migration seed | — |
| `analytics.g_cs_report_codes` | G | — | P0 | migration seed | — |
| `analytics.refresh_state` | E (state, no expiry) | no | P0 | system | life of tenant |
| `analytics.dirty_partitions` | E | no | P0 | system | deleted when processed |
| `analytics.refresh_runs` | E (run state updated by system; 08 A17 D-45) | no | P0 | system | 90 d (`expires_at = started_at + 90 days`) |
| `analytics.order_index` | E (rebuildable) | yes (nullable) | P1 | system (consumers, backfill seed) | 400 d (`expires_at = coalesce(registered_at, created_at) + 400 days`) |
| `analytics.daily_orders` | R (CR-C8-003) | yes | P1 | system | `retentionYears` + current FY |
| `analytics.daily_centre_volume` | R | yes | P1 | system | same |
| `analytics.daily_referrer_volume` | R | yes | P1 | system | same |
| `analytics.daily_income` | R | yes (nullable) | P1 (aggregate money) | system | same |
| `analytics.daily_department_income` | R | yes (nullable) | P1 | system | same |
| `analytics.daily_collections` | R | yes (nullable) | P1 (staff membership id) | system | same |
| `analytics.daily_referrer_billing` | R | yes (nullable) | P1 | system | same |
| `analytics.daily_results` | R | yes (nullable; order's collection centre, CR-C8-004) | P1 | system | same |
| `analytics.daily_specimens` | R | yes | P1 | system | same |
| `analytics.daily_rejections` | R | yes | P1 | system | same |
| `analytics.daily_critical_values` | R | yes (nullable; CR-C8-004) | P1 | system | same |
| `analytics.tat_facts` | R | yes | P1 (specimen/order ids + durations) | system | 3 FY |
| `analytics.daily_releases` | R | yes | P1 | system | `retentionYears` + FY |
| `analytics.daily_deliveries` | R | yes (nullable; NULL = non-report delivery; CR-C8-005, 08 A17 D-48) | P1 | system | same |
| `analytics.daily_interface_messages` | R | yes | P0 | system | same |
| `analytics.report_backlog` | R (snapshot) | yes | P1 | system | replaced every refresh |
| `analytics.exports` | E (lifecycle) | no (scope snapshot columns) | P1 | user insert, system update | 400 d |
| `analytics.export_files` | E | no | **P2** (doctor/staff names, aggregate money) | system | ≤ 24 h |
| `analytics.schedules` | M | no (scope columns) | P1 (+ name free text) | user | never deleted (deactivate) |
| `analytics.schedule_recipients` | M (08 A17 D-45) | no | P1 | user | never deleted; removed recipients are deactivated (`is_active = false`) |
| `analytics.report_runs` | E (run state updated by system; D-45) | no | P1 | system | 400 d (`expires_at = created_at + 400 days`) |
| `analytics.report_run_recipients` | E (D-45) | no | P1 | system | 400 d (`expires_at = created_at + 400 days`) |
| `analytics.event_inbox` | A | no | P1 | worker core (C0, IC §12) | 90 d (C0 purge) |

Class R (CR-C8-003): derived, rebuildable from `v_pub_*`; natural composite unique key with `tenant_id` leading; columns `refresh_run_id`, `refreshed_at`; INSERT/DELETE only by actor_type `system`; no UPDATE grant; no audit trigger (the source tables are audited, 04 D11).

Class rule (08 A17 P-18(a)): no C8 table is class A, B or C. Every table whose rows `lims_app` updates (run state) or deletes on expiry is class E; its retention delete runs in the `per_tenant` task `analytics.purge` as the system actor under `<t>__delete__tenant` (P-18(c)); no `lims_owner` purge function exists. `analytics.event_inbox` is C0's (03-IC §12).

**Mandatory-column exceptions** (08 A17 P-18(b), D-45; copied to `db/meta/tables.yaml`):

| Table | Class | Omitted | Reason |
|---|---|---|---|
| `refresh_state` | E | `id`, `expires_at`, `version`, `is_active` | one row per `(tenant_id, family)` = PK; lives for the life of the tenant; users never edit it (only the `_manual` throttle timestamp) |
| `dirty_partitions` | E | `id`, `expires_at` | one row per `(tenant_id, family, business_date)` = PK; deleted when processed |
| `export_files` | E | `id` | one row per export, PK `(tenant_id, export_id)`; has `expires_at` |
| `order_index` | E | `id` | one row per order, PK `(tenant_id, order_id)`; has `expires_at` |
| `g_cs_families`, `g_cs_report_codes` | G | `id` | global coded sets in the 02-CV §5.5 shape `(code, display, system, system_version, sort_order, is_active)`; natural key `code` = PK; seeded by migration, never edited by users (final check 2026-11-06: listed here because 02-CV §5.2 makes `id` mandatory for G) |

`report_run_recipients` is not an exception: it gets `id` (PK) with the natural key as `UNIQUE (tenant_id, report_run_id, membership_id)` [CONV: D-45 lists no exception for it, so the E mandatory columns apply].

"Centre-scoped (nullable)" = row has `centre_id uuid NULL`; the SELECT policy lets centre-restricted readers see only non-NULL centre ids in their scope; NULL-centre rows are visible to all-centre readers only (PRD §8.3).

## 2. Columns by table (summary; DDL in §6 is authoritative)

Common R columns: `tenant_id uuid NOT NULL`, `business_date date NOT NULL`, `refresh_run_id uuid NOT NULL`, `refreshed_at timestamptz NOT NULL DEFAULT now()`. Counts `bigint NOT NULL DEFAULT 0 CHECK (≥ 0)`; money `bigint` paisa (may be negative only where the source can be: department/referrer net, net sales).

| Table | Grouping columns (unique key, in order) | Measures (source column, IC §6) |
|---|---|---|
| daily_orders | tenant_id, business_date, branch_id, centre_id | orders_registered, patients_distinct, new_patients, urgent_orders, cancelled_orders, opd_orders, ipd_orders |
| daily_centre_volume | tenant_id, business_date, branch_id, centre_id, collection_mode | orders, patients_distinct, order_items |
| daily_referrer_volume | tenant_id, business_date, branch_id, centre_id, referrer_id (NULLS NOT DISTINCT) | orders, patients_distinct, order_items |
| daily_income | tenant_id, business_date, branch_id, centre_id (NULLS NOT DISTINCT) | invoices_issued, invoices_cancelled, gross_paisa, discount_paisa, exempt_paisa, taxable_paisa, vat_paisa, other_tax_paisa, net_paisa, credit_notes_paisa |
| daily_department_income | tenant_id, business_date, branch_id, centre_id, department_id (NNDistinct) | line_count, gross_paisa, discount_paisa, net_paisa (signed) |
| daily_collections | tenant_id, business_date, branch_id, centre_id, collected_by_membership_id, payment_method_code (NND) | entries, reversals, gross_collected_paisa, reversed_paisa, net_collected_paisa (signed) |
| daily_referrer_billing | tenant_id, business_date, centre_id, referrer_id (NND) | orders, net_billed_paisa (signed) |
| daily_results | tenant_id, business_date, processing_branch_id, department_id, test_id, centre_id (NND) | results_resulted, results_verified, results_approved, results_amended, auto_verified, critical_count, abnormal_count, tests_approved (CR-C8-004) |
| daily_specimens | tenant_id, business_date, centre_id, processing_branch_id, specimen_type_code, priority (NND) | collected, received, rejected |
| daily_rejections | tenant_id, business_date, centre_id, specimen_type_code, reason_code (NND) | rejections, recollections_ordered |
| daily_critical_values | tenant_id, business_date, analyte_id, centre_id (NND) | detected, notified, median_notify_seconds (NULL when none notified), max_notify_seconds (same) |
| tat_facts | tenant_id, segment, subject_id | centre_id, processing_branch_id, priority, specimen_type_code, started_at, stopped_at, business_date, duration_seconds, is_anomaly |
| daily_releases | tenant_id, business_date, centre_id, report_kind, release_basis (NND) | released |
| daily_deliveries | tenant_id, business_date, channel, purpose, recipient_kind (unknown values mapped to `other`, 08 A13 D-3), centre_id (NND; CR-C8-005) | queued, sent, delivered, read, failed, suppressed (cohort = delivery creation date, 08 A17 D-48) |
| daily_interface_messages | tenant_id, business_date, instrument_id, centre_id | messages, patient_records, qc_records, unmatched, quarantined, duplicates |
| report_backlog | tenant_id, centre_id, stage, age_bucket (NND) | orders, oldest_registered_at |

## 3. RLS (all tables ENABLE + FORCE RLS; owner `lims_owner`; policies `TO lims_app`; helpers wrapped in `(SELECT …)` — REQ-SEC-022)

Predicates used below (transcribed literally into the §6 DDL; 08 A17 P-16, A16.1):

```sql
-- pred_t — every __tenant policy (P-16: staff-actor guard in the predicate itself)
tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
-- pred_c — __tenant_centre SELECT on class R (nullable centre). No staff term is needed (C5 05-SCHEMA §3 precedent):
--          app.has_all_centres() / app.current_centre_ids() are false / empty for partner, portal and patient actors (08 R3).
tenant_id = (SELECT app.current_tenant_id())
  AND ((SELECT app.has_all_centres()) OR (centre_id IS NOT NULL AND centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])))
-- P_SYSTEM
(SELECT app.current_actor_type()) = 'system'
-- P_SELF (current membership)
requested_by_membership_id = (SELECT nullif(app.current_claims() ->> 'membership_id', '')::uuid)
```

Policy names use the 02-CV §5.8 scopes `tenant` / `tenant_centre`, one name per policy, identical here and in §6 (review m#17). The only qualifier is `_manual` on the two `refresh_state` policies for the user-written throttle row (named as in `review/_triage-batch2.md` §(c), 08 A17 P-22).

| Table(s) | SELECT | INSERT | UPDATE | DELETE |
|---|---|---|---|---|
| class R: daily_orders, daily_centre_volume, daily_referrer_volume, daily_income, daily_department_income, daily_collections, daily_referrer_billing, daily_results, daily_specimens, daily_rejections, daily_critical_values, tat_facts, daily_releases, daily_deliveries, daily_interface_messages, report_backlog | `__select__tenant_centre`: pred_c | `__insert__tenant`: pred_t AND P_SYSTEM | none (no grant) | `__delete__tenant`: pred_t AND P_SYSTEM (partition replace; class R rule, CR-C8-003) |
| refresh_state | `__select__tenant`: pred_t | `__insert__tenant`: pred_t AND P_SYSTEM; `__insert__tenant_manual`: pred_t AND family = '_manual' (P-22: the one row kind a user writes first) | `__update__tenant`: pred_t AND P_SYSTEM; `__update__tenant_manual`: pred_t AND family = '_manual' (USING + WITH CHECK) | none |
| dirty_partitions | `__select__tenant`: pred_t (freshness endpoint reads oldest mark) | `__insert__tenant`: pred_t (manual refresh by users inserts marks) | `__update__tenant`: pred_t (upsert `last_marked_at`) | `__delete__tenant`: pred_t AND P_SYSTEM (deleted when processed; no expiry) |
| refresh_runs | `__select__tenant`: pred_t | `__insert__tenant`: pred_t AND P_SYSTEM | `__update__tenant`: pred_t AND P_SYSTEM (finish columns only, trigger §5) | `__delete__tenant`: pred_t AND P_SYSTEM AND expires_at < now() (P-18(c)) |
| order_index | `__select__tenant`: pred_t AND P_SYSTEM (only C8's worker reads it; API reads `report_backlog`) | `__insert__tenant`: pred_t AND P_SYSTEM | `__update__tenant`: pred_t AND P_SYSTEM | `__delete__tenant`: pred_t AND P_SYSTEM AND expires_at < now() |
| exports | `__select__tenant`: pred_t AND (P_SELF OR P_SYSTEM) | `__insert__tenant`: pred_t AND P_SELF AND status = 'queued' | `__update__tenant`: pred_t AND (P_SELF OR P_SYSTEM) (column guard trigger §5 lets users change only `downloads_used`) | `__delete__tenant`: pred_t AND P_SYSTEM AND requested_at < now() − 400 d (its `expires_at` is the file expiry, see TRD §9.5) |
| export_files | `__select__tenant`: pred_t AND (P_SYSTEM OR EXISTS own export) | `__insert__tenant`: pred_t AND P_SYSTEM | none | `__delete__tenant`: pred_t AND P_SYSTEM (also before `expires_at` when downloads are exhausted) |
| schedules | `__select__tenant`: pred_t | `__insert__tenant`: pred_t | `__update__tenant`: pred_t | none (M) |
| schedule_recipients | `__select__tenant`: pred_t | `__insert__tenant`: pred_t | `__update__tenant`: pred_t (deactivate / reactivate, 08 A17 D-45) | none (M) |
| report_runs | `__select__tenant`: pred_t AND (P_SYSTEM OR EXISTS recipient row for the current membership OR schedule owner) | `__insert__tenant`: pred_t AND P_SYSTEM | `__update__tenant`: pred_t AND P_SYSTEM (`state`, `omitted_report_codes`, counts only — trigger) | `__delete__tenant`: pred_t AND P_SYSTEM AND expires_at < now() |
| report_run_recipients | `__select__tenant`: pred_t AND (P_SYSTEM OR membership_id = current membership OR owner of `schedule_id`) | `__insert__tenant`: pred_t AND P_SYSTEM | none | `__delete__tenant`: pred_t AND P_SYSTEM AND expires_at < now() |
| g_cs_* | no RLS (class G; listed in `db/tests/rls_exempt.txt`: "global coded set, no tenant data"); SELECT to `lims_app` | — | — | — |

Notes:
- `app.has_all_centres()` is true for system actors (CV §5.8), so worker refreshes and exports see every row; exports apply the snapshot scope explicitly (TRD §10.2).
- Permission checks (e.g. `analytics.schedule.manage`) are application-level (IdentityPort); RLS enforces tenant, staff actor, centre and ownership only.
- `report_run_recipients` carries `schedule_id` so its owner branch reads `analytics.schedules` directly. Reaching the owner through `report_runs` would make the `report_runs` and `report_run_recipients` policies reference each other, which PostgreSQL rejects (`infinite recursion detected in policy`; reproduced with a two-table mutual-reference policy pair on a scratch PostgreSQL 16.15, 2026-11-06). The §6 DDL itself was run on the same scratch server with stub `core`/`app` objects: it parses, every non-G table has ENABLE + FORCE RLS, and recipient / owner / partner / centre-scope / `_manual` throttle probes behave as §3 states.
- `lims_analytics` (reserved BI role, CV §5.9) gets **no** grant on `analytics.*` in v1.

Grants (`lims_app`): SELECT on all `analytics` tables; INSERT on all except G; UPDATE on refresh_state, dirty_partitions, refresh_runs, order_index, exports, schedules, schedule_recipients, report_runs; DELETE on the class R tables (partition replace) and on the class E tables dirty_partitions, refresh_runs, order_index, exports, export_files, report_runs, report_run_recipients (08 A17 P-18(c)). **No** DELETE on `schedules` or `schedule_recipients` (M, deactivate only; D-45) and none on `refresh_state`. CI asserts the grant matrix, including `has_table_privilege('lims_app', 'analytics.schedule_recipients', 'DELETE') = false`.

## 4. Coded sets and seed data

`analytics.g_cs_families (code, display, system, system_version, sort_order, is_active)` seed: `orders`, `centre_volume`, `referrer_volume`, `income`, `department_income`, `collections`, `referrer_billing`, `results`, `specimens`, `rejections`, `critical_values`, `tat`, `releases`, `deliveries`, `interface_messages`, `report_backlog`, and the internal row `_manual` (manual-refresh throttle; `is_active = false` so it never appears in UI lists).

`analytics.g_cs_report_codes` seed (TRD §3.3): `dashboard`, `income`, `department_income`, `collections`, `volume`, `top_referrers`, `top_centres`, `referral_incentive`, `tests_done`, `tat`, `pending_tests`, `quality_indicators`, `delivery`, `interfaces`; extra columns `is_exportable boolean`, `is_schedulable boolean` (`interfaces`: schedulable false).

No tenant seed data. Synthetic test data comes from `packages/test-fixtures` writing the **source** tables of other schemas (as `lims_owner` in the harness) so that views produce rows; C8 rollups are then built by the refresh code under test (never seeded directly, except in pure SQL unit tests of the read queries).

## 5. Triggers and constraints beyond CHECKs

| Object | Rule |
|---|---|
| `analytics.exports` | `app.enforce_mutable_columns('status','building_started_at','ready_at','expires_at','row_count','size_bytes','sha256','downloads_used','failure_code','scope_effective_centre_ids','updated_at','updated_by','version')`; plus `analytics.exports_transition_guard()` BEFORE UPDATE: allowed status pairs = TRD/App-Flow §4.1 (queued→building, building→queued, building→ready, queued|building→failed, ready→expired); `downloads_used` may only increase by 1 and ≤ `downloads_allowed`; when the actor type is not `system`, only `downloads_used`, `updated_at`, `updated_by`, `version` may change |
| `analytics.refresh_runs` | `enforce_mutable_columns('finished_at','status','rows_written','error_code')`; status `running → succeeded|failed` only |
| `analytics.report_runs` | `enforce_mutable_columns('state','omitted_report_codes','sent_count','skipped_count')` |
| `analytics.schedules` | M-class: `version = version + 1` by repository; audit trigger (C0, 04 D11) attached |
| `analytics.schedule_recipients` | M-class: `version = version + 1`, `updated_*` by repository; audit trigger attached; `analytics.schedule_recipients_cap()` counts only `is_active` rows (≤ 20 active per schedule); a removed recipient is set `is_active = false`, re-adding reactivates the same row (08 A17 D-45) |
| R tables, refresh_state, dirty_partitions, refresh_runs, order_index, export_files, report_runs, report_run_recipients | no audit trigger (derived/ephemeral, class R/E; CR-C8-003). `export_files` content is never logged |

SQLSTATE `P0001 immutable_row` → `409 common.immutable_record` (CV §5.7) — reachable only by code bugs.

## 6. DDL

```sql
-- ===================== analytics: coded sets (G) =====================
CREATE TABLE analytics.g_cs_families (
  code text NOT NULL, display text NOT NULL, system text NOT NULL DEFAULT 'lims', system_version text NOT NULL DEFAULT '1',
  sort_order integer NOT NULL DEFAULT 0, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT g_cs_families__pk PRIMARY KEY (code),
  CONSTRAINT g_cs_families__code__ck CHECK (code ~ '^_?[a-z_]{2,40}$')
);
CREATE TABLE analytics.g_cs_report_codes (
  code text NOT NULL, display text NOT NULL, system text NOT NULL DEFAULT 'lims', system_version text NOT NULL DEFAULT '1',
  sort_order integer NOT NULL DEFAULT 0, is_active boolean NOT NULL DEFAULT true,
  is_exportable boolean NOT NULL DEFAULT true, is_schedulable boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT g_cs_report_codes__pk PRIMARY KEY (code),
  CONSTRAINT g_cs_report_codes__code__ck CHECK (code ~ '^[a-z_]{2,40}$'),
  CONSTRAINT g_cs_report_codes__no_c_word__ck CHECK (code !~* 'commission' AND display !~* 'commission')   -- 04 L19
);
GRANT SELECT ON analytics.g_cs_families, analytics.g_cs_report_codes TO lims_app;

-- ===================== refresh bookkeeping =====================
CREATE TABLE analytics.refresh_state (
  tenant_id uuid NOT NULL, family text NOT NULL,
  last_success_at timestamptz, last_attempt_at timestamptz, last_error_code text, consecutive_failures integer NOT NULL DEFAULT 0,
  last_run_id uuid, last_manual_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  CONSTRAINT refresh_state__pk PRIMARY KEY (tenant_id, family),
  CONSTRAINT refresh_state__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT refresh_state__family__fk FOREIGN KEY (family) REFERENCES analytics.g_cs_families (code),
  CONSTRAINT refresh_state__failures__ck CHECK (consecutive_failures >= 0),
  CONSTRAINT refresh_state__error__ck CHECK (last_error_code IS NULL OR char_length(last_error_code) <= 64)
);

CREATE TABLE analytics.dirty_partitions (
  tenant_id uuid NOT NULL, family text NOT NULL, business_date date NOT NULL,
  first_marked_at timestamptz NOT NULL DEFAULT now(), last_marked_at timestamptz NOT NULL DEFAULT now(),
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  CONSTRAINT dirty_partitions__pk PRIMARY KEY (tenant_id, family, business_date),
  CONSTRAINT dirty_partitions__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT dirty_partitions__family__fk FOREIGN KEY (family) REFERENCES analytics.g_cs_families (code),
  CONSTRAINT dirty_partitions__reason__ck CHECK (reason IN ('event','sweep_recent','sweep_nightly','manual','self_check','backfill')),
  CONSTRAINT dirty_partitions__snapshot__ck CHECK ((family = 'report_backlog') = (business_date = DATE '1970-01-01'))
);
CREATE INDEX dirty_partitions__tenant_id_marked__idx ON analytics.dirty_partitions (tenant_id, family, first_marked_at);

CREATE TABLE analytics.refresh_runs (
  id uuid NOT NULL, tenant_id uuid NOT NULL, family text NOT NULL,
  trigger text NOT NULL, date_from date, date_to date,
  started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
  status text NOT NULL DEFAULT 'running', rows_written bigint, error_code text,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  expires_at timestamptz NOT NULL,                                      -- started_at + 90 days, set by the repository (08 A17 D-45)
  CONSTRAINT refresh_runs__pk PRIMARY KEY (id),
  CONSTRAINT refresh_runs__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT refresh_runs__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT refresh_runs__family__fk FOREIGN KEY (family) REFERENCES analytics.g_cs_families (code),
  CONSTRAINT refresh_runs__trigger__ck CHECK (trigger IN ('event','sweep_recent','sweep_nightly','manual','self_check','backfill')),
  CONSTRAINT refresh_runs__status__ck CHECK (status IN ('running','succeeded','failed')),
  CONSTRAINT refresh_runs__range__ck CHECK (date_from IS NULL OR date_to > date_from)
);
CREATE INDEX refresh_runs__tenant_id_family_started__idx ON analytics.refresh_runs (tenant_id, family, started_at DESC);
CREATE INDEX refresh_runs__tenant_id_expiry__idx ON analytics.refresh_runs (tenant_id, expires_at);

CREATE TABLE analytics.order_index (
  tenant_id uuid NOT NULL, order_id uuid NOT NULL,
  centre_id uuid, branch_id uuid, referrer_id uuid,
  registered_at timestamptz, registered_on date, cancelled_at timestamptz,
  source_event_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  expires_at timestamptz NOT NULL,                                      -- coalesce(registered_at, created_at) + 400 days (D-45)
  CONSTRAINT order_index__pk PRIMARY KEY (tenant_id, order_id),
  CONSTRAINT order_index__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT order_index__dates__ck CHECK ((registered_at IS NULL) = (registered_on IS NULL))
);
CREATE INDEX order_index__tenant_id_open__p_idx ON analytics.order_index (tenant_id, registered_at)
  WHERE cancelled_at IS NULL;
CREATE INDEX order_index__tenant_id_expiry__idx ON analytics.order_index (tenant_id, expires_at);

-- ===================== rollups (class R) =====================
CREATE TABLE analytics.daily_orders (
  tenant_id uuid NOT NULL, business_date date NOT NULL, branch_id uuid NOT NULL, centre_id uuid NOT NULL,
  orders_registered bigint NOT NULL DEFAULT 0, patients_distinct bigint NOT NULL DEFAULT 0, new_patients bigint NOT NULL DEFAULT 0,
  urgent_orders bigint NOT NULL DEFAULT 0, cancelled_orders bigint NOT NULL DEFAULT 0,
  opd_orders bigint NOT NULL DEFAULT 0, ipd_orders bigint NOT NULL DEFAULT 0,
  refresh_run_id uuid NOT NULL, refreshed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT daily_orders__pk PRIMARY KEY (tenant_id, business_date, branch_id, centre_id),
  CONSTRAINT daily_orders__nonneg__ck CHECK (orders_registered >= 0 AND patients_distinct >= 0 AND new_patients >= 0
     AND urgent_orders >= 0 AND cancelled_orders >= 0 AND opd_orders >= 0 AND ipd_orders >= 0)
);

CREATE TABLE analytics.daily_centre_volume (
  tenant_id uuid NOT NULL, business_date date NOT NULL, branch_id uuid NOT NULL, centre_id uuid NOT NULL,
  collection_mode text NOT NULL,
  orders bigint NOT NULL DEFAULT 0, patients_distinct bigint NOT NULL DEFAULT 0, order_items bigint NOT NULL DEFAULT 0,
  refresh_run_id uuid NOT NULL, refreshed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT daily_centre_volume__pk PRIMARY KEY (tenant_id, business_date, branch_id, centre_id, collection_mode),
  CONSTRAINT daily_centre_volume__mode__ck CHECK (collection_mode IN ('walk_in','home','centre','partner')),
  CONSTRAINT daily_centre_volume__nonneg__ck CHECK (orders >= 0 AND patients_distinct >= 0 AND order_items >= 0)
);

CREATE TABLE analytics.daily_referrer_volume (
  tenant_id uuid NOT NULL, business_date date NOT NULL, branch_id uuid NOT NULL, centre_id uuid NOT NULL,
  referrer_id uuid,                                                     -- NULL = SELF
  orders bigint NOT NULL DEFAULT 0, patients_distinct bigint NOT NULL DEFAULT 0, order_items bigint NOT NULL DEFAULT 0,
  refresh_run_id uuid NOT NULL, refreshed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT daily_referrer_volume__key__uq UNIQUE NULLS NOT DISTINCT (tenant_id, business_date, branch_id, centre_id, referrer_id),
  CONSTRAINT daily_referrer_volume__nonneg__ck CHECK (orders >= 0 AND patients_distinct >= 0 AND order_items >= 0)
);
CREATE INDEX daily_referrer_volume__tenant_id_referrer__idx ON analytics.daily_referrer_volume (tenant_id, referrer_id, business_date);

CREATE TABLE analytics.daily_income (
  tenant_id uuid NOT NULL, business_date date NOT NULL, branch_id uuid NOT NULL, centre_id uuid,
  invoices_issued bigint NOT NULL DEFAULT 0, invoices_cancelled bigint NOT NULL DEFAULT 0,
  gross_paisa bigint NOT NULL DEFAULT 0, discount_paisa bigint NOT NULL DEFAULT 0, exempt_paisa bigint NOT NULL DEFAULT 0,
  taxable_paisa bigint NOT NULL DEFAULT 0, vat_paisa bigint NOT NULL DEFAULT 0, other_tax_paisa bigint NOT NULL DEFAULT 0,
  net_paisa bigint NOT NULL DEFAULT 0, credit_notes_paisa bigint NOT NULL DEFAULT 0,
  refresh_run_id uuid NOT NULL, refreshed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT daily_income__key__uq UNIQUE NULLS NOT DISTINCT (tenant_id, business_date, branch_id, centre_id),
  CONSTRAINT daily_income__nonneg__ck CHECK (invoices_issued >= 0 AND invoices_cancelled >= 0 AND gross_paisa >= 0
     AND discount_paisa >= 0 AND exempt_paisa >= 0 AND taxable_paisa >= 0 AND vat_paisa >= 0 AND other_tax_paisa >= 0
     AND net_paisa >= 0 AND credit_notes_paisa >= 0)
);

CREATE TABLE analytics.daily_department_income (
  tenant_id uuid NOT NULL, business_date date NOT NULL, branch_id uuid NOT NULL, centre_id uuid,
  department_id uuid,                                                   -- NULL = multiple departments (package)
  line_count bigint NOT NULL DEFAULT 0, gross_paisa bigint NOT NULL DEFAULT 0, discount_paisa bigint NOT NULL DEFAULT 0,
  net_paisa bigint NOT NULL DEFAULT 0,                                  -- signed: credit-note lines negative
  refresh_run_id uuid NOT NULL, refreshed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT daily_department_income__key__uq UNIQUE NULLS NOT DISTINCT (tenant_id, business_date, branch_id, centre_id, department_id),
  CONSTRAINT daily_department_income__lines__ck CHECK (line_count >= 0)
);

CREATE TABLE analytics.daily_collections (
  tenant_id uuid NOT NULL, business_date date NOT NULL, branch_id uuid NOT NULL, centre_id uuid,
  collected_by_membership_id uuid, payment_method_code text NOT NULL,   -- NULL = gateway capture (C4 ledger CHECK, 08 R8)
  entries bigint NOT NULL DEFAULT 0, reversals bigint NOT NULL DEFAULT 0,
  gross_collected_paisa bigint NOT NULL DEFAULT 0, reversed_paisa bigint NOT NULL DEFAULT 0, net_collected_paisa bigint NOT NULL DEFAULT 0,
  refresh_run_id uuid NOT NULL, refreshed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT daily_collections__key__uq UNIQUE NULLS NOT DISTINCT
     (tenant_id, business_date, branch_id, centre_id, collected_by_membership_id, payment_method_code),
  CONSTRAINT daily_collections__nonneg__ck CHECK (entries >= 0 AND reversals >= 0 AND gross_collected_paisa >= 0 AND reversed_paisa >= 0),
  CONSTRAINT daily_collections__method__ck CHECK (char_length(payment_method_code) BETWEEN 1 AND 64)
);
CREATE INDEX daily_collections__tenant_id_staff__idx ON analytics.daily_collections (tenant_id, collected_by_membership_id, business_date);

CREATE TABLE analytics.daily_referrer_billing (
  tenant_id uuid NOT NULL, business_date date NOT NULL, centre_id uuid, referrer_id uuid NOT NULL,
  orders bigint NOT NULL DEFAULT 0, net_billed_paisa bigint NOT NULL DEFAULT 0,   -- signed
  refresh_run_id uuid NOT NULL, refreshed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT daily_referrer_billing__key__uq UNIQUE NULLS NOT DISTINCT (tenant_id, business_date, centre_id, referrer_id),
  CONSTRAINT daily_referrer_billing__orders__ck CHECK (orders >= 0)
);
CREATE INDEX daily_referrer_billing__tenant_id_referrer__idx ON analytics.daily_referrer_billing (tenant_id, referrer_id, business_date);
-- billing.v_pub_referrer_billing excludes rows without referrer (C4 05-SCHEMA §6), hence referrer_id NOT NULL here.

CREATE TABLE analytics.daily_results (
  tenant_id uuid NOT NULL, business_date date NOT NULL, processing_branch_id uuid, department_id uuid, test_id uuid,
  centre_id uuid,                                                       -- order's collection centre (lab.v_pub_result_daily, CR-C8-004)
  results_resulted bigint NOT NULL DEFAULT 0, results_verified bigint NOT NULL DEFAULT 0, results_approved bigint NOT NULL DEFAULT 0,
  results_amended bigint NOT NULL DEFAULT 0, auto_verified bigint NOT NULL DEFAULT 0, critical_count bigint NOT NULL DEFAULT 0,
  abnormal_count bigint NOT NULL DEFAULT 0, tests_approved bigint NOT NULL DEFAULT 0,   -- order tests approved (CR-C8-004)
  refresh_run_id uuid NOT NULL, refreshed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT daily_results__key__uq UNIQUE NULLS NOT DISTINCT (tenant_id, business_date, processing_branch_id, department_id, test_id, centre_id),
  CONSTRAINT daily_results__nonneg__ck CHECK (results_resulted >= 0 AND results_verified >= 0 AND results_approved >= 0
     AND results_amended >= 0 AND auto_verified >= 0 AND critical_count >= 0 AND abnormal_count >= 0
     AND tests_approved >= 0)
);

CREATE TABLE analytics.daily_specimens (
  tenant_id uuid NOT NULL, business_date date NOT NULL, centre_id uuid NOT NULL, processing_branch_id uuid,
  specimen_type_code text NOT NULL, priority text NOT NULL,
  collected bigint NOT NULL DEFAULT 0, received bigint NOT NULL DEFAULT 0, rejected bigint NOT NULL DEFAULT 0,
  refresh_run_id uuid NOT NULL, refreshed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT daily_specimens__key__uq UNIQUE NULLS NOT DISTINCT
     (tenant_id, business_date, centre_id, processing_branch_id, specimen_type_code, priority),
  CONSTRAINT daily_specimens__priority__ck CHECK (priority IN ('routine','urgent')),
  CONSTRAINT daily_specimens__nonneg__ck CHECK (collected >= 0 AND received >= 0 AND rejected >= 0)
);

CREATE TABLE analytics.daily_rejections (
  tenant_id uuid NOT NULL, business_date date NOT NULL, centre_id uuid NOT NULL, specimen_type_code text NOT NULL,
  reason_code text,
  rejections bigint NOT NULL DEFAULT 0, recollections_ordered bigint NOT NULL DEFAULT 0,
  refresh_run_id uuid NOT NULL, refreshed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT daily_rejections__key__uq UNIQUE NULLS NOT DISTINCT (tenant_id, business_date, centre_id, specimen_type_code, reason_code),
  CONSTRAINT daily_rejections__nonneg__ck CHECK (rejections >= 0 AND recollections_ordered >= 0)
);

CREATE TABLE analytics.daily_critical_values (
  tenant_id uuid NOT NULL, business_date date NOT NULL, analyte_id uuid NOT NULL,
  centre_id uuid,                                                       -- lab.v_pub_critical_value_daily.centre_id (CR-C8-004)
  detected bigint NOT NULL DEFAULT 0, notified bigint NOT NULL DEFAULT 0,
  median_notify_seconds bigint, max_notify_seconds bigint,
  refresh_run_id uuid NOT NULL, refreshed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT daily_critical_values__key__uq UNIQUE NULLS NOT DISTINCT (tenant_id, business_date, analyte_id, centre_id),
  CONSTRAINT daily_critical_values__counts__ck CHECK (detected >= 0 AND notified >= 0 AND notified <= detected)
);

CREATE TABLE analytics.tat_facts (
  tenant_id uuid NOT NULL, segment text NOT NULL, subject_id uuid NOT NULL,     -- specimen_id or order_id
  centre_id uuid, processing_branch_id uuid, priority text, specimen_type_code text,
  started_at timestamptz NOT NULL, stopped_at timestamptz NOT NULL, business_date date NOT NULL,
  duration_seconds bigint NOT NULL, is_anomaly boolean NOT NULL,
  refresh_run_id uuid NOT NULL, refreshed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tat_facts__pk PRIMARY KEY (tenant_id, segment, subject_id),
  CONSTRAINT tat_facts__segment__ck CHECK (segment IN ('pre_analytical','transport','within_lab','total_first_release','total_final_release')),
  CONSTRAINT tat_facts__priority__ck CHECK (priority IS NULL OR priority IN ('routine','urgent')),
  CONSTRAINT tat_facts__anomaly__ck CHECK (is_anomaly = (stopped_at < started_at))
);
CREATE INDEX tat_facts__tenant_id_segment_date__idx ON analytics.tat_facts (tenant_id, segment, business_date) INCLUDE (centre_id, duration_seconds, is_anomaly);

CREATE TABLE analytics.daily_releases (
  tenant_id uuid NOT NULL, business_date date NOT NULL, centre_id uuid NOT NULL,
  report_kind text NOT NULL, release_basis text NOT NULL, released bigint NOT NULL DEFAULT 0,
  refresh_run_id uuid NOT NULL, refreshed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT daily_releases__pk PRIMARY KEY (tenant_id, business_date, centre_id, report_kind, release_basis),
  CONSTRAINT daily_releases__kind__ck CHECK (report_kind IN ('final','partial','preliminary','amended','addendum')),   -- addendum: 08 R1
  CONSTRAINT daily_releases__basis__ck CHECK (release_basis IN ('paid_in_full','zero_balance','credit_party','override','policy_not_enforced')),
  CONSTRAINT daily_releases__nonneg__ck CHECK (released >= 0)
);

CREATE TABLE analytics.daily_deliveries (
  tenant_id uuid NOT NULL, business_date date NOT NULL, channel text NOT NULL, purpose text NOT NULL, recipient_kind text NOT NULL,
  centre_id uuid,                                                       -- v_pub_delivery_daily.centre_id; NULL = non-report delivery (CR-C8-005, D-48)
  queued bigint NOT NULL DEFAULT 0, sent bigint NOT NULL DEFAULT 0, delivered bigint NOT NULL DEFAULT 0, "read" bigint NOT NULL DEFAULT 0,
  failed bigint NOT NULL DEFAULT 0, suppressed bigint NOT NULL DEFAULT 0,
  refresh_run_id uuid NOT NULL, refreshed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT daily_deliveries__key__uq UNIQUE NULLS NOT DISTINCT (tenant_id, business_date, channel, purpose, recipient_kind, centre_id),
  CONSTRAINT daily_deliveries__channel__ck CHECK (channel IN ('whatsapp','sms','email','print','portal')),
  CONSTRAINT daily_deliveries__recipient__ck CHECK (char_length(recipient_kind) BETWEEN 1 AND 32),   -- x-extensible (08 A13 P-4/D-3);
                                                                        -- refresh maps unknown values to 'other' (TRD §9.2)
  CONSTRAINT daily_deliveries__nonneg__ck CHECK (queued >= 0 AND sent >= 0 AND delivered >= 0 AND "read" >= 0 AND failed >= 0 AND suppressed >= 0)
);

CREATE TABLE analytics.daily_interface_messages (
  tenant_id uuid NOT NULL, business_date date NOT NULL, instrument_id uuid NOT NULL, centre_id uuid NOT NULL,
  messages bigint NOT NULL DEFAULT 0, patient_records bigint NOT NULL DEFAULT 0, qc_records bigint NOT NULL DEFAULT 0,
  unmatched bigint NOT NULL DEFAULT 0, quarantined bigint NOT NULL DEFAULT 0, duplicates bigint NOT NULL DEFAULT 0,
  refresh_run_id uuid NOT NULL, refreshed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT daily_interface_messages__pk PRIMARY KEY (tenant_id, business_date, instrument_id, centre_id),
  CONSTRAINT daily_interface_messages__nonneg__ck CHECK (messages >= 0 AND patient_records >= 0 AND qc_records >= 0
     AND unmatched >= 0 AND quarantined >= 0 AND duplicates >= 0)
);

CREATE TABLE analytics.report_backlog (
  tenant_id uuid NOT NULL, centre_id uuid, stage text NOT NULL, age_bucket text NOT NULL,
  orders bigint NOT NULL DEFAULT 0, oldest_registered_at timestamptz,
  refresh_run_id uuid NOT NULL, refreshed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT report_backlog__key__uq UNIQUE NULLS NOT DISTINCT (tenant_id, centre_id, stage, age_bucket),
  CONSTRAINT report_backlog__stage__ck CHECK (stage IN ('awaiting_results','ready_unreleased')),
  CONSTRAINT report_backlog__bucket__ck CHECK (age_bucket IN ('lt_4h','h4_24','d1_3','gt_3d')),
  CONSTRAINT report_backlog__nonneg__ck CHECK (orders >= 0)
);

-- Unique constraints above lead with (tenant_id, business_date) and serve the report range queries
-- (WHERE tenant_id = $1 AND business_date >= $2 AND business_date < $3). Additional per-report indexes: listed in §7.

-- ===================== exports =====================
CREATE TABLE analytics.exports (
  id uuid NOT NULL, tenant_id uuid NOT NULL,
  requested_by_membership_id uuid NOT NULL,
  report_code text NOT NULL, format text NOT NULL, params jsonb NOT NULL,
  scope_all_centres boolean NOT NULL, scope_centre_ids uuid[] NOT NULL DEFAULT '{}', scope_effective_centre_ids uuid[],
  status text NOT NULL DEFAULT 'queued',
  requested_at timestamptz NOT NULL DEFAULT now(),
  requested_on date NOT NULL DEFAULT ((now() AT TIME ZONE 'Asia/Kathmandu')::date),
  building_started_at timestamptz, ready_at timestamptz, expires_at timestamptz,
  row_count bigint, size_bytes bigint, sha256 text,
  downloads_allowed integer NOT NULL DEFAULT 3, downloads_used integer NOT NULL DEFAULT 0,
  failure_code text,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT exports__pk PRIMARY KEY (id),
  CONSTRAINT exports__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT exports__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT exports__membership__fk FOREIGN KEY (tenant_id, requested_by_membership_id) REFERENCES core.memberships (tenant_id, id),
  CONSTRAINT exports__report__fk FOREIGN KEY (report_code) REFERENCES analytics.g_cs_report_codes (code),
  CONSTRAINT exports__format__ck CHECK (format IN ('xlsx','csv','pdf')),
  CONSTRAINT exports__status__ck CHECK (status IN ('queued','building','ready','failed','expired')),
  CONSTRAINT exports__downloads__ck CHECK (downloads_allowed BETWEEN 1 AND 10 AND downloads_used BETWEEN 0 AND downloads_allowed),
  CONSTRAINT exports__scope__ck CHECK (scope_all_centres OR cardinality(scope_centre_ids) BETWEEN 1 AND 200),
  CONSTRAINT exports__params_size__ck CHECK (octet_length(params::text) <= 4096),
  CONSTRAINT exports__ready__ck CHECK (status <> 'ready' OR (ready_at IS NOT NULL AND expires_at IS NOT NULL AND sha256 IS NOT NULL)),
  CONSTRAINT exports__failure__ck CHECK ((status = 'failed') = (failure_code IS NOT NULL))
);
CREATE INDEX exports__tenant_id_requester_time__idx ON analytics.exports (tenant_id, requested_by_membership_id, requested_at DESC);
CREATE INDEX exports__tenant_id_day__idx ON analytics.exports (tenant_id, requested_on);
CREATE INDEX exports__tenant_id_expiry__p_idx ON analytics.exports (tenant_id, expires_at) WHERE status = 'ready';

CREATE TABLE analytics.export_files (
  tenant_id uuid NOT NULL, export_id uuid NOT NULL,
  content bytea NOT NULL, content_type text NOT NULL, sha256 text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL, expires_at timestamptz NOT NULL,
  CONSTRAINT export_files__pk PRIMARY KEY (tenant_id, export_id),
  CONSTRAINT export_files__export__fk FOREIGN KEY (tenant_id, export_id) REFERENCES analytics.exports (tenant_id, id),
  CONSTRAINT export_files__type__ck CHECK (content_type IN
     ('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','text/csv; charset=utf-8','application/pdf')),
  CONSTRAINT export_files__size__ck CHECK (octet_length(content) <= 20971520),
  CONSTRAINT export_files__sha__ck CHECK (sha256 ~ '^[0-9a-f]{64}$')
);
ALTER TABLE analytics.export_files ALTER COLUMN content SET STORAGE EXTERNAL;   -- already compressed formats; avoid TOAST recompression

-- ===================== schedules and runs =====================
CREATE TABLE analytics.schedules (
  id uuid NOT NULL, tenant_id uuid NOT NULL,
  name text NOT NULL, report_codes text[] NOT NULL, frequency text NOT NULL, send_time_local time NOT NULL, weekday smallint,
  period_rule text NOT NULL, scope_all_centres boolean NOT NULL, scope_centre_ids uuid[] NOT NULL DEFAULT '{}',
  owner_membership_id uuid NOT NULL, next_run_at timestamptz, last_run_id uuid,
  version integer NOT NULL DEFAULT 1, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT schedules__pk PRIMARY KEY (id),
  CONSTRAINT schedules__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT schedules__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT schedules__owner__fk FOREIGN KEY (tenant_id, owner_membership_id) REFERENCES core.memberships (tenant_id, id),
  CONSTRAINT schedules__name__ck CHECK (char_length(name) BETWEEN 1 AND 80 AND name !~* '://' AND name !~* 'www\.'
                                       AND name !~ '@' AND name !~ '[0-9]{7,}'),  -- mirrors C6 label_text (08 A4.3/A5.4)
  CONSTRAINT schedules__reports__ck CHECK (cardinality(report_codes) BETWEEN 1 AND 10),
  CONSTRAINT schedules__frequency__ck CHECK (frequency IN ('daily','weekly','monthly_ad','monthly_bs')),
  CONSTRAINT schedules__weekday__ck CHECK ((frequency = 'weekly') = (weekday IS NOT NULL) AND (weekday IS NULL OR weekday BETWEEN 1 AND 7)),
  CONSTRAINT schedules__time__ck CHECK (extract(minute FROM send_time_local) IN (0,15,30,45) AND extract(second FROM send_time_local) = 0),
  CONSTRAINT schedules__period__ck CHECK (period_rule IN ('previous_business_day','previous_7_days','month_to_date_ad','previous_ad_month',
                                                          'month_to_date_bs','previous_bs_month','fiscal_year_to_date')),
  CONSTRAINT schedules__scope__ck CHECK (scope_all_centres OR cardinality(scope_centre_ids) BETWEEN 1 AND 20),
  CONSTRAINT schedules__next__ck CHECK (is_active OR next_run_at IS NULL)
);
-- report_codes ⊆ analytics.g_cs_report_codes(is_schedulable): array FK not expressible → trigger analytics.schedules_codes_guard()
CREATE INDEX schedules__tenant_id_due__p_idx ON analytics.schedules (tenant_id, next_run_at) WHERE is_active;

CREATE TABLE analytics.schedule_recipients (                          -- class M (08 A17 D-45)
  id uuid NOT NULL, tenant_id uuid NOT NULL, schedule_id uuid NOT NULL, membership_id uuid NOT NULL,
  version integer NOT NULL DEFAULT 1, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT schedule_recipients__pk PRIMARY KEY (id),
  CONSTRAINT schedule_recipients__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT schedule_recipients__schedule_membership__uq UNIQUE (tenant_id, schedule_id, membership_id),
  CONSTRAINT schedule_recipients__schedule__fk FOREIGN KEY (tenant_id, schedule_id) REFERENCES analytics.schedules (tenant_id, id),
  CONSTRAINT schedule_recipients__membership__fk FOREIGN KEY (tenant_id, membership_id) REFERENCES core.memberships (tenant_id, id)
);
-- ≤ 20 active recipients per schedule: enforced in service + trigger analytics.schedule_recipients_cap() (counts is_active rows)

CREATE TABLE analytics.report_runs (
  id uuid NOT NULL, tenant_id uuid NOT NULL, schedule_id uuid NOT NULL, slot_start timestamptz NOT NULL,
  report_codes text[] NOT NULL, omitted_report_codes text[] NOT NULL DEFAULT '{}',
  period_from date NOT NULL, period_to date NOT NULL,
  scope_all_centres boolean NOT NULL, scope_centre_ids uuid[] NOT NULL DEFAULT '{}',
  state text NOT NULL DEFAULT 'dispatched', sent_count integer NOT NULL DEFAULT 0, skipped_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  expires_at timestamptz NOT NULL,                                      -- created_at + 400 days (D-45)
  CONSTRAINT report_runs__pk PRIMARY KEY (id),
  CONSTRAINT report_runs__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT report_runs__slot__uq UNIQUE (tenant_id, schedule_id, slot_start),
  CONSTRAINT report_runs__tenant_id_id_schedule__uq UNIQUE (tenant_id, id, schedule_id),   -- parent of the recipients' run FK
  CONSTRAINT report_runs__schedule__fk FOREIGN KEY (tenant_id, schedule_id) REFERENCES analytics.schedules (tenant_id, id),
  CONSTRAINT report_runs__period__ck CHECK (period_to > period_from AND period_to - period_from <= 366),
  CONSTRAINT report_runs__state__ck CHECK (state IN ('dispatched','skipped_flag_off','skipped_late')),
  CONSTRAINT report_runs__counts__ck CHECK (sent_count >= 0 AND skipped_count >= 0)
);

CREATE TABLE analytics.report_run_recipients (                        -- class E (D-45)
  id uuid NOT NULL, tenant_id uuid NOT NULL, report_run_id uuid NOT NULL,
  schedule_id uuid NOT NULL,                                            -- = report_runs.schedule_id; lets the owner policy avoid report_runs (§3 note)
  membership_id uuid NOT NULL,
  outcome text NOT NULL, omitted_report_codes text[] NOT NULL DEFAULT '{}',
  delivery_id uuid, notification_status text, error_code text,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  expires_at timestamptz NOT NULL,                                      -- created_at + 400 days (D-45)
  CONSTRAINT report_run_recipients__pk PRIMARY KEY (id),
  CONSTRAINT report_run_recipients__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT report_run_recipients__run_membership__uq UNIQUE (tenant_id, report_run_id, membership_id),
  CONSTRAINT report_run_recipients__run__fk FOREIGN KEY (tenant_id, report_run_id, schedule_id)
     REFERENCES analytics.report_runs (tenant_id, id, schedule_id),                   -- schedule_id always equals the run's
  CONSTRAINT report_run_recipients__schedule__fk FOREIGN KEY (tenant_id, schedule_id) REFERENCES analytics.schedules (tenant_id, id),
  CONSTRAINT report_run_recipients__membership__fk FOREIGN KEY (tenant_id, membership_id) REFERENCES core.memberships (tenant_id, id),
  CONSTRAINT report_run_recipients__outcome__ck CHECK (outcome IN ('queued','suppressed','skipped_ineligible','failed')),
  CONSTRAINT report_run_recipients__status__ck CHECK (notification_status IS NULL OR notification_status IN
     ('queued','suppressed_no_consent','suppressed_no_contact','suppressed_channel_disabled'))
);
CREATE INDEX report_run_recipients__tenant_id_membership__idx ON analytics.report_run_recipients (tenant_id, membership_id, report_run_id);
CREATE INDEX report_runs__tenant_id_expiry__idx ON analytics.report_runs (tenant_id, expires_at);
CREATE INDEX report_run_recipients__tenant_id_expiry__idx ON analytics.report_run_recipients (tenant_id, expires_at);

-- ===================== RLS (complete; C0 transcribes into db/policies/analytics.sql) =====================
-- pred_t / pred_c as §3 (08 A17 P-16; 08 A16.1 cast). Every analytics table except g_cs_* gets ENABLE + FORCE RLS here.
DO $$
DECLARE
  t text;
  pred_t text := $p$tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())$p$;
  pred_c text := $p$tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres())
      OR (centre_id IS NOT NULL AND centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])))$p$;
  p_sys  text := $p$(SELECT app.current_actor_type()) = 'system'$p$;
  r_tables text[] := ARRAY['daily_orders','daily_centre_volume','daily_referrer_volume','daily_income','daily_department_income',
    'daily_collections','daily_referrer_billing','daily_results','daily_specimens','daily_rejections','daily_critical_values',
    'tat_facts','daily_releases','daily_deliveries','daily_interface_messages','report_backlog'];
BEGIN
  -- class R (CR-C8-003): SELECT by centre scope; INSERT/DELETE by the system actor only; no UPDATE
  FOREACH t IN ARRAY r_tables LOOP
    EXECUTE format('ALTER TABLE analytics.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE analytics.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON analytics.%I FOR SELECT TO lims_app USING (%s)', t||'__select__tenant_centre', t, pred_c);
    EXECUTE format('CREATE POLICY %I ON analytics.%I FOR INSERT TO lims_app WITH CHECK (%s AND %s)', t||'__insert__tenant', t, pred_t, p_sys);
    EXECUTE format('CREATE POLICY %I ON analytics.%I FOR DELETE TO lims_app USING (%s AND %s)', t||'__delete__tenant', t, pred_t, p_sys);
    EXECUTE format('GRANT SELECT, INSERT, DELETE ON analytics.%I TO lims_app', t);
  END LOOP;

  FOREACH t IN ARRAY ARRAY['refresh_state','dirty_partitions','refresh_runs','order_index','exports','export_files',
                           'schedules','schedule_recipients','report_runs','report_run_recipients'] LOOP
    EXECUTE format('ALTER TABLE analytics.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE analytics.%I FORCE ROW LEVEL SECURITY', t);
  END LOOP;

  -- refresh_state (E, P-18(b) exception): system writes every family; users write only the '_manual' throttle row (P-22)
  EXECUTE format('CREATE POLICY refresh_state__select__tenant ON analytics.refresh_state FOR SELECT TO lims_app USING (%s)', pred_t);
  EXECUTE format('CREATE POLICY refresh_state__insert__tenant ON analytics.refresh_state FOR INSERT TO lims_app WITH CHECK (%s AND %s)', pred_t, p_sys);
  EXECUTE format($q$CREATE POLICY refresh_state__insert__tenant_manual ON analytics.refresh_state FOR INSERT TO lims_app
                    WITH CHECK (%s AND family = '_manual')$q$, pred_t);
  EXECUTE format('CREATE POLICY refresh_state__update__tenant ON analytics.refresh_state FOR UPDATE TO lims_app USING (%s AND %s) WITH CHECK (%s AND %s)', pred_t, p_sys, pred_t, p_sys);
  EXECUTE format($q$CREATE POLICY refresh_state__update__tenant_manual ON analytics.refresh_state FOR UPDATE TO lims_app
                    USING (%s AND family = '_manual') WITH CHECK (%s AND family = '_manual')$q$, pred_t, pred_t);
  GRANT SELECT, INSERT, UPDATE ON analytics.refresh_state TO lims_app;

  -- dirty_partitions (E, exception): users insert/upsert marks (manual refresh); only the system deletes processed marks
  EXECUTE format('CREATE POLICY dirty_partitions__select__tenant ON analytics.dirty_partitions FOR SELECT TO lims_app USING (%s)', pred_t);
  EXECUTE format('CREATE POLICY dirty_partitions__insert__tenant ON analytics.dirty_partitions FOR INSERT TO lims_app WITH CHECK (%s)', pred_t);
  EXECUTE format('CREATE POLICY dirty_partitions__update__tenant ON analytics.dirty_partitions FOR UPDATE TO lims_app USING (%s) WITH CHECK (%s)', pred_t, pred_t);
  EXECUTE format('CREATE POLICY dirty_partitions__delete__tenant ON analytics.dirty_partitions FOR DELETE TO lims_app USING (%s AND %s)', pred_t, p_sys);
  GRANT SELECT, INSERT, UPDATE, DELETE ON analytics.dirty_partitions TO lims_app;

  -- refresh_runs, order_index (E): system only; retention delete by expires_at (P-18(c))
  FOREACH t IN ARRAY ARRAY['refresh_runs','order_index'] LOOP
    IF t = 'refresh_runs' THEN
      EXECUTE format('CREATE POLICY %I ON analytics.%I FOR SELECT TO lims_app USING (%s)', t||'__select__tenant', t, pred_t);
    ELSE
      EXECUTE format('CREATE POLICY %I ON analytics.%I FOR SELECT TO lims_app USING (%s AND %s)', t||'__select__tenant', t, pred_t, p_sys);
    END IF;
    EXECUTE format('CREATE POLICY %I ON analytics.%I FOR INSERT TO lims_app WITH CHECK (%s AND %s)', t||'__insert__tenant', t, pred_t, p_sys);
    EXECUTE format('CREATE POLICY %I ON analytics.%I FOR UPDATE TO lims_app USING (%s AND %s) WITH CHECK (%s AND %s)', t||'__update__tenant', t, pred_t, p_sys, pred_t, p_sys);
    EXECUTE format('CREATE POLICY %I ON analytics.%I FOR DELETE TO lims_app USING (%s AND %s AND expires_at < now())', t||'__delete__tenant', t, pred_t, p_sys);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON analytics.%I TO lims_app', t);
  END LOOP;

  -- schedules, schedule_recipients (M): no DELETE policy, no DELETE grant (deactivate only; D-45)
  FOREACH t IN ARRAY ARRAY['schedules','schedule_recipients'] LOOP
    EXECUTE format('CREATE POLICY %I ON analytics.%I FOR SELECT TO lims_app USING (%s)', t||'__select__tenant', t, pred_t);
    EXECUTE format('CREATE POLICY %I ON analytics.%I FOR INSERT TO lims_app WITH CHECK (%s)', t||'__insert__tenant', t, pred_t);
    EXECUTE format('CREATE POLICY %I ON analytics.%I FOR UPDATE TO lims_app USING (%s) WITH CHECK (%s)', t||'__update__tenant', t, pred_t, pred_t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON analytics.%I TO lims_app', t);
  END LOOP;
END $$;

-- exports (E): own rows for users, all rows for the system actor
CREATE POLICY exports__select__tenant ON analytics.exports FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.current_actor_type()) = 'system'
              OR requested_by_membership_id = (SELECT nullif(app.current_claims() ->> 'membership_id', '')::uuid)));
CREATE POLICY exports__insert__tenant ON analytics.exports FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND status = 'queued'
              AND requested_by_membership_id = (SELECT nullif(app.current_claims() ->> 'membership_id', '')::uuid));
CREATE POLICY exports__update__tenant ON analytics.exports FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.current_actor_type()) = 'system'
              OR requested_by_membership_id = (SELECT nullif(app.current_claims() ->> 'membership_id', '')::uuid)))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.current_actor_type()) = 'system'
              OR requested_by_membership_id = (SELECT nullif(app.current_claims() ->> 'membership_id', '')::uuid)));
CREATE POLICY exports__delete__tenant ON analytics.exports FOR DELETE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND (SELECT app.current_actor_type()) = 'system' AND requested_at < now() - interval '400 days');
GRANT SELECT, INSERT, UPDATE, DELETE ON analytics.exports TO lims_app;

-- export_files (E, exception): requester reads own file; system writes and deletes
CREATE POLICY export_files__select__tenant ON analytics.export_files FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.current_actor_type()) = 'system'
              OR EXISTS (SELECT 1 FROM analytics.exports e
                         WHERE e.tenant_id = export_files.tenant_id AND e.id = export_files.export_id
                           AND e.requested_by_membership_id = (SELECT nullif(app.current_claims() ->> 'membership_id', '')::uuid))));
CREATE POLICY export_files__insert__tenant ON analytics.export_files FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
              AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY export_files__delete__tenant ON analytics.export_files FOR DELETE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND (SELECT app.current_actor_type()) = 'system');            -- also before expires_at when downloads are exhausted
GRANT SELECT, INSERT, DELETE ON analytics.export_files TO lims_app;

-- report_runs (E): visible to the system, to recipients of the run and to the schedule owner
CREATE POLICY report_runs__select__tenant ON analytics.report_runs FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.current_actor_type()) = 'system'
              OR EXISTS (SELECT 1 FROM analytics.report_run_recipients r
                         WHERE r.tenant_id = report_runs.tenant_id AND r.report_run_id = report_runs.id
                           AND r.membership_id = (SELECT nullif(app.current_claims() ->> 'membership_id', '')::uuid))
              OR EXISTS (SELECT 1 FROM analytics.schedules s
                         WHERE s.tenant_id = report_runs.tenant_id AND s.id = report_runs.schedule_id
                           AND s.owner_membership_id = (SELECT nullif(app.current_claims() ->> 'membership_id', '')::uuid))));
CREATE POLICY report_runs__insert__tenant ON analytics.report_runs FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
              AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY report_runs__update__tenant ON analytics.report_runs FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND (SELECT app.current_actor_type()) = 'system')
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
              AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY report_runs__delete__tenant ON analytics.report_runs FOR DELETE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND (SELECT app.current_actor_type()) = 'system' AND expires_at < now());
GRANT SELECT, INSERT, UPDATE, DELETE ON analytics.report_runs TO lims_app;

-- report_run_recipients (E): own row, or owner of the run's schedule (via schedule_id — never via report_runs, §3 note)
CREATE POLICY report_run_recipients__select__tenant ON analytics.report_run_recipients FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.current_actor_type()) = 'system'
              OR membership_id = (SELECT nullif(app.current_claims() ->> 'membership_id', '')::uuid)
              OR EXISTS (SELECT 1 FROM analytics.schedules s
                         WHERE s.tenant_id = report_run_recipients.tenant_id AND s.id = report_run_recipients.schedule_id
                           AND s.owner_membership_id = (SELECT nullif(app.current_claims() ->> 'membership_id', '')::uuid))));
CREATE POLICY report_run_recipients__insert__tenant ON analytics.report_run_recipients FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
              AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY report_run_recipients__delete__tenant ON analytics.report_run_recipients FOR DELETE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND (SELECT app.current_actor_type()) = 'system' AND expires_at < now());
GRANT SELECT, INSERT, DELETE ON analytics.report_run_recipients TO lims_app;
-- no UPDATE policy/grant on report_run_recipients (outcome set once, 03-APP-FLOW §4.3)

-- event_inbox: created by C0 per IC §12 (PK (tenant_id, event_id), __tenant policies, 90-day owner purge).
```

Guard functions (`analytics.exports_transition_guard`, `analytics.schedules_codes_guard`, `analytics.schedule_recipients_cap`) are SECURITY INVOKER plpgsql with `SET search_path = ''`, owned by `lims_owner` (not DEFINER — no inventory entry needed, 04 D7). `schedules_codes_guard` rejects (SQLSTATE `23514`, mapped to `common.validation_failed`) any code not in `analytics.g_cs_report_codes WHERE is_active AND is_schedulable`.

## 7. Query → index map

| Query (02-TRD) | Index |
|---|---|
| every rollup range read `tenant_id, business_date` | leading columns of each table's PK/unique key |
| top referrers, referral report by referrer | `daily_referrer_volume__tenant_id_referrer__idx`, `daily_referrer_billing__tenant_id_referrer__idx` |
| collections by staff | `daily_collections__tenant_id_staff__idx` |
| TAT percentiles | `tat_facts__tenant_id_segment_date__idx` (INCLUDE covers the aggregate) |
| refresh: pending dirty marks | `dirty_partitions__pk`; staleness `dirty_partitions__tenant_id_marked__idx` |
| backlog build: open orders | `order_index__tenant_id_open__p_idx` |
| export quota (per user hour / tenant day) | `exports__tenant_id_requester_time__idx`, `exports__tenant_id_day__idx` |
| export expiry purge | `exports__tenant_id_expiry__p_idx` |
| schedule dispatch | `schedules__tenant_id_due__p_idx` |
| report run access check | `report_run_recipients__tenant_id_membership__idx`; owner branch `schedules__pk` |
| retention purge (E tables, `expires_at < now()`) | `refresh_runs__tenant_id_expiry__idx`, `order_index__tenant_id_expiry__idx`, `report_runs__tenant_id_expiry__idx`, `report_run_recipients__tenant_id_expiry__idx` |
| freshness | `refresh_state__pk` |

Source-view performance depends on owners' indexes (CR-C8-011).

## 8. Data classification per column (REQ-SEC-004)

| Column(s) | Class | Note |
|---|---|---|
| all `*_id` uuids (centre, branch, referrer, department, test, analyte, instrument, membership, order, specimen) | P1 | pseudonymous; never joined to patient identity inside C8 |
| counts, `*_paisa` aggregates | P0 (business) | not linked to a person |
| `tat_facts.subject_id` + timestamps | P1 | specimen/order level; no patient id stored |
| `order_index.order_id`, `referrer_id` | P1 | |
| `schedules.name` | P1 (staff free text) | CHECK blocks emails, ≥ 7-digit runs and URLs (`://`, `www.`; 08 A5.4) |
| `export_files.content` | **P2** | contains doctor/staff display names; never logged; 24 h retention; downloaded only by requester |
| `exports.params` | P1 | ids, dates, codes only (validated by spec; ≤ 4 KB) |

No column in `analytics` stores a patient id, name, phone, registration no, barcode, result value or test name linked to a person.

## 9. Retention mechanics

`analytics.purge` (`per_tenant` task, system actor; 08 A17 P-18(c)) issues the DELETEs of TRD §9.5 in 10,000-row batches [CONV] per statement (`DELETE … WHERE ctid IN (SELECT ctid … LIMIT 10000)`) to stay under the 5 s statement timeout. E tables are deleted by `expires_at < now()` under their `__delete__tenant` policy (exports metadata by `requested_at`); R tables by `business_date`. `schedules` and `schedule_recipients` are never deleted.
