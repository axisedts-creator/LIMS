-- T0B-13.C9 (LD-202): quality schema — C9 05-SCHEMA §8 DDL verbatim (25 tables, 26 indexes, 3 INVOKER trigger functions, 5 triggers,
-- view v_pub_qc_summary), the two spec LIKE copies written out [CONV], the §5 RLS templates written out as literal statements
-- (ENABLE + FORCE on the 23 tenant tables, 63 policies, grants), row-audit triggers on the 12 class M + 2 class C tables
-- (C0 05-SCHEMA §3.8 default) and the §2/§9 global coded-set seeds. Policies are copied 1:1 to db/policies/quality.sql (AC-0B-2.3).
-- quality.event_inbox belongs to T0B-05. Schema quality exists since T0B-01. No SECURITY DEFINER. Single role switch: lims_owner.
SET LOCAL ROLE lims_owner;

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
-- [CONV] spec LIKE ... INCLUDING ALL written out (check-migrations rejects LIKE); constraint names renamed to g_cs_exclusion_reasons__*.
CREATE TABLE quality.g_cs_exclusion_reasons (
  id uuid NOT NULL, code text NOT NULL, display text NOT NULL, system text NOT NULL DEFAULT 'lims', system_version text NOT NULL DEFAULT '1',
  sort_order integer NOT NULL DEFAULT 0, is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT g_cs_exclusion_reasons__pk PRIMARY KEY (id),
  CONSTRAINT g_cs_exclusion_reasons__code__uq UNIQUE (code),
  CONSTRAINT g_cs_exclusion_reasons__code__ck CHECK (code ~ '^[a-z][a-z0-9_]{1,63}$' AND char_length(display) BETWEEN 1 AND 120)
);

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
-- [CONV] spec LIKE ... INCLUDING ALL written out; constraints renamed, FK cs_exclusion_reasons__tenant__fk included (spec §8 note).
CREATE TABLE quality.cs_exclusion_reasons (
  id uuid NOT NULL, tenant_id uuid NOT NULL, code text NOT NULL, display text NOT NULL,
  system text NOT NULL DEFAULT 'tenant', system_version text NOT NULL DEFAULT '1', sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true, version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT cs_exclusion_reasons__pk PRIMARY KEY (id),
  CONSTRAINT cs_exclusion_reasons__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT cs_exclusion_reasons__tenant_code__uq UNIQUE (tenant_id, code),
  CONSTRAINT cs_exclusion_reasons__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT cs_exclusion_reasons__code__ck CHECK (code ~ '^[a-z][a-z0-9_]{1,63}$' AND char_length(display) BETWEEN 1 AND 120)
);

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
  CONSTRAINT sync_state__tenant_id_id__uq UNIQUE (tenant_id, id),   -- [CONV] C0 05-SCHEMA §9 rule 1
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

