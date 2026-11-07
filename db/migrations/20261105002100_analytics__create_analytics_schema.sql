-- T0B-10.C8: analytics schema — C8 05-SCHEMA §6 DDL verbatim (28 tables, indexes, grants), the §6 RLS DO block written out as
-- literal statements (ENABLE + FORCE on the 26 tenant tables, 85 policies, grants), the three §6 guard functions (SECURITY INVOKER,
-- search_path = ''), the §5 mutable-column triggers, row-audit triggers on the two class M tables (§5; 04 D11) and the §4 seeds of
-- the two class G coded sets. Policies are copied 1:1 to db/policies/analytics.sql (AC-0B-2.3). No views, no SECURITY DEFINER.
-- The C0 inbox table of this schema belongs to T0B-05. Schema analytics exists since T0B-01. Single role switch: lims_owner.
SET LOCAL ROLE lims_owner;

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

-- =====================================================================
-- §3 / §6 RLS: the spec DO block written out literally (ENABLE + FORCE, policies, grants). pred_c carries the staff guard
-- (SELECT app.is_staff_or_system()) per 08 A17 P-16 / gate 9 (C5..C7 precedent); every other predicate is the spec text.
-- =====================================================================
ALTER TABLE analytics.daily_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE analytics.daily_orders FORCE ROW LEVEL SECURITY;
ALTER TABLE analytics.daily_centre_volume ENABLE ROW LEVEL SECURITY;
ALTER TABLE analytics.daily_centre_volume FORCE ROW LEVEL SECURITY;
ALTER TABLE analytics.daily_referrer_volume ENABLE ROW LEVEL SECURITY;
ALTER TABLE analytics.daily_referrer_volume FORCE ROW LEVEL SECURITY;
ALTER TABLE analytics.daily_income ENABLE ROW LEVEL SECURITY;
ALTER TABLE analytics.daily_income FORCE ROW LEVEL SECURITY;
ALTER TABLE analytics.daily_department_income ENABLE ROW LEVEL SECURITY;
ALTER TABLE analytics.daily_department_income FORCE ROW LEVEL SECURITY;
ALTER TABLE analytics.daily_collections ENABLE ROW LEVEL SECURITY;
ALTER TABLE analytics.daily_collections FORCE ROW LEVEL SECURITY;
ALTER TABLE analytics.daily_referrer_billing ENABLE ROW LEVEL SECURITY;
ALTER TABLE analytics.daily_referrer_billing FORCE ROW LEVEL SECURITY;
ALTER TABLE analytics.daily_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE analytics.daily_results FORCE ROW LEVEL SECURITY;
ALTER TABLE analytics.daily_specimens ENABLE ROW LEVEL SECURITY;
ALTER TABLE analytics.daily_specimens FORCE ROW LEVEL SECURITY;
ALTER TABLE analytics.daily_rejections ENABLE ROW LEVEL SECURITY;
ALTER TABLE analytics.daily_rejections FORCE ROW LEVEL SECURITY;
ALTER TABLE analytics.daily_critical_values ENABLE ROW LEVEL SECURITY;
ALTER TABLE analytics.daily_critical_values FORCE ROW LEVEL SECURITY;
ALTER TABLE analytics.tat_facts ENABLE ROW LEVEL SECURITY;
ALTER TABLE analytics.tat_facts FORCE ROW LEVEL SECURITY;
ALTER TABLE analytics.daily_releases ENABLE ROW LEVEL SECURITY;
ALTER TABLE analytics.daily_releases FORCE ROW LEVEL SECURITY;
ALTER TABLE analytics.daily_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE analytics.daily_deliveries FORCE ROW LEVEL SECURITY;
ALTER TABLE analytics.daily_interface_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE analytics.daily_interface_messages FORCE ROW LEVEL SECURITY;
ALTER TABLE analytics.report_backlog ENABLE ROW LEVEL SECURITY;
ALTER TABLE analytics.report_backlog FORCE ROW LEVEL SECURITY;
ALTER TABLE analytics.refresh_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE analytics.refresh_state FORCE ROW LEVEL SECURITY;
ALTER TABLE analytics.dirty_partitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE analytics.dirty_partitions FORCE ROW LEVEL SECURITY;
ALTER TABLE analytics.refresh_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE analytics.refresh_runs FORCE ROW LEVEL SECURITY;
ALTER TABLE analytics.order_index ENABLE ROW LEVEL SECURITY;
ALTER TABLE analytics.order_index FORCE ROW LEVEL SECURITY;
ALTER TABLE analytics.exports ENABLE ROW LEVEL SECURITY;
ALTER TABLE analytics.exports FORCE ROW LEVEL SECURITY;
ALTER TABLE analytics.export_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE analytics.export_files FORCE ROW LEVEL SECURITY;
ALTER TABLE analytics.schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE analytics.schedules FORCE ROW LEVEL SECURITY;
ALTER TABLE analytics.schedule_recipients ENABLE ROW LEVEL SECURITY;
ALTER TABLE analytics.schedule_recipients FORCE ROW LEVEL SECURITY;
ALTER TABLE analytics.report_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE analytics.report_runs FORCE ROW LEVEL SECURITY;
ALTER TABLE analytics.report_run_recipients ENABLE ROW LEVEL SECURITY;
ALTER TABLE analytics.report_run_recipients FORCE ROW LEVEL SECURITY;

