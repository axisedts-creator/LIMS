# C9 Quality Engine — 05 Schema (specification for C0-0B)

Status: DECISION, 2026-11-06. Schema `quality` (created empty by C0 — C0 05-SCHEMA §1). This file is the specification C0 implements as forward-only migrations (`db/migrations/<ts>_quality__*.sql`, Wave 2 after `analytics` — C0 02-TRD §4 ordering) and as `db/policies/quality.sql`. Conventions: 02-CV §5 (classes, mandatory columns, composite FKs, RLS template, no ENUM types, no DB defaults on ids).

## 1. Table inventory

| Table | Class (02-CV §5.2) | RLS scope | Purpose | PHI (03-IC §1) |
|---|---|---|---|---|
| `quality.settings` | M (one row per tenant) | tenant | C9 tenant settings (02-TRD §12.1) | P0 |
| `quality.g_cs_corrective_actions` | G | none (exempt list) | global coded set | P0 |
| `quality.cs_corrective_actions` | M | tenant | tenant overrides/additions | P0 |
| `quality.g_cs_exclusion_reasons` | G | none (exempt list) | global coded set | P0 |
| `quality.cs_exclusion_reasons` | M | tenant | tenant overrides/additions | P0 |
| `quality.control_materials` | M | tenant | control products | P0 |
| `quality.control_levels` | M | tenant | levels of a material | P0 |
| `quality.control_lots` | M | tenant | lot per level, expiry | P0 |
| `quality.control_id_maps` | M | tenant | instrument raw control id (+lot) → lot | P0 |
| `quality.qc_plans` | M | tenant | one per instrument × analyte | P0 |
| `quality.qc_plan_versions` | M (immutable rows: SELECT + INSERT only, no UPDATE policy or grant — §4, §5) | tenant | N, composition, rule options | P0 |
| `quality.qc_targets` | M (values immutable) | tenant | mean/SD per plan × lot, versioned | P0 |
| `quality.qc_runs` | C | tenant | assembled/evaluated runs | P0 |
| `quality.qc_observations` | C | tenant | imported QC values + classification | P0 |
| `quality.qc_corrective_actions` | A | tenant | corrective-action log | P0 (free text: staff-entered, no patient data by policy) |
| `quality.qc_run_reviews` | A | tenant | warning acknowledgements, close comments | P0 |
| `quality.qc_activity` | E | tenant | patient-result counters per planned pair | P0 |
| `quality.sync_state` | E | tenant | import cursor | P0 |
| `quality.autoverify_rule_sets` | M | tenant | one per tenant | P0 |
| `quality.autoverify_versions` | M (definition immutable after draft) | tenant | DSL versions | P0 |
| `quality.autoverify_decisions` | A | tenant | every live/shadow decision | **P3** (pseudonymous result id + value) |
| `quality.verification_log` | A | tenant | facts from `lab.result.verified.v1` | P3 (pseudonymous) |
| `quality.tat_items` | E (purged by C9's own `per_tenant` task, 08 A17 P-18(c)) | **tenant + centre** | TAT clocks (derived read model) | P3 (pseudonymous order/test ids) |
| `quality.tat_alert_events` | A | **tenant + centre** | level crossings | P3 |
| `quality.tat_alert_acks` | A | **tenant + centre** | acknowledgements | P3 |
| `quality.event_inbox` | A | tenant | C0 platform table (03-IC §12, A7) | P1 |

Mandatory-column exceptions (08 A17 P-18(b)): none. The one-row-per-key tables `settings`, `qc_activity` and `sync_state` keep `id` and every mandatory column of their class; `qc_activity.expires_at` and `sync_state.expires_at` stay NULL (live state for the life of the tenant, §7).

Staff-actor guard (08 A17 P-16): no C9 table is shared with partner, portal or patient actors (none is marked `shared_with` in `db/meta/tables.yaml`), so every `__tenant` and `__tenant_centre` policy in §5 carries `(SELECT app.is_staff_or_system())` in USING and WITH CHECK.

Centre scoping (02-CV §5.8): QC and auto-verify tables are lab-processing data with no patient link (QC) or are read only by lab roles that hold all centres at the hub; they are tenant-scoped (DECISION). TAT tables follow a patient order's collection centre and are centre-scoped so a centre-restricted reader sees only its centres' alerts (AC-14.7).

Cross-schema FKs (01 §5 R3: Wave-2 schemas may reference `core`, `catalog`, `frontdesk`, `lab`, `instruments`): `core.tenants`, `core.collection_centres`, `catalog.tests`, `catalog.analytes`, `catalog.departments`, `frontdesk.orders`, `frontdesk.order_items`, `lab.qc_results`, `lab.results`, `lab.specimens`, `instruments.instruments`. Nothing references `quality` from upstream. No FK into `billing` (02-CV §5.4).

## 2. Coded sets and closed value lists

Closed technical lists (`text` + `CHECK`):

| Column | Values |
|---|---|
| `qc_plans.status` | `active`, `inactive` |
| `qc_plan_versions.mean_rule` | `6x`, `8x`, `9x`, `10x`, `12x` (N-dependent check) |
| `qc_targets.source` | `manufacturer`, `established` |
| `qc_targets.status` | `draft`, `active`, `superseded`, `retired`, `discarded` |
| `qc_runs.status` | `collecting`, `evaluated`, `closed` |
| `qc_runs.outcome` | `accepted`, `accepted_warning`, `incomplete`, `rejected` |
| `qc_runs.rule_mode` | `classic`, `modern` |
| rule codes (`rules_violated`, `warning_rules`) | `1-2s`, `1-3s`, `2-2s`, `2of3-2s`, `R-4s`, `4-1s`, `3-1s`, `6x`, `8x`, `9x`, `10x`, `12x` (= 03-IC §3.21 enum + `1-2s`) |
| `qc_observations.status` | `unmapped_analyte`, `non_numeric`, `no_plan`, `unmapped_control`, `level_not_in_plan`, `lot_expired`, `no_target`, `unit_mismatch`, `late_unassigned`, `assigned`, `excluded` |
| `qc_observations.source` | `instrument`, `manual` |
| `qc_observations.observed_at_basis` | `instrument`, `server` |
| `qc_run_reviews.kind` | `acknowledge`, `evaluate_now`, `close` |
| `autoverify_versions.status` | `draft`, `simulating`, `stopped`, `active`, `retired`, `discarded` (`stopped` = simulation ended, terminal — 08 A17 D-55) |
| `autoverify_decisions.mode` | `live`, `shadow` |
| `autoverify_decisions.decision` | `allow`, `deny` |
| `autoverify_decisions.qc_status` | `in_control`, `warning`, `out_of_control`, `no_qc_data`, `not_evaluated` |
| reasons (`autoverify_decisions.reasons`) | 03-IC §4.11 `AutoVerifyReason` values + `qc_warning` (CR-C9-003) |
| `verification_log.mode` | `manual`, `auto` |
| `tat_items.segment` | `within_lab`, `total` |
| `tat_items.state` | `not_started`, `running`, `stopped`, `cancelled`, `orphan_closed` |
| `tat_items.alert_level`, `tat_alert_events.level`, `tat_alert_acks.level` | `none`, `warning`, `breached`, `escalated` (events/acks never `none`) |
| `tat_items.priority` | `routine`, `urgent` |
| `tat_items.stop_source` | `verified_event`, `release_event`, `sweep` |
| `tat_items.start_basis` | `registered_at`, `specimen_ordered_at` (segment `total`, 08 A17 D-59); `specimen_received_at` (segment `within_lab`) [CONV: third value added so the D-59 column can stay NOT NULL on within-lab rows] |

Coded sets (02-CV §5.5; tenant rows shadow global rows by `code`):

| Set (x-coded-set) | Global seed [CONV] |
|---|---|
| `quality.corrective_actions` | `recalibration` "Recalibrated", `new_control_vial` "New control vial", `new_reagent_lot` "New reagent lot/pack", `instrument_maintenance` "Instrument maintenance", `control_reconstituted` "Control re-reconstituted", `repeat_control` "Control repeated (no other change)", `other` "Other" |
| `quality.exclusion_reasons` | `wrong_material` "Wrong control material", `wrong_level_mapping` "Wrong level/lot mapping", `handling_error` "Handling error", `instrument_error` "Instrument error message", `duplicate_entry` "Duplicate entry", `other` "Other" |

## 3. Indexes per query (02-TRD reference)

| Query (02-TRD) | Index |
|---|---|
| plan by pair (sync, port) §6.2, §7.8 | `qc_plans__tenant_instrument_analyte__uq` |
| current collecting run §7.3 | `qc_runs__tenant_plan_collecting__p_uq` |
| run timeline / qcStatusFor §7.8 | `qc_runs__tenant_plan_runat__idx` |
| open rejected runs §7.8, status board | `qc_runs__tenant_plan_open_rejected__p_idx` |
| stale collecting runs §7.3 step 7 | `qc_runs__tenant_collecting_assembled__p_idx` |
| latest early-rejected run of a pair §7.3 step 1a | `qc_runs__tenant_plan_runat__idx` |
| run list filters #28 | `qc_runs__tenant_runat__idx` |
| import dedupe §6.2 | `qc_observations__tenant_source__uq` |
| history per plan §7.1 / LJ §7.10 | `qc_observations__tenant_plan_observed__idx` |
| run members | `qc_observations__tenant_run__idx` |
| reprocess / unassigned queue §6.4 | `qc_observations__tenant_status_observed__p_idx` |
| map lookup §6.3 | `control_id_maps__tenant_key__p_uq`, `control_id_maps__tenant_instrument__idx` |
| target effective at §6.3 | `qc_targets__tenant_plan_lot_from__idx`, `qc_targets__tenant_plan_lot_active__p_uq` |
| decisions by result / version §8.6, #46 | `autoverify_decisions__tenant_result__idx`, `autoverify_decisions__tenant_version_mode_time__idx`, `autoverify_decisions__tenant_time__idx` |
| verification by result §8.6 | `verification_log__tenant_result_version__uq` |
| TAT upsert key §9.3 | `tat_items__tenant_item_test__uq` |
| TAT running set / alert list #48 | `tat_items__tenant_running__p_idx`, `tat_items__tenant_open_alerts__p_idx` |
| TAT by order (release, refresh) | `tat_items__tenant_order__idx` |
| TAT purge (`quality.purge_tat_items`) | `tat_items__tenant_expires__idx` |
| one active / one simulating version | `autoverify_versions__tenant_active__p_uq`, `autoverify_versions__tenant_simulating__p_uq` |

`tenant_id` leads every index and unique constraint (02-CV §5.3).

## 4. Immutability and mutation rules

| Table | Rule | Mechanism |
|---|---|---|
| `qc_plan_versions` | no UPDATE at all; `is_active`, `updated_at`, `updated_by`, `version` keep their insert values forever (kept as the class-M mandatory columns) | no UPDATE grant/policy (§5 row) |
| `qc_targets` | `plan_id, lot_id, level_id, mean, sd, unit_code, source, basis_*` never change after insert; lifecycle columns only | `app.enforce_mutable_columns('status','effective_from','effective_to','activated_at','activated_by','retired_at','retired_by','retire_reason','updated_at','updated_by','version')` |
| `qc_observations` | source columns frozen; classification/run columns mutable; `excluded` only while its run is `collecting` or it has no run (service check in #27 + trigger `quality.enforce_observation_exclusion()`, DDL §8) | `app.enforce_mutable_columns('status','plan_id','level_id','lot_id','target_id','mean','sd','z','qc_run_id','excluded_reason_code','excluded_comment','excluded_by','excluded_at','classified_at','updated_at','updated_by','version')` |
| `qc_runs` | `outcome`, `rules_violated`, `warning_rules`, `is_complete`, `evaluated_at`, `hold_since`, `last_in_control_run_at` frozen once `outcome` is set; `status` never changes once `closed`; `evaluated → closed` requires ≥ 1 `qc_corrective_actions` row for the run (backstop for the #32 service guard) | `quality.enforce_run_frozen()` trigger (DDL §8) |
| `autoverify_versions` | `definition`, `rule_set_id`, `version_no`, `created_by` frozen when `OLD.status <> 'draft'`; no status change out of `stopped`, `retired`, `discarded` (terminal) | `quality.enforce_version_frozen()` trigger |
| `qc_corrective_actions`, `qc_run_reviews`, `autoverify_decisions`, `verification_log`, `tat_alert_events`, `tat_alert_acks` | append-only | INSERT + SELECT only (no UPDATE/DELETE grant or policy) |
| `tat_items` | E: UPDATE allowed; DELETE only by C9's `quality.purge_tat_items` task (`per_tenant`, system actor, `expires_at < now()`, rows referenced by `tat_alert_events`/`tat_alert_acks` skipped) — 08 A17 P-18(c) | `tat_items__delete__tenant` policy + DELETE grant (§5) |
| `qc_activity`, `sync_state` | E: UPDATE allowed; never deleted (live state, §7) | no DELETE grant |
| all M tables | never hard-deleted (`is_active = false`) | no DELETE grant |

SQLSTATE `P0001` + `immutable_row` → `409 common.immutable_record` (02-CV §5.7).

## 5. RLS policies (pattern from 02-CV §5.8; role `lims_app`)

Every table: `ENABLE` + `FORCE ROW LEVEL SECURITY`; owner `lims_owner`; per-command policies; helpers wrapped in `(SELECT …)`.

| Table group | SELECT | INSERT | UPDATE | DELETE |
|---|---|---|---|---|
| M tables (except `qc_plan_versions`), C tables, E tables `qc_activity`, `sync_state` (tenant) | `__select__tenant` | `__insert__tenant` | `__update__tenant` (USING + WITH CHECK) | none |
| `qc_plan_versions` (M, immutable rows) | `__select__tenant` | `__insert__tenant` | **none** (no policy, no grant) | none |
| A tables (tenant) | `__select__tenant` | `__insert__tenant` | none | none |
| `tat_items` (E) | `__select__tenant_centre` | `__insert__tenant_centre` | `__update__tenant_centre` | `__delete__tenant` (system actor, expired rows only — P-18(c)) |
| `tat_alert_events`, `tat_alert_acks` | `__select__tenant_centre` | `__insert__tenant_centre` | none | none |
| `g_cs_*` | no RLS; listed in `db/tests/rls_exempt.txt` ("global coded set, no tenant data"); `GRANT SELECT TO lims_app` only | — | — | — |

Policy SQL (tenant variant; `<t>` = table name). Every USING and WITH CHECK carries the staff-actor guard (08 A17 P-16):

```sql
ALTER TABLE quality.<t> ENABLE ROW LEVEL SECURITY;
ALTER TABLE quality.<t> FORCE ROW LEVEL SECURITY;
CREATE POLICY <t>__select__tenant ON quality.<t> FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY <t>__insert__tenant ON quality.<t> FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY <t>__update__tenant ON quality.<t> FOR UPDATE TO lims_app      -- M (except qc_plan_versions), C, E tables only
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
```

Centre variant (`tat_items`, `tat_alert_events`, `tat_alert_acks`), with the 08 A16.1 `::uuid[]` cast:

```sql
CREATE POLICY tat_items__select__tenant_centre ON quality.tat_items FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY tat_items__insert__tenant_centre ON quality.tat_items FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
              AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY tat_items__update__tenant_centre ON quality.tat_items FOR UPDATE TO lims_app
  USING      (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
              AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
              AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
-- Retention purge (08 A17 P-18(c)); used only by the per_tenant task quality.purge_tat_items (system actor).
CREATE POLICY tat_items__delete__tenant ON quality.tat_items FOR DELETE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'system'
         AND expires_at < now());
-- tat_alert_events / tat_alert_acks: SELECT + INSERT policies of the same shape (guard + cast), no UPDATE/DELETE.
```

Grants: `lims_app` gets `SELECT, INSERT, UPDATE` on M/C/E tables except `qc_plan_versions`, `SELECT, INSERT` on `qc_plan_versions` and on A tables, `DELETE` on `quality.tat_items` only (E, P-18(c)), `SELECT` on `g_cs_*` and `v_pub_qc_summary`; no other `DELETE` (02-CV §5.6). Port calls from C5 run in C5's transaction under the same `lims_app` group role and the caller's claims, so the same policies apply. Worker jobs use system claims (`has_all_centres() = true` for `system`, 02-CV §5.8).

Reads of other schemas (02-CV §5.13): `lab.v_pub_qc_result`, `lab.v_pub_pending_items`, `lab.v_pub_specimen_timeline`, `reporting.v_pub_order_report_tat` (TAT worker only, total-clock start — 08 A17 D-59, P-21) and `instruments.v_pub_instrument_directory` (CR-C9-006 ACCEPTED-MODIFIED in 08: columns `tenant_id, instrument_id, centre_id, instrument_code, display_name, vendor, model, state, is_active`, 08 §4.9; label reads only, 08 R25) — invoker views, so C5/C7 table RLS applies to C9's reader.

## 6. Published view `quality.v_pub_qc_summary` (03-IC §6.7 — columns are a contract)

Columns exactly: `tenant_id uuid, instrument_id uuid, analyte_id uuid, business_date date, runs bigint, accepted_runs bigint, rejected_runs bigint, warnings bigint, last_in_control_run_at timestamptz`. Definitions: runs = evaluated or closed runs whose `run_at` falls on `business_date` (Asia/Kathmandu, as in C5's views); `accepted_runs` = outcome `accepted` + `accepted_warning`; `rejected_runs` = `rejected`; `warnings` = `accepted_warning`; `last_in_control_run_at` = latest `accepted`/`accepted_warning` `run_at` before the end of `business_date` (may be on an earlier day). `incomplete` runs count in `runs` only. Consumer: C8.

## 7. Retention

| Data | Retention | Basis |
|---|---|---|
| QC set-up (M), runs, observations, corrective actions, reviews | ≥ tenant `retentionYears` (default 5) — never purged by C9 in v1 | 04 I8 audit floor; legal period BLOCKED B15; accreditation needs (01 §2.5) |
| `autoverify_decisions`, `verification_log` | tenant `retentionYears` (default 5, floor 5). **No purge in v1**: class A rows may be purged only by a `lims_owner` DEFINER with `app.maintenance`-bound owner policies and an 08 §4.7 inventory row (08 A17 P-18(c)); none is inventoried, and no row becomes eligible before 5 years. Requested from the lead as a later CR. | audit (04 D11, I8) |
| `tat_items` | `expires_at = stopped/cancelled/orphan_closed time + 400 days` [CONV]; deleted by C9's `quality.purge_tat_items` (`per_tenant`, daily, system actor, policy `tat_items__delete__tenant` — 08 A17 P-18(c)). Rows referenced by `tat_alert_events`/`tat_alert_acks` (class A) are skipped by the task predicate and kept with them [CONV, same handling as 08 A17 D-65] | derived; TAT reports come from C5/C6 views (C8) |
| `tat_alert_events`, `tat_alert_acks` | tenant `retentionYears`; no purge in v1 (class A, same rule as the decisions row) | audit of acknowledgements |
| `qc_activity`, `sync_state` | live state, no purge | E |
| `event_inbox` | 90 days (02-CV §5.11) | platform |

## 8. DDL

```sql
-- ===================== quality schema (C9) — Wave 2 =====================
-- Settings (M, 1 row per tenant)
CREATE TABLE quality.settings (
  id uuid NOT NULL, tenant_id uuid NOT NULL,
  tat_alerts_enabled boolean NOT NULL DEFAULT true,
  tat_warn_pct integer NOT NULL DEFAULT 80,
  tat_escalate_pct integer NOT NULL DEFAULT 150,
  tat_orphan_close_hours integer NOT NULL DEFAULT 72,
  target_min_points integer NOT NULL DEFAULT 20,
  sim_min_days integer NOT NULL DEFAULT 7,
  sim_min_decisions integer NOT NULL DEFAULT 100,
  reprocess_window_days integer NOT NULL DEFAULT 7,
  default_plan_params jsonb NOT NULL DEFAULT '{}'::jsonb,
  activated_at timestamptz NOT NULL,                        -- first C9 deploy for the tenant (sync start)
  is_active boolean NOT NULL DEFAULT true, version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT settings__pk PRIMARY KEY (id),
  CONSTRAINT settings__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT settings__tenant__uq UNIQUE (tenant_id),
  CONSTRAINT settings__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT settings__ranges__ck CHECK (tat_warn_pct BETWEEN 50 AND 99 AND tat_escalate_pct BETWEEN 101 AND 1000
    AND tat_orphan_close_hours BETWEEN 1 AND 720 AND target_min_points BETWEEN 2 AND 500 AND sim_min_days BETWEEN 1 AND 90
    AND sim_min_decisions BETWEEN 10 AND 100000 AND reprocess_window_days BETWEEN 1 AND 30),
  CONSTRAINT settings__params__ck CHECK (jsonb_typeof(default_plan_params) = 'object')
);

-- Coded sets
CREATE TABLE quality.g_cs_corrective_actions (
  id uuid NOT NULL, code text NOT NULL, display text NOT NULL, system text NOT NULL DEFAULT 'lims', system_version text NOT NULL DEFAULT '1',
  sort_order integer NOT NULL DEFAULT 0, is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT g_cs_corrective_actions__pk PRIMARY KEY (id),
  CONSTRAINT g_cs_corrective_actions__code__uq UNIQUE (code),
  CONSTRAINT g_cs_corrective_actions__code__ck CHECK (code ~ '^[a-z][a-z0-9_]{1,63}$' AND char_length(display) BETWEEN 1 AND 120)
);
CREATE TABLE quality.g_cs_exclusion_reasons (LIKE quality.g_cs_corrective_actions INCLUDING ALL);
-- (C0: rename the copied constraints/indexes to the g_cs_exclusion_reasons__* names.)

CREATE TABLE quality.cs_corrective_actions (
  id uuid NOT NULL, tenant_id uuid NOT NULL, code text NOT NULL, display text NOT NULL,
  system text NOT NULL DEFAULT 'tenant', system_version text NOT NULL DEFAULT '1', sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true, version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT cs_corrective_actions__pk PRIMARY KEY (id),
  CONSTRAINT cs_corrective_actions__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT cs_corrective_actions__tenant_code__uq UNIQUE (tenant_id, code),
  CONSTRAINT cs_corrective_actions__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT cs_corrective_actions__code__ck CHECK (code ~ '^[a-z][a-z0-9_]{1,63}$' AND char_length(display) BETWEEN 1 AND 120)
);
CREATE TABLE quality.cs_exclusion_reasons (LIKE quality.cs_corrective_actions INCLUDING ALL);
-- (C0: rename copied constraints; add FK cs_exclusion_reasons__tenant__fk.)

-- Control materials / levels / lots (M)
CREATE TABLE quality.control_materials (
  id uuid NOT NULL, tenant_id uuid NOT NULL,
  code text NOT NULL, name text NOT NULL, manufacturer text, matrix text,
  is_active boolean NOT NULL DEFAULT true, version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT control_materials__pk PRIMARY KEY (id),
  CONSTRAINT control_materials__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT control_materials__tenant_code__uq UNIQUE (tenant_id, code),
  CONSTRAINT control_materials__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT control_materials__text__ck CHECK (code ~ '^[A-Z0-9_-]{2,32}$' AND char_length(name) BETWEEN 1 AND 120
    AND char_length(coalesce(manufacturer,'')) <= 120 AND char_length(coalesce(matrix,'')) <= 60)
);

CREATE TABLE quality.control_levels (
  id uuid NOT NULL, tenant_id uuid NOT NULL, material_id uuid NOT NULL,
  level_code text NOT NULL, display_name text NOT NULL, sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true, version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT control_levels__pk PRIMARY KEY (id),
  CONSTRAINT control_levels__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT control_levels__tenant_material_code__uq UNIQUE (tenant_id, material_id, level_code),
  CONSTRAINT control_levels__material__fk FOREIGN KEY (tenant_id, material_id) REFERENCES quality.control_materials (tenant_id, id),
  CONSTRAINT control_levels__text__ck CHECK (level_code ~ '^[A-Za-z0-9]{1,16}$' AND char_length(display_name) BETWEEN 1 AND 60
    AND sort_order BETWEEN 0 AND 99)
);

CREATE TABLE quality.control_lots (
  id uuid NOT NULL, tenant_id uuid NOT NULL, level_id uuid NOT NULL, material_id uuid NOT NULL,
  lot_no text NOT NULL, expires_on date NOT NULL,
  is_active boolean NOT NULL DEFAULT true, version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT control_lots__pk PRIMARY KEY (id),
  CONSTRAINT control_lots__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT control_lots__tenant_level_lot__uq UNIQUE (tenant_id, level_id, lot_no),
  CONSTRAINT control_lots__level__fk FOREIGN KEY (tenant_id, level_id) REFERENCES quality.control_levels (tenant_id, id),
  CONSTRAINT control_lots__material__fk FOREIGN KEY (tenant_id, material_id) REFERENCES quality.control_materials (tenant_id, id),
  CONSTRAINT control_lots__lot__ck CHECK (lot_no ~ '^[\x21-\x7E]([\x20-\x7E]{0,62}[\x21-\x7E])?$')
);
CREATE INDEX control_lots__tenant_expires__idx ON quality.control_lots (tenant_id, expires_on) WHERE is_active;

-- Control-ID maps (M)
CREATE TABLE quality.control_id_maps (
  id uuid NOT NULL, tenant_id uuid NOT NULL,
  instrument_id uuid NOT NULL, control_id_raw text NOT NULL, control_lot_raw text,   -- NULL = any lot
  lot_id uuid NOT NULL,
  is_active boolean NOT NULL DEFAULT true, version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT control_id_maps__pk PRIMARY KEY (id),
  CONSTRAINT control_id_maps__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT control_id_maps__instrument__fk FOREIGN KEY (tenant_id, instrument_id) REFERENCES instruments.instruments (tenant_id, id),
  CONSTRAINT control_id_maps__lot__fk FOREIGN KEY (tenant_id, lot_id) REFERENCES quality.control_lots (tenant_id, id),
  CONSTRAINT control_id_maps__raw__ck CHECK (char_length(control_id_raw) BETWEEN 1 AND 64 AND char_length(coalesce(control_lot_raw,'x')) BETWEEN 1 AND 64)
);
CREATE UNIQUE INDEX control_id_maps__tenant_key__p_uq ON quality.control_id_maps
  (tenant_id, instrument_id, control_id_raw, coalesce(control_lot_raw, '')) WHERE is_active;
CREATE INDEX control_id_maps__tenant_instrument__idx ON quality.control_id_maps (tenant_id, instrument_id);

-- QC plans (M) + versions (immutable)
CREATE TABLE quality.qc_plans (
  id uuid NOT NULL, tenant_id uuid NOT NULL,
  instrument_id uuid NOT NULL, test_id uuid NOT NULL, analyte_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'inactive',
  current_version_no integer NOT NULL DEFAULT 1,
  is_active boolean NOT NULL DEFAULT true, version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT qc_plans__pk PRIMARY KEY (id),
  CONSTRAINT qc_plans__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT qc_plans__tenant_instrument_analyte__uq UNIQUE (tenant_id, instrument_id, analyte_id),
  CONSTRAINT qc_plans__instrument__fk FOREIGN KEY (tenant_id, instrument_id) REFERENCES instruments.instruments (tenant_id, id),
  CONSTRAINT qc_plans__test__fk FOREIGN KEY (tenant_id, test_id) REFERENCES catalog.tests (tenant_id, id),
  CONSTRAINT qc_plans__analyte__fk FOREIGN KEY (tenant_id, analyte_id) REFERENCES catalog.analytes (tenant_id, id),
  CONSTRAINT qc_plans__status__ck CHECK (status IN ('active','inactive'))
);

CREATE TABLE quality.qc_plan_versions (
  id uuid NOT NULL, tenant_id uuid NOT NULL, plan_id uuid NOT NULL, version_no integer NOT NULL,
  controls_per_run integer NOT NULL,
  composition jsonb NOT NULL,                       -- [{ "level_id": uuid, "count": 1..4 }]
  mean_rule text NOT NULL,
  two_two_s_across_runs boolean NOT NULL DEFAULT true,
  count_rules_across_materials boolean NOT NULL DEFAULT true,
  exclude_rejected_runs_from_history boolean NOT NULL DEFAULT true,
  run_window_minutes integer NOT NULL DEFAULT 30,
  qc_validity_hours integer NOT NULL DEFAULT 24,
  hold_lookback_hours integer NOT NULL DEFAULT 24,
  change_reason text,
  effective_from timestamptz NOT NULL,
  is_active boolean NOT NULL DEFAULT true, version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT qc_plan_versions__pk PRIMARY KEY (id),
  CONSTRAINT qc_plan_versions__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT qc_plan_versions__plan_version__uq UNIQUE (tenant_id, plan_id, version_no),
  CONSTRAINT qc_plan_versions__plan__fk FOREIGN KEY (tenant_id, plan_id) REFERENCES quality.qc_plans (tenant_id, id),
  CONSTRAINT qc_plan_versions__n__ck CHECK (controls_per_run IN (2,3,4)),
  CONSTRAINT qc_plan_versions__mean_rule__ck CHECK (
    (controls_per_run IN (2,4) AND mean_rule IN ('8x','10x','12x')) OR (controls_per_run = 3 AND mean_rule IN ('6x','9x'))),
  CONSTRAINT qc_plan_versions__composition__ck CHECK (jsonb_typeof(composition) = 'array'
    AND jsonb_array_length(composition) BETWEEN 1 AND 4),    -- sum(count) = N validated by the service (jsonb sums are not CHECK-friendly)
  CONSTRAINT qc_plan_versions__ranges__ck CHECK (run_window_minutes BETWEEN 5 AND 240 AND qc_validity_hours BETWEEN 1 AND 168
    AND hold_lookback_hours BETWEEN 1 AND 168 AND char_length(coalesce(change_reason,'')) <= 500)
);

-- Targets (M, values immutable)
CREATE TABLE quality.qc_targets (
  id uuid NOT NULL, tenant_id uuid NOT NULL, plan_id uuid NOT NULL, lot_id uuid NOT NULL, level_id uuid NOT NULL,
  mean numeric(20,6) NOT NULL, sd numeric(20,6) NOT NULL, unit_code text NOT NULL,
  source text NOT NULL,
  basis_n integer, basis_from timestamptz, basis_to timestamptz, basis_observation_ids_sha256 text,
  note text,
  status text NOT NULL DEFAULT 'draft',
  effective_from timestamptz, effective_to timestamptz,
  activated_at timestamptz, activated_by uuid, retired_at timestamptz, retired_by uuid, retire_reason text,
  is_active boolean NOT NULL DEFAULT true, version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT qc_targets__pk PRIMARY KEY (id),
  CONSTRAINT qc_targets__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT qc_targets__plan__fk FOREIGN KEY (tenant_id, plan_id) REFERENCES quality.qc_plans (tenant_id, id),
  CONSTRAINT qc_targets__lot__fk FOREIGN KEY (tenant_id, lot_id) REFERENCES quality.control_lots (tenant_id, id),
  CONSTRAINT qc_targets__level__fk FOREIGN KEY (tenant_id, level_id) REFERENCES quality.control_levels (tenant_id, id),
  CONSTRAINT qc_targets__sd__ck CHECK (sd > 0),
  CONSTRAINT qc_targets__source__ck CHECK (source IN ('manufacturer','established')),
  CONSTRAINT qc_targets__basis__ck CHECK (source <> 'established' OR (basis_n >= 2 AND basis_from IS NOT NULL AND basis_to IS NOT NULL)),
  CONSTRAINT qc_targets__basis_sha__ck CHECK (basis_observation_ids_sha256 IS NULL OR basis_observation_ids_sha256 ~ '^[0-9a-f]{64}$'),   -- row digest, hex text (08 A2.4)
  CONSTRAINT qc_targets__status__ck CHECK (status IN ('draft','active','superseded','retired','discarded')),
  CONSTRAINT qc_targets__effective__ck CHECK ((status IN ('draft','discarded')) OR effective_from IS NOT NULL),
  CONSTRAINT qc_targets__window__ck CHECK (effective_to IS NULL OR effective_to > effective_from),
  CONSTRAINT qc_targets__text__ck CHECK (char_length(coalesce(note,'')) <= 500 AND char_length(coalesce(retire_reason,'')) <= 500)
);
CREATE UNIQUE INDEX qc_targets__tenant_plan_lot_active__p_uq ON quality.qc_targets (tenant_id, plan_id, lot_id) WHERE status = 'active';
CREATE INDEX qc_targets__tenant_plan_lot_from__idx ON quality.qc_targets (tenant_id, plan_id, lot_id, effective_from DESC)
  WHERE status IN ('active','superseded');
CREATE TRIGGER qc_targets__mutable_columns BEFORE UPDATE ON quality.qc_targets FOR EACH ROW
  EXECUTE FUNCTION app.enforce_mutable_columns('status','effective_from','effective_to','activated_at','activated_by',
    'retired_at','retired_by','retire_reason','updated_at','updated_by','version');

-- Runs (C)
CREATE TABLE quality.qc_runs (
  id uuid NOT NULL, tenant_id uuid NOT NULL, plan_id uuid NOT NULL, plan_version_no integer NOT NULL,
  instrument_id uuid NOT NULL, analyte_id uuid NOT NULL,
  controls_per_run integer NOT NULL, rule_mode text NOT NULL, mean_rule text NOT NULL,
  run_at timestamptz NOT NULL,
  last_member_received_at timestamptz NOT NULL,
  last_assembled_at timestamptz NOT NULL,              -- server time of the last member added (stale-run close, 02-TRD §7.3 step 7)
  observation_count integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'collecting',
  outcome text, is_complete boolean,
  rules_violated text[] NOT NULL DEFAULT '{}', warning_rules text[] NOT NULL DEFAULT '{}',
  rule_detail jsonb NOT NULL DEFAULT '[]'::jsonb,           -- [{ "rule": code, "observation_ids": [uuid] }]
  evaluated_at timestamptz, evaluated_by uuid,
  last_in_control_run_at timestamptz, hold_since timestamptz, rejection_event_id uuid,
  closed_at timestamptz, closed_by uuid,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT qc_runs__pk PRIMARY KEY (id),
  CONSTRAINT qc_runs__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT qc_runs__plan__fk FOREIGN KEY (tenant_id, plan_id) REFERENCES quality.qc_plans (tenant_id, id),
  CONSTRAINT qc_runs__plan_version__fk FOREIGN KEY (tenant_id, plan_id, plan_version_no) REFERENCES quality.qc_plan_versions (tenant_id, plan_id, version_no),
  CONSTRAINT qc_runs__instrument__fk FOREIGN KEY (tenant_id, instrument_id) REFERENCES instruments.instruments (tenant_id, id),
  CONSTRAINT qc_runs__analyte__fk FOREIGN KEY (tenant_id, analyte_id) REFERENCES catalog.analytes (tenant_id, id),
  CONSTRAINT qc_runs__status__ck CHECK (status IN ('collecting','evaluated','closed')),
  CONSTRAINT qc_runs__outcome__ck CHECK (outcome IS NULL OR outcome IN ('accepted','accepted_warning','incomplete','rejected')),
  CONSTRAINT qc_runs__mode__ck CHECK (rule_mode IN ('classic','modern')),
  CONSTRAINT qc_runs__n__ck CHECK (controls_per_run IN (2,3,4)),
  CONSTRAINT qc_runs__lifecycle__ck CHECK (
       (status = 'collecting' AND outcome IS NULL AND evaluated_at IS NULL)
    OR (status = 'evaluated' AND outcome IS NOT NULL AND evaluated_at IS NOT NULL AND closed_at IS NULL)
    OR (status = 'closed' AND outcome = 'rejected' AND closed_at IS NOT NULL)),
  CONSTRAINT qc_runs__rejected__ck CHECK ((outcome = 'rejected') = (cardinality(rules_violated) >= 1) OR outcome IS NULL),
  CONSTRAINT qc_runs__hold__ck CHECK (outcome IS DISTINCT FROM 'rejected' OR hold_since IS NOT NULL),
  CONSTRAINT qc_runs__rules__ck CHECK (rules_violated <@ ARRAY['1-3s','2-2s','2of3-2s','R-4s','4-1s','3-1s','6x','8x','9x','10x','12x']::text[]
    AND warning_rules <@ ARRAY['1-2s']::text[])
);
CREATE UNIQUE INDEX qc_runs__tenant_plan_collecting__p_uq ON quality.qc_runs (tenant_id, plan_id) WHERE status = 'collecting';
CREATE INDEX qc_runs__tenant_plan_runat__idx ON quality.qc_runs (tenant_id, plan_id, run_at DESC);
CREATE INDEX qc_runs__tenant_plan_open_rejected__p_idx ON quality.qc_runs (tenant_id, plan_id, run_at DESC)
  WHERE outcome = 'rejected' AND status = 'evaluated';
CREATE INDEX qc_runs__tenant_collecting_assembled__p_idx ON quality.qc_runs (tenant_id, last_assembled_at) WHERE status = 'collecting';
CREATE INDEX qc_runs__tenant_runat__idx ON quality.qc_runs (tenant_id, run_at DESC);

CREATE FUNCTION quality.enforce_run_frozen() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF OLD.outcome IS NOT NULL AND (
       NEW.outcome IS DISTINCT FROM OLD.outcome OR NEW.rules_violated IS DISTINCT FROM OLD.rules_violated
    OR NEW.warning_rules IS DISTINCT FROM OLD.warning_rules OR NEW.is_complete IS DISTINCT FROM OLD.is_complete
    OR NEW.evaluated_at IS DISTINCT FROM OLD.evaluated_at OR NEW.hold_since IS DISTINCT FROM OLD.hold_since
    OR NEW.last_in_control_run_at IS DISTINCT FROM OLD.last_in_control_run_at OR NEW.run_at IS DISTINCT FROM OLD.run_at
    OR NEW.plan_id IS DISTINCT FROM OLD.plan_id OR NEW.rule_mode IS DISTINCT FROM OLD.rule_mode
    OR (OLD.status = 'closed' AND NEW.status IS DISTINCT FROM OLD.status)) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'immutable_row', DETAIL = 'quality.qc_runs';
  END IF;
  -- Close-out backstop for the #32 service guard: a rejected run is closed only with >= 1 corrective action.
  IF NEW.status = 'closed' AND OLD.status IS DISTINCT FROM 'closed' AND NOT EXISTS (
       SELECT 1 FROM quality.qc_corrective_actions ca WHERE ca.tenant_id = NEW.tenant_id AND ca.qc_run_id = NEW.id) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'immutable_row', DETAIL = 'quality.qc_runs: corrective action required';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER qc_runs__frozen BEFORE UPDATE ON quality.qc_runs FOR EACH ROW EXECUTE FUNCTION quality.enforce_run_frozen();

-- Observations (C)
CREATE TABLE quality.qc_observations (
  id uuid NOT NULL, tenant_id uuid NOT NULL,
  source_qc_result_id uuid NOT NULL,                  -- lab.qc_results.id via lab.v_pub_qc_result
  source text NOT NULL,
  instrument_id uuid NOT NULL, analyte_id uuid,
  control_id_raw text NOT NULL, control_lot_raw text, control_level_raw text,
  value numeric, unit_code text,
  instrument_result_time timestamptz, received_at timestamptz NOT NULL,
  observed_at timestamptz NOT NULL, observed_at_basis text NOT NULL,
  status text NOT NULL,
  plan_id uuid, level_id uuid, lot_id uuid, target_id uuid,
  mean numeric(20,6), sd numeric(20,6), z numeric(14,6),
  qc_run_id uuid,
  excluded_reason_code text, excluded_comment text, excluded_by uuid, excluded_at timestamptz,
  classified_at timestamptz NOT NULL,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT qc_observations__pk PRIMARY KEY (id),
  CONSTRAINT qc_observations__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT qc_observations__tenant_source__uq UNIQUE (tenant_id, source_qc_result_id),
  CONSTRAINT qc_observations__source_row__fk FOREIGN KEY (tenant_id, source_qc_result_id) REFERENCES lab.qc_results (tenant_id, id),
  CONSTRAINT qc_observations__instrument__fk FOREIGN KEY (tenant_id, instrument_id) REFERENCES instruments.instruments (tenant_id, id),
  CONSTRAINT qc_observations__analyte__fk FOREIGN KEY (tenant_id, analyte_id) REFERENCES catalog.analytes (tenant_id, id),
  CONSTRAINT qc_observations__plan__fk FOREIGN KEY (tenant_id, plan_id) REFERENCES quality.qc_plans (tenant_id, id),
  CONSTRAINT qc_observations__level__fk FOREIGN KEY (tenant_id, level_id) REFERENCES quality.control_levels (tenant_id, id),
  CONSTRAINT qc_observations__lot__fk FOREIGN KEY (tenant_id, lot_id) REFERENCES quality.control_lots (tenant_id, id),
  CONSTRAINT qc_observations__target__fk FOREIGN KEY (tenant_id, target_id) REFERENCES quality.qc_targets (tenant_id, id),
  CONSTRAINT qc_observations__run__fk FOREIGN KEY (tenant_id, qc_run_id) REFERENCES quality.qc_runs (tenant_id, id),
  CONSTRAINT qc_observations__source__ck CHECK (source IN ('instrument','manual')),
  CONSTRAINT qc_observations__basis__ck CHECK (observed_at_basis IN ('instrument','server')),
  CONSTRAINT qc_observations__status__ck CHECK (status IN ('unmapped_analyte','non_numeric','no_plan','unmapped_control',
    'level_not_in_plan','lot_expired','no_target','unit_mismatch','late_unassigned','assigned','excluded')),
  CONSTRAINT qc_observations__assigned__ck CHECK (status NOT IN ('assigned') OR (qc_run_id IS NOT NULL AND target_id IS NOT NULL
    AND mean IS NOT NULL AND sd IS NOT NULL AND value IS NOT NULL)),
  CONSTRAINT qc_observations__excluded__ck CHECK ((status = 'excluded') = (excluded_at IS NOT NULL)),
  CONSTRAINT qc_observations__text__ck CHECK (char_length(control_id_raw) <= 64 AND char_length(coalesce(control_lot_raw,'')) <= 64
    AND char_length(coalesce(control_level_raw,'')) <= 16 AND char_length(coalesce(excluded_comment,'')) <= 500)
);
CREATE INDEX qc_observations__tenant_plan_observed__idx ON quality.qc_observations (tenant_id, plan_id, observed_at, id);
CREATE INDEX qc_observations__tenant_run__idx ON quality.qc_observations (tenant_id, qc_run_id);
CREATE INDEX qc_observations__tenant_status_observed__p_idx ON quality.qc_observations (tenant_id, status, instrument_id, observed_at)
  WHERE status IN ('unmapped_analyte','non_numeric','no_plan','unmapped_control','level_not_in_plan','lot_expired','no_target','unit_mismatch','late_unassigned');
CREATE TRIGGER qc_observations__mutable_columns BEFORE UPDATE ON quality.qc_observations FOR EACH ROW
  EXECUTE FUNCTION app.enforce_mutable_columns('status','plan_id','level_id','lot_id','target_id','mean','sd','z','qc_run_id',
    'excluded_reason_code','excluded_comment','excluded_by','excluded_at','classified_at','updated_at','updated_by','version');

-- Exclusion only while the observation has no run or its run is still collecting (02-TRD #27; 03-APP-FLOW §2.2).
CREATE FUNCTION quality.enforce_observation_exclusion() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NEW.status = 'excluded' AND OLD.status IS DISTINCT FROM 'excluded' AND NEW.qc_run_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM quality.qc_runs r
                 WHERE r.tenant_id = NEW.tenant_id AND r.id = NEW.qc_run_id AND r.status <> 'collecting') THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'immutable_row', DETAIL = 'quality.qc_observations: run already evaluated';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER qc_observations__exclusion BEFORE UPDATE ON quality.qc_observations FOR EACH ROW
  EXECUTE FUNCTION quality.enforce_observation_exclusion();

-- Corrective actions / reviews (A)
CREATE TABLE quality.qc_corrective_actions (
  id uuid NOT NULL, tenant_id uuid NOT NULL, qc_run_id uuid NOT NULL,
  action_code text NOT NULL, description text NOT NULL, performed_at timestamptz NOT NULL, performed_by_membership_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  CONSTRAINT qc_corrective_actions__pk PRIMARY KEY (id),
  CONSTRAINT qc_corrective_actions__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT qc_corrective_actions__run__fk FOREIGN KEY (tenant_id, qc_run_id) REFERENCES quality.qc_runs (tenant_id, id),
  CONSTRAINT qc_corrective_actions__text__ck CHECK (char_length(description) BETWEEN 1 AND 1000 AND char_length(action_code) BETWEEN 1 AND 64)
);
CREATE INDEX qc_corrective_actions__tenant_run__idx ON quality.qc_corrective_actions (tenant_id, qc_run_id);

CREATE TABLE quality.qc_run_reviews (
  id uuid NOT NULL, tenant_id uuid NOT NULL, qc_run_id uuid NOT NULL,
  kind text NOT NULL, comment text, reviewed_by_membership_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  CONSTRAINT qc_run_reviews__pk PRIMARY KEY (id),
  CONSTRAINT qc_run_reviews__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT qc_run_reviews__run__fk FOREIGN KEY (tenant_id, qc_run_id) REFERENCES quality.qc_runs (tenant_id, id),
  CONSTRAINT qc_run_reviews__kind__ck CHECK (kind IN ('acknowledge','evaluate_now','close')),
  CONSTRAINT qc_run_reviews__comment__ck CHECK (char_length(coalesce(comment,'')) <= 500 AND (kind <> 'acknowledge' OR char_length(coalesce(comment,'')) >= 1))
);
CREATE INDEX qc_run_reviews__tenant_run__idx ON quality.qc_run_reviews (tenant_id, qc_run_id);

-- Activity counters and sync cursor (E)
CREATE TABLE quality.qc_activity (
  id uuid NOT NULL, tenant_id uuid NOT NULL, plan_id uuid NOT NULL,
  last_patient_result_at timestamptz, patient_results_since_last_qc integer NOT NULL DEFAULT 0,
  last_qc_run_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT qc_activity__pk PRIMARY KEY (id),
  CONSTRAINT qc_activity__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT qc_activity__tenant_plan__uq UNIQUE (tenant_id, plan_id),
  CONSTRAINT qc_activity__plan__fk FOREIGN KEY (tenant_id, plan_id) REFERENCES quality.qc_plans (tenant_id, id),
  CONSTRAINT qc_activity__count__ck CHECK (patient_results_since_last_qc >= 0)
);

CREATE TABLE quality.sync_state (
  id uuid NOT NULL, tenant_id uuid NOT NULL,
  qc_cursor_at timestamptz NOT NULL, qc_cursor_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sync_state__pk PRIMARY KEY (id),
  CONSTRAINT sync_state__tenant__uq UNIQUE (tenant_id),
  CONSTRAINT sync_state__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id)
);

-- Auto-verification (M + A)
CREATE TABLE quality.autoverify_rule_sets (
  id uuid NOT NULL, tenant_id uuid NOT NULL,
  active_version_id uuid, simulating_version_id uuid,
  is_active boolean NOT NULL DEFAULT true, version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT autoverify_rule_sets__pk PRIMARY KEY (id),
  CONSTRAINT autoverify_rule_sets__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT autoverify_rule_sets__tenant__uq UNIQUE (tenant_id),
  CONSTRAINT autoverify_rule_sets__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id)
);

CREATE TABLE quality.autoverify_versions (
  id uuid NOT NULL, tenant_id uuid NOT NULL, rule_set_id uuid NOT NULL, version_no integer NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  definition jsonb NOT NULL, rule_count integer NOT NULL,
  simulation_started_at timestamptz, simulation_started_by uuid, simulation_stopped_at timestamptz,
  activated_at timestamptz, activated_by uuid, retired_at timestamptz, retired_by uuid, retire_reason text,
  is_active boolean NOT NULL DEFAULT true, version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT autoverify_versions__pk PRIMARY KEY (id),
  CONSTRAINT autoverify_versions__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT autoverify_versions__set_version__uq UNIQUE (tenant_id, rule_set_id, version_no),
  CONSTRAINT autoverify_versions__set__fk FOREIGN KEY (tenant_id, rule_set_id) REFERENCES quality.autoverify_rule_sets (tenant_id, id),
  CONSTRAINT autoverify_versions__status__ck CHECK (status IN ('draft','simulating','stopped','active','retired','discarded')),   -- 'stopped': 08 A17 D-55
  CONSTRAINT autoverify_versions__definition__ck CHECK (jsonb_typeof(definition) = 'object' AND (definition ->> 'schema_version') = '1'
    AND rule_count BETWEEN 0 AND 2000 AND pg_column_size(definition) <= 1048576),
  CONSTRAINT autoverify_versions__activation__ck CHECK (status NOT IN ('active','retired') OR (activated_at IS NOT NULL AND activated_by IS NOT NULL
    AND activated_by <> created_by)),
  CONSTRAINT autoverify_versions__retire__ck CHECK (char_length(coalesce(retire_reason,'')) <= 500)
);
CREATE UNIQUE INDEX autoverify_versions__tenant_active__p_uq ON quality.autoverify_versions (tenant_id) WHERE status = 'active';
CREATE UNIQUE INDEX autoverify_versions__tenant_simulating__p_uq ON quality.autoverify_versions (tenant_id) WHERE status = 'simulating';
ALTER TABLE quality.autoverify_rule_sets
  ADD CONSTRAINT autoverify_rule_sets__active__fk FOREIGN KEY (tenant_id, active_version_id) REFERENCES quality.autoverify_versions (tenant_id, id),
  ADD CONSTRAINT autoverify_rule_sets__simulating__fk FOREIGN KEY (tenant_id, simulating_version_id) REFERENCES quality.autoverify_versions (tenant_id, id);

CREATE FUNCTION quality.enforce_version_frozen() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF OLD.status <> 'draft' AND (NEW.definition IS DISTINCT FROM OLD.definition OR NEW.rule_set_id IS DISTINCT FROM OLD.rule_set_id
       OR NEW.version_no IS DISTINCT FROM OLD.version_no OR NEW.created_by IS DISTINCT FROM OLD.created_by
       OR NEW.rule_count IS DISTINCT FROM OLD.rule_count) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'immutable_row', DETAIL = 'quality.autoverify_versions';
  END IF;
  IF OLD.status IN ('stopped','retired','discarded') AND NEW.status IS DISTINCT FROM OLD.status THEN   -- terminal states
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'immutable_row', DETAIL = 'quality.autoverify_versions';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER autoverify_versions__frozen BEFORE UPDATE ON quality.autoverify_versions FOR EACH ROW
  EXECUTE FUNCTION quality.enforce_version_frozen();

CREATE TABLE quality.autoverify_decisions (
  id uuid NOT NULL, tenant_id uuid NOT NULL,
  decided_at timestamptz NOT NULL,
  mode text NOT NULL, version_id uuid,
  result_id uuid NOT NULL, analyte_id uuid NOT NULL, instrument_id uuid,
  decision text NOT NULL, reasons text[] NOT NULL DEFAULT '{}',
  matched_rule_key text, qc_status text NOT NULL, qc_run_id uuid,
  inputs jsonb NOT NULL,             -- { value_numeric?, range_flag?, delta_check_failed, is_critical, instrument_flags[], resulted_at }
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  CONSTRAINT autoverify_decisions__pk PRIMARY KEY (id),
  CONSTRAINT autoverify_decisions__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT autoverify_decisions__result__fk FOREIGN KEY (tenant_id, result_id) REFERENCES lab.results (tenant_id, id),
  CONSTRAINT autoverify_decisions__version__fk FOREIGN KEY (tenant_id, version_id) REFERENCES quality.autoverify_versions (tenant_id, id),
  CONSTRAINT autoverify_decisions__mode__ck CHECK (mode IN ('live','shadow')),
  CONSTRAINT autoverify_decisions__decision__ck CHECK (decision IN ('allow','deny')),
  CONSTRAINT autoverify_decisions__allow__ck CHECK (decision <> 'allow' OR cardinality(reasons) = 0),   -- 03-IC §4.11 invariant
  CONSTRAINT autoverify_decisions__reasons__ck CHECK (reasons <@ ARRAY['feature_disabled','instrument_flag','outside_autoverify_limits',
    'critical','delta_failure','qc_out_of_control','qc_no_data','manual_origin','rule_missing','qc_warning']::text[]),
  CONSTRAINT autoverify_decisions__qc__ck CHECK (qc_status IN ('in_control','warning','out_of_control','no_qc_data','not_evaluated')),
  CONSTRAINT autoverify_decisions__inputs__ck CHECK (jsonb_typeof(inputs) = 'object')
);
CREATE INDEX autoverify_decisions__tenant_result__idx ON quality.autoverify_decisions (tenant_id, result_id, decided_at);
CREATE INDEX autoverify_decisions__tenant_version_mode_time__idx ON quality.autoverify_decisions (tenant_id, version_id, mode, decided_at);
CREATE INDEX autoverify_decisions__tenant_time__idx ON quality.autoverify_decisions (tenant_id, decided_at);

CREATE TABLE quality.verification_log (
  id uuid NOT NULL, tenant_id uuid NOT NULL,
  result_id uuid NOT NULL, result_version_no integer NOT NULL,
  order_id uuid NOT NULL, order_item_id uuid NOT NULL, test_id uuid NOT NULL, analyte_id uuid NOT NULL,
  mode text NOT NULL, verified_at timestamptz NOT NULL, event_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  CONSTRAINT verification_log__pk PRIMARY KEY (id),
  CONSTRAINT verification_log__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT verification_log__tenant_result_version__uq UNIQUE (tenant_id, result_id, result_version_no),
  CONSTRAINT verification_log__result__fk FOREIGN KEY (tenant_id, result_id) REFERENCES lab.results (tenant_id, id),
  CONSTRAINT verification_log__mode__ck CHECK (mode IN ('manual','auto'))
);
CREATE INDEX verification_log__tenant_verified__idx ON quality.verification_log (tenant_id, verified_at);

-- TAT (E + A, centre-scoped)
CREATE TABLE quality.tat_items (
  id uuid NOT NULL, tenant_id uuid NOT NULL, centre_id uuid NOT NULL,
  order_id uuid NOT NULL, order_item_id uuid NOT NULL, test_id uuid NOT NULL, specimen_id uuid NOT NULL,
  department_id uuid, processing_branch_id uuid,
  priority text NOT NULL, segment text NOT NULL, target_seconds integer NOT NULL,
  start_basis text NOT NULL,                          -- 08 A17 D-59 (total); within_lab rows: 'specimen_received_at'
  state text NOT NULL, started_at timestamptz, stopped_at timestamptz, stop_source text,
  restart_count integer NOT NULL DEFAULT 0,
  first_verified_at timestamptz,
  in_pending_view boolean NOT NULL DEFAULT true, left_pending_view_at timestamptz, last_seen_sweep_at timestamptz NOT NULL,
  alert_level text NOT NULL DEFAULT 'none', alert_level_at timestamptz,
  acknowledged_level text, acknowledged_at timestamptz, acknowledged_by uuid,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  expires_at timestamptz,
  CONSTRAINT tat_items__pk PRIMARY KEY (id),
  CONSTRAINT tat_items__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT tat_items__tenant_item_test__uq UNIQUE (tenant_id, order_item_id, test_id),
  CONSTRAINT tat_items__centre__fk FOREIGN KEY (tenant_id, centre_id) REFERENCES core.collection_centres (tenant_id, id),
  CONSTRAINT tat_items__order__fk FOREIGN KEY (tenant_id, order_id) REFERENCES frontdesk.orders (tenant_id, id),
  CONSTRAINT tat_items__order_item__fk FOREIGN KEY (tenant_id, order_item_id) REFERENCES frontdesk.order_items (tenant_id, id),
  CONSTRAINT tat_items__test__fk FOREIGN KEY (tenant_id, test_id) REFERENCES catalog.tests (tenant_id, id),
  CONSTRAINT tat_items__specimen__fk FOREIGN KEY (tenant_id, specimen_id) REFERENCES lab.specimens (tenant_id, id),
  CONSTRAINT tat_items__department__fk FOREIGN KEY (tenant_id, department_id) REFERENCES catalog.departments (tenant_id, id),
  CONSTRAINT tat_items__priority__ck CHECK (priority IN ('routine','urgent')),
  CONSTRAINT tat_items__segment__ck CHECK (segment IN ('within_lab','total')),
  CONSTRAINT tat_items__start_basis__ck CHECK ((segment = 'total' AND start_basis IN ('registered_at','specimen_ordered_at'))
    OR (segment = 'within_lab' AND start_basis = 'specimen_received_at')),
  CONSTRAINT tat_items__target__ck CHECK (target_seconds > 0),
  CONSTRAINT tat_items__state__ck CHECK (state IN ('not_started','running','stopped','cancelled','orphan_closed')),
  CONSTRAINT tat_items__running__ck CHECK (state <> 'running' OR started_at IS NOT NULL),
  CONSTRAINT tat_items__stopped__ck CHECK (state <> 'stopped' OR (stopped_at IS NOT NULL AND stop_source IN ('verified_event','release_event','sweep'))),
  CONSTRAINT tat_items__levels__ck CHECK (alert_level IN ('none','warning','breached','escalated')
    AND (acknowledged_level IS NULL OR acknowledged_level IN ('warning','breached','escalated')))
);
CREATE INDEX tat_items__tenant_running__p_idx ON quality.tat_items (tenant_id, state, segment) WHERE state IN ('not_started','running');
CREATE INDEX tat_items__tenant_open_alerts__p_idx ON quality.tat_items (tenant_id, alert_level, started_at)
  WHERE state = 'running' AND alert_level <> 'none';
CREATE INDEX tat_items__tenant_order__idx ON quality.tat_items (tenant_id, order_id);
CREATE INDEX tat_items__tenant_expires__idx ON quality.tat_items (tenant_id, expires_at) WHERE expires_at IS NOT NULL;

CREATE TABLE quality.tat_alert_events (
  id uuid NOT NULL, tenant_id uuid NOT NULL, centre_id uuid NOT NULL, tat_item_id uuid NOT NULL,
  level text NOT NULL, raised_at timestamptz NOT NULL, elapsed_seconds integer NOT NULL, restart_no integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  CONSTRAINT tat_alert_events__pk PRIMARY KEY (id),
  CONSTRAINT tat_alert_events__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT tat_alert_events__once__uq UNIQUE (tenant_id, tat_item_id, restart_no, level),
  CONSTRAINT tat_alert_events__item__fk FOREIGN KEY (tenant_id, tat_item_id) REFERENCES quality.tat_items (tenant_id, id),
  CONSTRAINT tat_alert_events__centre__fk FOREIGN KEY (tenant_id, centre_id) REFERENCES core.collection_centres (tenant_id, id),
  CONSTRAINT tat_alert_events__level__ck CHECK (level IN ('warning','breached','escalated'))
);

CREATE TABLE quality.tat_alert_acks (
  id uuid NOT NULL, tenant_id uuid NOT NULL, centre_id uuid NOT NULL, tat_item_id uuid NOT NULL,
  level text NOT NULL, note text, acknowledged_by_membership_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  CONSTRAINT tat_alert_acks__pk PRIMARY KEY (id),
  CONSTRAINT tat_alert_acks__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT tat_alert_acks__item__fk FOREIGN KEY (tenant_id, tat_item_id) REFERENCES quality.tat_items (tenant_id, id),
  CONSTRAINT tat_alert_acks__centre__fk FOREIGN KEY (tenant_id, centre_id) REFERENCES core.collection_centres (tenant_id, id),
  CONSTRAINT tat_alert_acks__level__ck CHECK (level IN ('warning','breached','escalated')),
  CONSTRAINT tat_alert_acks__note__ck CHECK (char_length(coalesce(note,'')) <= 500)
);
CREATE INDEX tat_alert_acks__tenant_item__idx ON quality.tat_alert_acks (tenant_id, tat_item_id);

-- RLS: apply §5 templates to every table above (tenant variant with the P-16 staff-actor guard; centre variant with the
-- A16.1 ::uuid[] cast for tat_items, tat_alert_events, tat_alert_acks; no UPDATE policy on A tables or qc_plan_versions;
-- tat_items__delete__tenant is the only DELETE policy; none on g_cs_*). quality.event_inbox comes from C0 (03-IC §12).
GRANT DELETE ON quality.tat_items TO lims_app;   -- 08 A17 P-18(c): E table, purge by quality.purge_tat_items only

-- Published view (03-IC §6.7)
CREATE VIEW quality.v_pub_qc_summary WITH (security_invoker = true) AS
WITH d AS (
  SELECT r.tenant_id, r.plan_id, r.instrument_id, r.analyte_id,
         (r.run_at AT TIME ZONE 'Asia/Kathmandu')::date AS business_date,
         count(*)::bigint AS runs,
         count(*) FILTER (WHERE r.outcome IN ('accepted','accepted_warning'))::bigint AS accepted_runs,
         count(*) FILTER (WHERE r.outcome = 'rejected')::bigint AS rejected_runs,
         count(*) FILTER (WHERE r.outcome = 'accepted_warning')::bigint AS warnings
  FROM quality.qc_runs r
  WHERE r.status IN ('evaluated','closed')
  GROUP BY r.tenant_id, r.plan_id, r.instrument_id, r.analyte_id, (r.run_at AT TIME ZONE 'Asia/Kathmandu')::date
)
SELECT d.tenant_id, d.instrument_id, d.analyte_id, d.business_date, d.runs, d.accepted_runs, d.rejected_runs, d.warnings,
       li.last_in_control_run_at
FROM d
LEFT JOIN LATERAL (
  SELECT max(r2.run_at) AS last_in_control_run_at
  FROM quality.qc_runs r2
  WHERE r2.tenant_id = d.tenant_id AND r2.plan_id = d.plan_id
    AND r2.outcome IN ('accepted','accepted_warning')
    AND r2.run_at < ((d.business_date + 1)::timestamp AT TIME ZONE 'Asia/Kathmandu')
) li ON true;
GRANT SELECT ON quality.v_pub_qc_summary TO lims_app;
```

## 9. Seed data (synthetic only — 02-CV §11.2)

Global (migration seed): the two coded sets in §2.

Per synthetic tenant (`tenant_a`, `tenant_b`; `packages/test-fixtures`, fixed seed):
- `quality.settings` row with defaults, `activated_at` = seed time − 120 days (seeded explicitly so fixtures are stable; production rows are created lazily by `settings.service.ensure`, 02-TRD §12.1, 08 A17 D-56).
- Control material `MCS-SYN` "Synthetic Multi-Chem Control" with levels `1`, `2`, `3`; two lots per level (`LOT-SYN-01` expiring seed + 200 days, `LOT-SYN-02` expired seed − 1 day for the `lot_expired` path).
- Control-ID maps for the synthetic instrument of C7's seed (`QC-L1`, `QC-L2`, `QC-L3`, any lot; plus one exact-lot map).
- QC plans for three synthetic analytes: K (N=2), GLU (N=3), HGB (N=4, `{L1:2, L2:2}`), each with an active target (mean/SD synthetic) and one superseded target.
- 90 days of synthetic observations per plan generated from N(mean, SD) with a fixed seed, plus injected patterns that reproduce V03, V04, V05, V10m, V12m, V16, V22 at known dates; one rejected run left open (no corrective action) and one closed with an accepted rerun.
- An auto-verify rule set: version 1 `active` (created by member A, activated by member B), version 2 `simulating` with 3 rules, and decision rows (live + shadow) for 200 synthetic results of C5's seed.
- TAT: no seed rows (derived by the sweep from C5's seeded pending items).

`tenant_b` uses different ids and one different plan (N=3 for K) so cross-tenant probes find no shared ids.