-- ===================== RLS (§5) =====================
ALTER TABLE quality.settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE quality.settings FORCE ROW LEVEL SECURITY;
ALTER TABLE quality.cs_corrective_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE quality.cs_corrective_actions FORCE ROW LEVEL SECURITY;
ALTER TABLE quality.cs_exclusion_reasons ENABLE ROW LEVEL SECURITY;
ALTER TABLE quality.cs_exclusion_reasons FORCE ROW LEVEL SECURITY;
ALTER TABLE quality.control_materials ENABLE ROW LEVEL SECURITY;
ALTER TABLE quality.control_materials FORCE ROW LEVEL SECURITY;
ALTER TABLE quality.control_levels ENABLE ROW LEVEL SECURITY;
ALTER TABLE quality.control_levels FORCE ROW LEVEL SECURITY;
ALTER TABLE quality.control_lots ENABLE ROW LEVEL SECURITY;
ALTER TABLE quality.control_lots FORCE ROW LEVEL SECURITY;
ALTER TABLE quality.control_id_maps ENABLE ROW LEVEL SECURITY;
ALTER TABLE quality.control_id_maps FORCE ROW LEVEL SECURITY;
ALTER TABLE quality.qc_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE quality.qc_plans FORCE ROW LEVEL SECURITY;
ALTER TABLE quality.qc_plan_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE quality.qc_plan_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE quality.qc_targets ENABLE ROW LEVEL SECURITY;
ALTER TABLE quality.qc_targets FORCE ROW LEVEL SECURITY;
ALTER TABLE quality.qc_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE quality.qc_runs FORCE ROW LEVEL SECURITY;
ALTER TABLE quality.qc_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE quality.qc_observations FORCE ROW LEVEL SECURITY;
ALTER TABLE quality.qc_corrective_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE quality.qc_corrective_actions FORCE ROW LEVEL SECURITY;
ALTER TABLE quality.qc_run_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE quality.qc_run_reviews FORCE ROW LEVEL SECURITY;
ALTER TABLE quality.qc_activity ENABLE ROW LEVEL SECURITY;
ALTER TABLE quality.qc_activity FORCE ROW LEVEL SECURITY;
ALTER TABLE quality.sync_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE quality.sync_state FORCE ROW LEVEL SECURITY;
ALTER TABLE quality.autoverify_rule_sets ENABLE ROW LEVEL SECURITY;
ALTER TABLE quality.autoverify_rule_sets FORCE ROW LEVEL SECURITY;
ALTER TABLE quality.autoverify_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE quality.autoverify_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE quality.autoverify_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE quality.autoverify_decisions FORCE ROW LEVEL SECURITY;
ALTER TABLE quality.verification_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE quality.verification_log FORCE ROW LEVEL SECURITY;
ALTER TABLE quality.tat_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE quality.tat_items FORCE ROW LEVEL SECURITY;
ALTER TABLE quality.tat_alert_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE quality.tat_alert_events FORCE ROW LEVEL SECURITY;
ALTER TABLE quality.tat_alert_acks ENABLE ROW LEVEL SECURITY;
ALTER TABLE quality.tat_alert_acks FORCE ROW LEVEL SECURITY;