CREATE POLICY daily_orders__select__tenant_centre ON analytics.daily_orders FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR (centre_id IS NOT NULL AND centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]))));
CREATE POLICY daily_orders__insert__tenant ON analytics.daily_orders FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY daily_orders__delete__tenant ON analytics.daily_orders FOR DELETE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY daily_centre_volume__select__tenant_centre ON analytics.daily_centre_volume FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR (centre_id IS NOT NULL AND centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]))));
CREATE POLICY daily_centre_volume__insert__tenant ON analytics.daily_centre_volume FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY daily_centre_volume__delete__tenant ON analytics.daily_centre_volume FOR DELETE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY daily_referrer_volume__select__tenant_centre ON analytics.daily_referrer_volume FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR (centre_id IS NOT NULL AND centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]))));
CREATE POLICY daily_referrer_volume__insert__tenant ON analytics.daily_referrer_volume FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY daily_referrer_volume__delete__tenant ON analytics.daily_referrer_volume FOR DELETE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY daily_income__select__tenant_centre ON analytics.daily_income FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR (centre_id IS NOT NULL AND centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]))));
CREATE POLICY daily_income__insert__tenant ON analytics.daily_income FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY daily_income__delete__tenant ON analytics.daily_income FOR DELETE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY daily_department_income__select__tenant_centre ON analytics.daily_department_income FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR (centre_id IS NOT NULL AND centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]))));
CREATE POLICY daily_department_income__insert__tenant ON analytics.daily_department_income FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY daily_department_income__delete__tenant ON analytics.daily_department_income FOR DELETE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY daily_collections__select__tenant_centre ON analytics.daily_collections FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR (centre_id IS NOT NULL AND centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]))));
CREATE POLICY daily_collections__insert__tenant ON analytics.daily_collections FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY daily_collections__delete__tenant ON analytics.daily_collections FOR DELETE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY daily_referrer_billing__select__tenant_centre ON analytics.daily_referrer_billing FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR (centre_id IS NOT NULL AND centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]))));
CREATE POLICY daily_referrer_billing__insert__tenant ON analytics.daily_referrer_billing FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY daily_referrer_billing__delete__tenant ON analytics.daily_referrer_billing FOR DELETE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY daily_results__select__tenant_centre ON analytics.daily_results FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR (centre_id IS NOT NULL AND centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]))));
CREATE POLICY daily_results__insert__tenant ON analytics.daily_results FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY daily_results__delete__tenant ON analytics.daily_results FOR DELETE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY daily_specimens__select__tenant_centre ON analytics.daily_specimens FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR (centre_id IS NOT NULL AND centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]))));
CREATE POLICY daily_specimens__insert__tenant ON analytics.daily_specimens FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY daily_specimens__delete__tenant ON analytics.daily_specimens FOR DELETE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY daily_rejections__select__tenant_centre ON analytics.daily_rejections FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR (centre_id IS NOT NULL AND centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]))));
CREATE POLICY daily_rejections__insert__tenant ON analytics.daily_rejections FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY daily_rejections__delete__tenant ON analytics.daily_rejections FOR DELETE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY daily_critical_values__select__tenant_centre ON analytics.daily_critical_values FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR (centre_id IS NOT NULL AND centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]))));
CREATE POLICY daily_critical_values__insert__tenant ON analytics.daily_critical_values FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY daily_critical_values__delete__tenant ON analytics.daily_critical_values FOR DELETE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY tat_facts__select__tenant_centre ON analytics.tat_facts FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR (centre_id IS NOT NULL AND centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]))));
CREATE POLICY tat_facts__insert__tenant ON analytics.tat_facts FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY tat_facts__delete__tenant ON analytics.tat_facts FOR DELETE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY daily_releases__select__tenant_centre ON analytics.daily_releases FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR (centre_id IS NOT NULL AND centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]))));
CREATE POLICY daily_releases__insert__tenant ON analytics.daily_releases FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY daily_releases__delete__tenant ON analytics.daily_releases FOR DELETE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY daily_deliveries__select__tenant_centre ON analytics.daily_deliveries FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR (centre_id IS NOT NULL AND centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]))));
CREATE POLICY daily_deliveries__insert__tenant ON analytics.daily_deliveries FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY daily_deliveries__delete__tenant ON analytics.daily_deliveries FOR DELETE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY daily_interface_messages__select__tenant_centre ON analytics.daily_interface_messages FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR (centre_id IS NOT NULL AND centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]))));
CREATE POLICY daily_interface_messages__insert__tenant ON analytics.daily_interface_messages FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY daily_interface_messages__delete__tenant ON analytics.daily_interface_messages FOR DELETE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY report_backlog__select__tenant_centre ON analytics.report_backlog FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR (centre_id IS NOT NULL AND centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]))));
CREATE POLICY report_backlog__insert__tenant ON analytics.report_backlog FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY report_backlog__delete__tenant ON analytics.report_backlog FOR DELETE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY refresh_state__select__tenant ON analytics.refresh_state FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY refresh_state__insert__tenant ON analytics.refresh_state FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY refresh_state__insert__tenant_manual ON analytics.refresh_state FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND family = '_manual');
CREATE POLICY refresh_state__update__tenant ON analytics.refresh_state FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) = 'system')
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY refresh_state__update__tenant_manual ON analytics.refresh_state FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND family = '_manual')
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND family = '_manual');
CREATE POLICY dirty_partitions__select__tenant ON analytics.dirty_partitions FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY dirty_partitions__insert__tenant ON analytics.dirty_partitions FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY dirty_partitions__update__tenant ON analytics.dirty_partitions FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY dirty_partitions__delete__tenant ON analytics.dirty_partitions FOR DELETE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY refresh_runs__select__tenant ON analytics.refresh_runs FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY refresh_runs__insert__tenant ON analytics.refresh_runs FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY refresh_runs__update__tenant ON analytics.refresh_runs FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) = 'system')
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY refresh_runs__delete__tenant ON analytics.refresh_runs FOR DELETE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) = 'system' AND expires_at < now());
CREATE POLICY order_index__select__tenant ON analytics.order_index FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY order_index__insert__tenant ON analytics.order_index FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY order_index__update__tenant ON analytics.order_index FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) = 'system')
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY order_index__delete__tenant ON analytics.order_index FOR DELETE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) = 'system' AND expires_at < now());
CREATE POLICY schedules__select__tenant ON analytics.schedules FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY schedules__insert__tenant ON analytics.schedules FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY schedules__update__tenant ON analytics.schedules FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY schedule_recipients__select__tenant ON analytics.schedule_recipients FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY schedule_recipients__insert__tenant ON analytics.schedule_recipients FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY schedule_recipients__update__tenant ON analytics.schedule_recipients FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));

GRANT SELECT, INSERT, DELETE ON analytics.daily_orders TO lims_app;
GRANT SELECT, INSERT, DELETE ON analytics.daily_centre_volume TO lims_app;
GRANT SELECT, INSERT, DELETE ON analytics.daily_referrer_volume TO lims_app;
GRANT SELECT, INSERT, DELETE ON analytics.daily_income TO lims_app;
GRANT SELECT, INSERT, DELETE ON analytics.daily_department_income TO lims_app;
GRANT SELECT, INSERT, DELETE ON analytics.daily_collections TO lims_app;
GRANT SELECT, INSERT, DELETE ON analytics.daily_referrer_billing TO lims_app;
GRANT SELECT, INSERT, DELETE ON analytics.daily_results TO lims_app;
GRANT SELECT, INSERT, DELETE ON analytics.daily_specimens TO lims_app;
GRANT SELECT, INSERT, DELETE ON analytics.daily_rejections TO lims_app;
GRANT SELECT, INSERT, DELETE ON analytics.daily_critical_values TO lims_app;
GRANT SELECT, INSERT, DELETE ON analytics.tat_facts TO lims_app;
GRANT SELECT, INSERT, DELETE ON analytics.daily_releases TO lims_app;
GRANT SELECT, INSERT, DELETE ON analytics.daily_deliveries TO lims_app;
GRANT SELECT, INSERT, DELETE ON analytics.daily_interface_messages TO lims_app;
GRANT SELECT, INSERT, DELETE ON analytics.report_backlog TO lims_app;
GRANT SELECT, INSERT, UPDATE ON analytics.refresh_state TO lims_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON analytics.dirty_partitions TO lims_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON analytics.refresh_runs TO lims_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON analytics.order_index TO lims_app;
GRANT SELECT, INSERT, UPDATE ON analytics.schedules TO lims_app;
GRANT SELECT, INSERT, UPDATE ON analytics.schedule_recipients TO lims_app;

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