-- ===================== policies (§5 templates; copy in db/policies/quality.sql) =====================
CREATE POLICY settings__select__tenant ON quality.settings FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY settings__insert__tenant ON quality.settings FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY settings__update__tenant ON quality.settings FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY cs_corrective_actions__select__tenant ON quality.cs_corrective_actions FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY cs_corrective_actions__insert__tenant ON quality.cs_corrective_actions FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY cs_corrective_actions__update__tenant ON quality.cs_corrective_actions FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY cs_exclusion_reasons__select__tenant ON quality.cs_exclusion_reasons FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY cs_exclusion_reasons__insert__tenant ON quality.cs_exclusion_reasons FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY cs_exclusion_reasons__update__tenant ON quality.cs_exclusion_reasons FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY control_materials__select__tenant ON quality.control_materials FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY control_materials__insert__tenant ON quality.control_materials FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY control_materials__update__tenant ON quality.control_materials FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY control_levels__select__tenant ON quality.control_levels FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY control_levels__insert__tenant ON quality.control_levels FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY control_levels__update__tenant ON quality.control_levels FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY control_lots__select__tenant ON quality.control_lots FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY control_lots__insert__tenant ON quality.control_lots FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY control_lots__update__tenant ON quality.control_lots FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY control_id_maps__select__tenant ON quality.control_id_maps FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY control_id_maps__insert__tenant ON quality.control_id_maps FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY control_id_maps__update__tenant ON quality.control_id_maps FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY qc_plans__select__tenant ON quality.qc_plans FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY qc_plans__insert__tenant ON quality.qc_plans FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY qc_plans__update__tenant ON quality.qc_plans FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY qc_plan_versions__select__tenant ON quality.qc_plan_versions FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY qc_plan_versions__insert__tenant ON quality.qc_plan_versions FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY qc_targets__select__tenant ON quality.qc_targets FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY qc_targets__insert__tenant ON quality.qc_targets FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY qc_targets__update__tenant ON quality.qc_targets FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY qc_runs__select__tenant ON quality.qc_runs FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY qc_runs__insert__tenant ON quality.qc_runs FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY qc_runs__update__tenant ON quality.qc_runs FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY qc_observations__select__tenant ON quality.qc_observations FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY qc_observations__insert__tenant ON quality.qc_observations FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY qc_observations__update__tenant ON quality.qc_observations FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY qc_corrective_actions__select__tenant ON quality.qc_corrective_actions FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY qc_corrective_actions__insert__tenant ON quality.qc_corrective_actions FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY qc_run_reviews__select__tenant ON quality.qc_run_reviews FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY qc_run_reviews__insert__tenant ON quality.qc_run_reviews FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY qc_activity__select__tenant ON quality.qc_activity FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY qc_activity__insert__tenant ON quality.qc_activity FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY qc_activity__update__tenant ON quality.qc_activity FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY sync_state__select__tenant ON quality.sync_state FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY sync_state__insert__tenant ON quality.sync_state FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY sync_state__update__tenant ON quality.sync_state FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY autoverify_rule_sets__select__tenant ON quality.autoverify_rule_sets FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY autoverify_rule_sets__insert__tenant ON quality.autoverify_rule_sets FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY autoverify_rule_sets__update__tenant ON quality.autoverify_rule_sets FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY autoverify_versions__select__tenant ON quality.autoverify_versions FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY autoverify_versions__insert__tenant ON quality.autoverify_versions FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY autoverify_versions__update__tenant ON quality.autoverify_versions FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY autoverify_decisions__select__tenant ON quality.autoverify_decisions FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY autoverify_decisions__insert__tenant ON quality.autoverify_decisions FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY verification_log__select__tenant ON quality.verification_log FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY verification_log__insert__tenant ON quality.verification_log FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY tat_items__select__tenant_centre ON quality.tat_items FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY tat_items__insert__tenant_centre ON quality.tat_items FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY tat_items__update__tenant_centre ON quality.tat_items FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY tat_alert_events__select__tenant_centre ON quality.tat_alert_events FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY tat_alert_events__insert__tenant_centre ON quality.tat_alert_events FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY tat_alert_acks__select__tenant_centre ON quality.tat_alert_acks FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY tat_alert_acks__insert__tenant_centre ON quality.tat_alert_acks FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
-- [CONV] staff guard added (08 A17 P-16, gate 9 check-registry; C5..C8 precedent); otherwise spec §5 text (P-18(c) purge, system actor).
CREATE POLICY tat_items__delete__tenant ON quality.tat_items FOR DELETE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) = 'system'
         AND expires_at < now());

-- ===================== grants (§5) =====================
GRANT SELECT ON quality.g_cs_corrective_actions, quality.g_cs_exclusion_reasons TO lims_app;
GRANT SELECT, INSERT, UPDATE ON quality.settings TO lims_app;
GRANT SELECT, INSERT, UPDATE ON quality.cs_corrective_actions TO lims_app;
GRANT SELECT, INSERT, UPDATE ON quality.cs_exclusion_reasons TO lims_app;
GRANT SELECT, INSERT, UPDATE ON quality.control_materials TO lims_app;
GRANT SELECT, INSERT, UPDATE ON quality.control_levels TO lims_app;
GRANT SELECT, INSERT, UPDATE ON quality.control_lots TO lims_app;
GRANT SELECT, INSERT, UPDATE ON quality.control_id_maps TO lims_app;
GRANT SELECT, INSERT, UPDATE ON quality.qc_plans TO lims_app;
GRANT SELECT, INSERT ON quality.qc_plan_versions TO lims_app;
GRANT SELECT, INSERT, UPDATE ON quality.qc_targets TO lims_app;
GRANT SELECT, INSERT, UPDATE ON quality.qc_runs TO lims_app;
GRANT SELECT, INSERT, UPDATE ON quality.qc_observations TO lims_app;
GRANT SELECT, INSERT ON quality.qc_corrective_actions TO lims_app;
GRANT SELECT, INSERT ON quality.qc_run_reviews TO lims_app;
GRANT SELECT, INSERT, UPDATE ON quality.qc_activity TO lims_app;
GRANT SELECT, INSERT, UPDATE ON quality.sync_state TO lims_app;
GRANT SELECT, INSERT, UPDATE ON quality.autoverify_rule_sets TO lims_app;
GRANT SELECT, INSERT, UPDATE ON quality.autoverify_versions TO lims_app;
GRANT SELECT, INSERT ON quality.autoverify_decisions TO lims_app;
GRANT SELECT, INSERT ON quality.verification_log TO lims_app;
GRANT SELECT, INSERT, UPDATE ON quality.tat_items TO lims_app;
GRANT SELECT, INSERT ON quality.tat_alert_events TO lims_app;
GRANT SELECT, INSERT ON quality.tat_alert_acks TO lims_app;