-- =====================================================================
-- §6 guard functions (SECURITY INVOKER plpgsql, search_path = '', owned by lims_owner; no DEFINER, no inventory entry: 04 D7)
-- =====================================================================
-- §5: exports status pairs (TRD / 03-APP-FLOW §4.1), downloads_used +1 only and <= downloads_allowed, and a non-system actor
-- may change only downloads_used / updated_at / updated_by / version. P0001 -> 409 common.immutable_record (CV §5.7).
CREATE FUNCTION analytics.exports_transition_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'queued'   AND NEW.status IN ('building','failed')) OR
       (OLD.status = 'building' AND NEW.status IN ('queued','ready','failed')) OR
       (OLD.status = 'ready'    AND NEW.status IN ('expired'))) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'invalid_transition',
      DETAIL = format('analytics.exports.status %s -> %s', OLD.status, NEW.status);
  END IF;
  IF NEW.downloads_used IS DISTINCT FROM OLD.downloads_used
     AND (NEW.downloads_used <> OLD.downloads_used + 1 OR NEW.downloads_used > NEW.downloads_allowed) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'invalid_transition',
      DETAIL = format('analytics.exports.downloads_used %s -> %s (allowed %s)', OLD.downloads_used, NEW.downloads_used, NEW.downloads_allowed);
  END IF;
  IF (SELECT app.current_actor_type()) IS DISTINCT FROM 'system'
     AND (to_jsonb(NEW) - ARRAY['downloads_used','updated_at','updated_by','version'])
         IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['downloads_used','updated_at','updated_by','version']) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'immutable_row',
      DETAIL = 'analytics.exports: a non-system actor may change only downloads_used, updated_at, updated_by, version';
  END IF;
  RETURN NEW;
END $$;

-- §6: report_codes must be a subset of g_cs_report_codes WHERE is_active AND is_schedulable (array FK not expressible);
-- SQLSTATE 23514 -> common.validation_failed
CREATE FUNCTION analytics.schedules_codes_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE bad text;
BEGIN
  SELECT c INTO bad FROM unnest(NEW.report_codes) AS u(c)
   WHERE NOT EXISTS (SELECT 1 FROM analytics.g_cs_report_codes g WHERE g.code = u.c AND g.is_active AND g.is_schedulable)
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'validation_failed',
      DETAIL = format('analytics.schedules.report_codes: %s is not an active schedulable report code', coalesce(bad, 'NULL'));
  END IF;
  RETURN NEW;
END $$;

-- §5 / 08 A17 D-45: <= 20 ACTIVE recipients per schedule (inserting or re-activating a row counts; inactive rows do not).
-- The schedule row is locked first so concurrent inserts for the same schedule serialise on the count.
CREATE FUNCTION analytics.schedule_recipients_cap() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE n bigint;
BEGIN
  IF NEW.is_active AND (TG_OP = 'INSERT' OR NOT OLD.is_active OR NEW.schedule_id IS DISTINCT FROM OLD.schedule_id) THEN
    PERFORM 1 FROM analytics.schedules s WHERE s.tenant_id = NEW.tenant_id AND s.id = NEW.schedule_id FOR UPDATE;
    SELECT count(*) INTO n FROM analytics.schedule_recipients r
     WHERE r.tenant_id = NEW.tenant_id AND r.schedule_id = NEW.schedule_id AND r.is_active AND r.id <> NEW.id;
    IF n >= 20 THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'validation_failed',
        DETAIL = format('analytics.schedule_recipients: schedule %s already has 20 active recipients', NEW.schedule_id);
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- §5: refresh_runs.status running -> succeeded | failed only (the optional guard the tests tolerate)
CREATE FUNCTION analytics.refresh_runs_transition_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (OLD.status = 'running' AND NEW.status IN ('succeeded','failed')) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'invalid_transition',
      DETAIL = format('analytics.refresh_runs.status %s -> %s', OLD.status, NEW.status);
  END IF;
  RETURN NEW;
END $$;

-- =====================================================================
-- §5 triggers
-- =====================================================================
CREATE TRIGGER exports__mutable_columns BEFORE UPDATE ON analytics.exports FOR EACH ROW
  EXECUTE FUNCTION app.enforce_mutable_columns('status','building_started_at','ready_at','expires_at','row_count','size_bytes','sha256','downloads_used','failure_code','scope_effective_centre_ids','updated_at','updated_by','version');
CREATE TRIGGER exports__transition BEFORE UPDATE ON analytics.exports FOR EACH ROW EXECUTE FUNCTION analytics.exports_transition_guard();
CREATE TRIGGER refresh_runs__mutable_columns BEFORE UPDATE ON analytics.refresh_runs FOR EACH ROW
  EXECUTE FUNCTION app.enforce_mutable_columns('finished_at','status','rows_written','error_code');
CREATE TRIGGER refresh_runs__transition BEFORE UPDATE ON analytics.refresh_runs FOR EACH ROW EXECUTE FUNCTION analytics.refresh_runs_transition_guard();
CREATE TRIGGER report_runs__mutable_columns BEFORE UPDATE ON analytics.report_runs FOR EACH ROW
  EXECUTE FUNCTION app.enforce_mutable_columns('state','omitted_report_codes','sent_count','skipped_count');
CREATE TRIGGER schedules__codes_guard BEFORE INSERT OR UPDATE ON analytics.schedules FOR EACH ROW EXECUTE FUNCTION analytics.schedules_codes_guard();
CREATE TRIGGER schedule_recipients__cap BEFORE INSERT OR UPDATE ON analytics.schedule_recipients FOR EACH ROW EXECUTE FUNCTION analytics.schedule_recipients_cap();

-- §5 / 04 D11 row audit: class M tables only (R / E / G are derived or ephemeral; export_files content is never logged)
CREATE TRIGGER schedules__audit AFTER INSERT OR UPDATE OR DELETE ON analytics.schedules FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER schedule_recipients__audit AFTER INSERT OR UPDATE OR DELETE ON analytics.schedule_recipients FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();

-- =====================================================================
-- §4 seeds (class G coded sets; no tenant seed data)
-- =====================================================================
INSERT INTO analytics.g_cs_families (code, display, sort_order, is_active) VALUES
  ('orders', 'Orders', 10, true), ('centre_volume', 'Centre volume', 20, true), ('referrer_volume', 'Referrer volume', 30, true),
  ('income', 'Income', 40, true), ('department_income', 'Department income', 50, true), ('collections', 'Collections', 60, true),
  ('referrer_billing', 'Referrer billing', 70, true), ('results', 'Results', 80, true), ('specimens', 'Specimens', 90, true),
  ('rejections', 'Rejections', 100, true), ('critical_values', 'Critical values', 110, true), ('tat', 'Turnaround time', 120, true),
  ('releases', 'Report releases', 130, true), ('deliveries', 'Deliveries', 140, true), ('interface_messages', 'Interface messages', 150, true),
  ('report_backlog', 'Report backlog', 160, true), ('_manual', 'Manual refresh throttle', 999, false);
INSERT INTO analytics.g_cs_report_codes (code, display, sort_order, is_exportable, is_schedulable) VALUES
  ('dashboard', 'Dashboard', 10, true, true), ('income', 'Income', 20, true, true), ('department_income', 'Department income', 30, true, true),
  ('collections', 'Collections', 40, true, true), ('volume', 'Volume', 50, true, true), ('top_referrers', 'Top referrers', 60, true, true),
  ('top_centres', 'Top centres', 70, true, true), ('referral_incentive', 'Referral incentive', 80, true, true),
  ('tests_done', 'Tests done', 90, true, true), ('tat', 'Turnaround time', 100, true, true), ('pending_tests', 'Pending tests', 110, true, true),
  ('quality_indicators', 'Quality indicators', 120, true, true), ('delivery', 'Delivery', 130, true, true),
  ('interfaces', 'Interfaces', 140, true, false);