-- ===================== row audit (C0 05-SCHEMA §3.8: every class M / C table) =====================
CREATE TRIGGER settings__audit AFTER INSERT OR UPDATE OR DELETE ON quality.settings FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER cs_corrective_actions__audit AFTER INSERT OR UPDATE OR DELETE ON quality.cs_corrective_actions FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER cs_exclusion_reasons__audit AFTER INSERT OR UPDATE OR DELETE ON quality.cs_exclusion_reasons FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER control_materials__audit AFTER INSERT OR UPDATE OR DELETE ON quality.control_materials FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER control_levels__audit AFTER INSERT OR UPDATE OR DELETE ON quality.control_levels FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER control_lots__audit AFTER INSERT OR UPDATE OR DELETE ON quality.control_lots FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER control_id_maps__audit AFTER INSERT OR UPDATE OR DELETE ON quality.control_id_maps FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER qc_plans__audit AFTER INSERT OR UPDATE OR DELETE ON quality.qc_plans FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER qc_plan_versions__audit AFTER INSERT OR UPDATE OR DELETE ON quality.qc_plan_versions FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER qc_targets__audit AFTER INSERT OR UPDATE OR DELETE ON quality.qc_targets FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER qc_runs__audit AFTER INSERT OR UPDATE OR DELETE ON quality.qc_runs FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER qc_observations__audit AFTER INSERT OR UPDATE OR DELETE ON quality.qc_observations FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER autoverify_rule_sets__audit AFTER INSERT OR UPDATE OR DELETE ON quality.autoverify_rule_sets FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER autoverify_versions__audit AFTER INSERT OR UPDATE OR DELETE ON quality.autoverify_versions FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();

-- ===================== global coded-set seeds (§2, §9) =====================
INSERT INTO quality.g_cs_corrective_actions (id, code, display, sort_order, is_active) VALUES
  ('019a0000-c009-7000-8001-000000000001', 'recalibration', 'Recalibrated', 10, true),
  ('019a0000-c009-7000-8001-000000000002', 'new_control_vial', 'New control vial', 20, true),
  ('019a0000-c009-7000-8001-000000000003', 'new_reagent_lot', 'New reagent lot/pack', 30, true),
  ('019a0000-c009-7000-8001-000000000004', 'instrument_maintenance', 'Instrument maintenance', 40, true),
  ('019a0000-c009-7000-8001-000000000005', 'control_reconstituted', 'Control re-reconstituted', 50, true),
  ('019a0000-c009-7000-8001-000000000006', 'repeat_control', 'Control repeated (no other change)', 60, true),
  ('019a0000-c009-7000-8001-000000000007', 'other', 'Other', 70, true)
ON CONFLICT (code) DO NOTHING;
INSERT INTO quality.g_cs_exclusion_reasons (id, code, display, sort_order, is_active) VALUES
  ('019a0000-c009-7000-8002-000000000001', 'wrong_material', 'Wrong control material', 10, true),
  ('019a0000-c009-7000-8002-000000000002', 'wrong_level_mapping', 'Wrong level/lot mapping', 20, true),
  ('019a0000-c009-7000-8002-000000000003', 'handling_error', 'Handling error', 30, true),
  ('019a0000-c009-7000-8002-000000000004', 'instrument_error', 'Instrument error message', 40, true),
  ('019a0000-c009-7000-8002-000000000005', 'duplicate_entry', 'Duplicate entry', 50, true),
  ('019a0000-c009-7000-8002-000000000006', 'other', 'Other', 60, true)
ON CONFLICT (code) DO NOTHING;
