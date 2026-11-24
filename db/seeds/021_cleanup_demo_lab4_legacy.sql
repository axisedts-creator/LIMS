BEGIN;
-- Required so audit triggers allow administrative maintenance
SELECT set_config('request.jwt.claims', '{"tenant_id":"01a1fec9-1f8b-785f-b077-1c4d4a85e8ac","sub":"01a1b34e-1000-7eee-9d29-d7ca59a102b5","actor_type":"system"}', true);
SET LOCAL app.maintenance = 'cleanup_legacy';

-- Temporarily disable draft-check triggers on child tables so unmapped legacy items can be pruned
ALTER TABLE catalog.price_list_items DISABLE TRIGGER price_list_items__parent_draft;
ALTER TABLE catalog.reference_ranges DISABLE TRIGGER reference_ranges__parent_draft;
ALTER TABLE catalog.critical_limits DISABLE TRIGGER critical_limits__parent_draft;
ALTER TABLE catalog.formula_dependencies DISABLE TRIGGER formula_dependencies__parent_draft;

-- 1. Remove quality schema dependencies
DELETE FROM quality.qc_corrective_actions
WHERE tenant_id = '01a1fec9-1f8b-785f-b077-1c4d4a85e8ac'::uuid
  AND qc_run_id IN (
    SELECT id FROM quality.qc_runs WHERE tenant_id = '01a1fec9-1f8b-785f-b077-1c4d4a85e8ac'::uuid
      AND (
        analyte_id IN (
          SELECT id FROM catalog.analytes WHERE tenant_id = '01a1fec9-1f8b-785f-b077-1c4d4a85e8ac'::uuid
            AND test_id NOT IN (SELECT orderable_id FROM engagement.bookable_items WHERE tenant_id = '01a1fec9-1f8b-785f-b077-1c4d4a85e8ac'::uuid)
        )
        OR plan_id IN (
          SELECT id FROM quality.qc_plans WHERE tenant_id = '01a1fec9-1f8b-785f-b077-1c4d4a85e8ac'::uuid
            AND test_id NOT IN (SELECT orderable_id FROM engagement.bookable_items WHERE tenant_id = '01a1fec9-1f8b-785f-b077-1c4d4a85e8ac'::uuid)
        )
      )
  );

DELETE FROM quality.qc_run_reviews
WHERE tenant_id = '01a1fec9-1f8b-785f-b077-1c4d4a85e8ac'::uuid
  AND qc_run_id IN (
    SELECT id FROM quality.qc_runs WHERE tenant_id = '01a1fec9-1f8b-785f-b077-1c4d4a85e8ac'::uuid
      AND (
        analyte_id IN (
          SELECT id FROM catalog.analytes WHERE tenant_id = '01a1fec9-1f8b-785f-b077-1c4d4a85e8ac'::uuid
            AND test_id NOT IN (SELECT orderable_id FROM engagement.bookable_items WHERE tenant_id = '01a1fec9-1f8b-785f-b077-1c4d4a85e8ac'::uuid)
        )
        OR plan_id IN (
          SELECT id FROM quality.qc_plans WHERE tenant_id = '01a1fec9-1f8b-785f-b077-1c4d4a85e8ac'::uuid
            AND test_id NOT IN (SELECT orderable_id FROM engagement.bookable_items WHERE tenant_id = '01a1fec9-1f8b-785f-b077-1c4d4a85e8ac'::uuid)
        )
      )
  );

DELETE FROM quality.qc_observations
WHERE tenant_id = '01a1fec9-1f8b-785f-b077-1c4d4a85e8ac'::uuid
  AND (
    analyte_id IN (
      SELECT id FROM catalog.analytes WHERE tenant_id = '01a1fec9-1f8b-785f-b077-1c4d4a85e8ac'::uuid
        AND test_id NOT IN (SELECT orderable_id FROM engagement.bookable_items WHERE tenant_id = '01a1fec9-1f8b-785f-b077-1c4d4a85e8ac'::uuid)
    )
    OR plan_id IN (
      SELECT id FROM quality.qc_plans WHERE tenant_id = '01a1fec9-1f8b-785f-b077-1c4d4a85e8ac'::uuid
        AND test_id NOT IN (SELECT orderable_id FROM engagement.bookable_items WHERE tenant_id = '01a1fec9-1f8b-785f-b077-1c4d4a85e8ac'::uuid)
    )
  );

DELETE FROM quality.qc_runs
WHERE tenant_id = '01a1fec9-1f8b-785f-b077-1c4d4a85e8ac'::uuid
  AND (
    analyte_id IN (
      SELECT id FROM catalog.analytes WHERE tenant_id = '01a1fec9-1f8b-785f-b077-1c4d4a85e8ac'::uuid
        AND test_id NOT IN (SELECT orderable_id FROM engagement.bookable_items WHERE tenant_id = '01a1fec9-1f8b-785f-b077-1c4d4a85e8ac'::uuid)
    )
    OR plan_id IN (
      SELECT id FROM quality.qc_plans WHERE tenant_id = '01a1fec9-1f8b-785f-b077-1c4d4a85e8ac'::uuid
        AND test_id NOT IN (SELECT orderable_id FROM engagement.bookable_items WHERE tenant_id = '01a1fec9-1f8b-785f-b077-1c4d4a85e8ac'::uuid)
    )
  );

DELETE FROM quality.qc_targets
WHERE tenant_id = '01a1fec9-1f8b-785f-b077-1c4d4a85e8ac'::uuid
  AND plan_id IN (
    SELECT id FROM quality.qc_plans WHERE tenant_id = '01a1fec9-1f8b-785f-b077-1c4d4a85e8ac'::uuid
      AND test_id NOT IN (SELECT orderable_id FROM engagement.bookable_items WHERE tenant_id = '01a1fec9-1f8b-785f-b077-1c4d4a85e8ac'::uuid)
  );

DELETE FROM quality.qc_activity
WHERE tenant_id = '01a1fec9-1f8b-785f-b077-1c4d4a85e8ac'::uuid
  AND plan_id IN (
    SELECT id FROM quality.qc_plans WHERE tenant_id = '01a1fec9-1f8b-785f-b077-1c4d4a85e8ac'::uuid
      AND test_id NOT IN (SELECT orderable_id FROM engagement.bookable_items WHERE tenant_id = '01a1fec9-1f8b-785f-b077-1c4d4a85e8ac'::uuid)
  );

DELETE FROM quality.qc_plan_versions
WHERE tenant_id = '01a1fec9-1f8b-785f-b077-1c4d4a85e8ac'::uuid
  AND plan_id IN (
    SELECT id FROM quality.qc_plans WHERE tenant_id = '01a1fec9-1f8b-785f-b077-1c4d4a85e8ac'::uuid
      AND test_id NOT IN (SELECT orderable_id FROM engagement.bookable_items WHERE tenant_id = '01a1fec9-1f8b-785f-b077-1c4d4a85e8ac'::uuid)
  );

DELETE FROM quality.qc_plans
WHERE tenant_id = '01a1fec9-1f8b-785f-b077-1c4d4a85e8ac'::uuid
  AND (
    analyte_id IN (
      SELECT id FROM catalog.analytes WHERE tenant_id = '01a1fec9-1f8b-785f-b077-1c4d4a85e8ac'::uuid
        AND test_id NOT IN (SELECT orderable_id FROM engagement.bookable_items WHERE tenant_id = '01a1fec9-1f8b-785f-b077-1c4d4a85e8ac'::uuid)
    )
    OR test_id NOT IN (SELECT orderable_id FROM engagement.bookable_items WHERE tenant_id = '01a1fec9-1f8b-785f-b077-1c4d4a85e8ac'::uuid)
  );

DELETE FROM quality.tat_alert_acks
WHERE tenant_id = '01a1fec9-1f8b-785f-b077-1c4d4a85e8ac'::uuid
  AND tat_item_id IN (
    SELECT id FROM quality.tat_items WHERE tenant_id = '01a1fec9-1f8b-785f-b077-1c4d4a85e8ac'::uuid
      AND test_id NOT IN (SELECT orderable_id FROM engagement.bookable_items WHERE tenant_id = '01a1fec9-1f8b-785f-b077-1c4d4a85e8ac'::uuid)
  );

DELETE FROM quality.tat_alert_events
WHERE tenant_id = '01a1fec9-1f8b-785f-b077-1c4d4a85e8ac'::uuid
  AND tat_item_id IN (
    SELECT id FROM quality.tat_items WHERE tenant_id = '01a1fec9-1f8b-785f-b077-1c4d4a85e8ac'::uuid
      AND test_id NOT IN (SELECT orderable_id FROM engagement.bookable_items WHERE tenant_id = '01a1fec9-1f8b-785f-b077-1c4d4a85e8ac'::uuid)
  );

DELETE FROM quality.tat_items
WHERE tenant_id = '01a1fec9-1f8b-785f-b077-1c4d4a85e8ac'::uuid
  AND test_id NOT IN (SELECT orderable_id FROM engagement.bookable_items WHERE tenant_id = '01a1fec9-1f8b-785f-b077-1c4d4a85e8ac'::uuid);

-- 2. Remove inventory and smartreport dependencies
DELETE FROM inventory.stock_movements
WHERE tenant_id = '01a1fec9-1f8b-785f-b077-1c4d4a85e8ac'::uuid
  AND attributed_test_id NOT IN (SELECT orderable_id FROM engagement.bookable_items WHERE tenant_id = '01a1fec9-1f8b-785f-b077-1c4d4a85e8ac'::uuid);

DELETE FROM inventory.consumption_facts
WHERE tenant_id = '01a1fec9-1f8b-785f-b077-1c4d4a85e8ac'::uuid
  AND (
    test_id NOT IN (SELECT orderable_id FROM engagement.bookable_items WHERE tenant_id = '01a1fec9-1f8b-785f-b077-1c4d4a85e8ac'::uuid)
    OR analyte_id IN (
      SELECT id FROM catalog.analytes WHERE tenant_id = '01a1fec9-1f8b-785f-b077-1c4d4a85e8ac'::uuid
        AND test_id NOT IN (SELECT orderable_id FROM engagement.bookable_items WHERE tenant_id = '01a1fec9-1f8b-785f-b077-1c4d4a85e8ac'::uuid)
    )
  );

DELETE FROM inventory.consumption_rules
WHERE tenant_id = '01a1fec9-1f8b-785f-b077-1c4d4a85e8ac'::uuid
  AND (
    analyte_id IN (
      SELECT id FROM catalog.analytes WHERE tenant_id = '01a1fec9-1f8b-785f-b077-1c4d4a85e8ac'::uuid
        AND test_id NOT IN (SELECT orderable_id FROM engagement.bookable_items WHERE tenant_id = '01a1fec9-1f8b-785f-b077-1c4d4a85e8ac'::uuid)
    )
    OR test_id NOT IN (SELECT orderable_id FROM engagement.bookable_items WHERE tenant_id = '01a1fec9-1f8b-785f-b077-1c4d4a85e8ac'::uuid)
  );

DELETE FROM smartreport.rules
WHERE tenant_id = '01a1fec9-1f8b-785f-b077-1c4d4a85e8ac'::uuid
  AND (
    analyte_id IN (
      SELECT id FROM catalog.analytes WHERE tenant_id = '01a1fec9-1f8b-785f-b077-1c4d4a85e8ac'::uuid
        AND test_id NOT IN (SELECT orderable_id FROM engagement.bookable_items WHERE tenant_id = '01a1fec9-1f8b-785f-b077-1c4d4a85e8ac'::uuid)
    )
    OR suggested_test_id NOT IN (SELECT orderable_id FROM engagement.bookable_items WHERE tenant_id = '01a1fec9-1f8b-785f-b077-1c4d4a85e8ac'::uuid)
  );

DELETE FROM smartreport.analyte_groups
WHERE tenant_id = '01a1fec9-1f8b-785f-b077-1c4d4a85e8ac'::uuid
  AND analyte_id IN (
    SELECT id FROM catalog.analytes WHERE tenant_id = '01a1fec9-1f8b-785f-b077-1c4d4a85e8ac'::uuid
      AND test_id NOT IN (SELECT orderable_id FROM engagement.bookable_items WHERE tenant_id = '01a1fec9-1f8b-785f-b077-1c4d4a85e8ac'::uuid)
  );

-- 3. Remove reporting and micro dependencies
DELETE FROM reporting.input_files
WHERE tenant_id = '01a1fec9-1f8b-785f-b077-1c4d4a85e8ac'::uuid
  AND narrative_report_id IN (
    SELECT id FROM reporting.narrative_reports WHERE tenant_id = '01a1fec9-1f8b-785f-b077-1c4d4a85e8ac'::uuid
      AND test_id NOT IN (SELECT orderable_id FROM engagement.bookable_items WHERE tenant_id = '01a1fec9-1f8b-785f-b077-1c4d4a85e8ac'::uuid)
  );

DELETE FROM reporting.narrative_versions
WHERE tenant_id = '01a1fec9-1f8b-785f-b077-1c4d4a85e8ac'::uuid
  AND narrative_report_id IN (
    SELECT id FROM reporting.narrative_reports WHERE tenant_id = '01a1fec9-1f8b-785f-b077-1c4d4a85e8ac'::uuid
      AND test_id NOT IN (SELECT orderable_id FROM engagement.bookable_items WHERE tenant_id = '01a1fec9-1f8b-785f-b077-1c4d4a85e8ac'::uuid)
  );

DELETE FROM reporting.narrative_reports
WHERE tenant_id = '01a1fec9-1f8b-785f-b077-1c4d4a85e8ac'::uuid
  AND test_id NOT IN (SELECT orderable_id FROM engagement.bookable_items WHERE tenant_id = '01a1fec9-1f8b-785f-b077-1c4d4a85e8ac'::uuid);

DELETE FROM reporting.narrative_templates
WHERE tenant_id = '01a1fec9-1f8b-785f-b077-1c4d4a85e8ac'::uuid
  AND test_id NOT IN (SELECT orderable_id FROM engagement.bookable_items WHERE tenant_id = '01a1fec9-1f8b-785f-b077-1c4d4a85e8ac'::uuid);

DELETE FROM micro.ast_results
WHERE tenant_id = '01a1fec9-1f8b-785f-b077-1c4d4a85e8ac'::uuid
  AND culture_id IN (SELECT id FROM micro.cultures WHERE tenant_id = '01a1fec9-1f8b-785f-b077-1c4d4a85e8ac'::uuid AND test_id NOT IN (SELECT orderable_id FROM engagement.bookable_items WHERE tenant_id = '01a1fec9-1f8b-785f-b077-1c4d4a85e8ac'::uuid));

DELETE FROM micro.isolates
WHERE tenant_id = '01a1fec9-1f8b-785f-b077-1c4d4a85e8ac'::uuid
  AND culture_id IN (SELECT id FROM micro.cultures WHERE tenant_id = '01a1fec9-1f8b-785f-b077-1c4d4a85e8ac'::uuid AND test_id NOT IN (SELECT orderable_id FROM engagement.bookable_items WHERE tenant_id = '01a1fec9-1f8b-785f-b077-1c4d4a85e8ac'::uuid));

DELETE FROM micro.culture_observations
WHERE tenant_id = '01a1fec9-1f8b-785f-b077-1c4d4a85e8ac'::uuid
  AND culture_id IN (SELECT id FROM micro.cultures WHERE tenant_id = '01a1fec9-1f8b-785f-b077-1c4d4a85e8ac'::uuid AND test_id NOT IN (SELECT orderable_id FROM engagement.bookable_items WHERE tenant_id = '01a1fec9-1f8b-785f-b077-1c4d4a85e8ac'::uuid));

DELETE FROM micro.culture_plates
WHERE tenant_id = '01a1fec9-1f8b-785f-b077-1c4d4a85e8ac'::uuid
  AND culture_id IN (SELECT id FROM micro.cultures WHERE tenant_id = '01a1fec9-1f8b-785f-b077-1c4d4a85e8ac'::uuid AND test_id NOT IN (SELECT orderable_id FROM engagement.bookable_items WHERE tenant_id = '01a1fec9-1f8b-785f-b077-1c4d4a85e8ac'::uuid));

DELETE FROM micro.culture_transitions
WHERE tenant_id = '01a1fec9-1f8b-785f-b077-1c4d4a85e8ac'::uuid
  AND culture_id IN (SELECT id FROM micro.cultures WHERE tenant_id = '01a1fec9-1f8b-785f-b077-1c4d4a85e8ac'::uuid AND test_id NOT IN (SELECT orderable_id FROM engagement.bookable_items WHERE tenant_id = '01a1fec9-1f8b-785f-b077-1c4d4a85e8ac'::uuid));

DELETE FROM micro.report_versions
WHERE tenant_id = '01a1fec9-1f8b-785f-b077-1c4d4a85e8ac'::uuid
  AND culture_id IN (SELECT id FROM micro.cultures WHERE tenant_id = '01a1fec9-1f8b-785f-b077-1c4d4a85e8ac'::uuid AND test_id NOT IN (SELECT orderable_id FROM engagement.bookable_items WHERE tenant_id = '01a1fec9-1f8b-785f-b077-1c4d4a85e8ac'::uuid));

DELETE FROM micro.instrument_records
WHERE tenant_id = '01a1fec9-1f8b-785f-b077-1c4d4a85e8ac'::uuid
  AND culture_id IN (SELECT id FROM micro.cultures WHERE tenant_id = '01a1fec9-1f8b-785f-b077-1c4d4a85e8ac'::uuid AND test_id NOT IN (SELECT orderable_id FROM engagement.bookable_items WHERE tenant_id = '01a1fec9-1f8b-785f-b077-1c4d4a85e8ac'::uuid));

DELETE FROM micro.cultures
WHERE tenant_id = '01a1fec9-1f8b-785f-b077-1c4d4a85e8ac'::uuid
  AND test_id NOT IN (SELECT orderable_id FROM engagement.bookable_items WHERE tenant_id = '01a1fec9-1f8b-785f-b077-1c4d4a85e8ac'::uuid);

DELETE FROM micro.plating_protocol_keys
WHERE tenant_id = '01a1fec9-1f8b-785f-b077-1c4d4a85e8ac'::uuid
  AND test_id NOT IN (SELECT orderable_id FROM engagement.bookable_items WHERE tenant_id = '01a1fec9-1f8b-785f-b077-1c4d4a85e8ac'::uuid);

-- 4. Remove catalog child dependencies for legacy orderables not in engagement.bookable_items
DELETE FROM catalog.panel_members
WHERE tenant_id = '01a1fec9-1f8b-785f-b077-1c4d4a85e8ac'::uuid
  AND (
    panel_id NOT IN (SELECT orderable_id FROM engagement.bookable_items WHERE tenant_id = '01a1fec9-1f8b-785f-b077-1c4d4a85e8ac'::uuid)
    OR member_orderable_id NOT IN (SELECT orderable_id FROM engagement.bookable_items WHERE tenant_id = '01a1fec9-1f8b-785f-b077-1c4d4a85e8ac'::uuid)
  );

DELETE FROM catalog.test_specimen_types
WHERE tenant_id = '01a1fec9-1f8b-785f-b077-1c4d4a85e8ac'::uuid
  AND test_id NOT IN (
    SELECT orderable_id FROM engagement.bookable_items WHERE tenant_id = '01a1fec9-1f8b-785f-b077-1c4d4a85e8ac'::uuid
  );

DELETE FROM catalog.tat_targets
WHERE tenant_id = '01a1fec9-1f8b-785f-b077-1c4d4a85e8ac'::uuid
  AND test_id NOT IN (
    SELECT orderable_id FROM engagement.bookable_items WHERE tenant_id = '01a1fec9-1f8b-785f-b077-1c4d4a85e8ac'::uuid
  );

DELETE FROM catalog.price_list_items
WHERE tenant_id = '01a1fec9-1f8b-785f-b077-1c4d4a85e8ac'::uuid
  AND orderable_id NOT IN (
    SELECT orderable_id FROM engagement.bookable_items WHERE tenant_id = '01a1fec9-1f8b-785f-b077-1c4d4a85e8ac'::uuid
  );

DELETE FROM catalog.surcharge_rules
WHERE tenant_id = '01a1fec9-1f8b-785f-b077-1c4d4a85e8ac'::uuid
  AND orderable_id NOT IN (
    SELECT orderable_id FROM engagement.bookable_items WHERE tenant_id = '01a1fec9-1f8b-785f-b077-1c4d4a85e8ac'::uuid
  );

DELETE FROM catalog.tax_rules
WHERE tenant_id = '01a1fec9-1f8b-785f-b077-1c4d4a85e8ac'::uuid
  AND orderable_id NOT IN (
    SELECT orderable_id FROM engagement.bookable_items WHERE tenant_id = '01a1fec9-1f8b-785f-b077-1c4d4a85e8ac'::uuid
  );

DELETE FROM catalog.instrument_code_maps
WHERE tenant_id = '01a1fec9-1f8b-785f-b077-1c4d4a85e8ac'::uuid
  AND test_id NOT IN (
    SELECT orderable_id FROM engagement.bookable_items WHERE tenant_id = '01a1fec9-1f8b-785f-b077-1c4d4a85e8ac'::uuid
  );

-- Analytes child dependencies if any exist for legacy tests
DELETE FROM catalog.formula_dependencies
WHERE tenant_id = '01a1fec9-1f8b-785f-b077-1c4d4a85e8ac'::uuid
  AND analyte_id IN (
    SELECT id FROM catalog.analytes WHERE tenant_id = '01a1fec9-1f8b-785f-b077-1c4d4a85e8ac'::uuid
      AND test_id NOT IN (SELECT orderable_id FROM engagement.bookable_items WHERE tenant_id = '01a1fec9-1f8b-785f-b077-1c4d4a85e8ac'::uuid)
  );

DELETE FROM catalog.reference_ranges
WHERE tenant_id = '01a1fec9-1f8b-785f-b077-1c4d4a85e8ac'::uuid
  AND set_id IN (
    SELECT id FROM catalog.reference_range_sets WHERE tenant_id = '01a1fec9-1f8b-785f-b077-1c4d4a85e8ac'::uuid
      AND analyte_id IN (
        SELECT id FROM catalog.analytes WHERE tenant_id = '01a1fec9-1f8b-785f-b077-1c4d4a85e8ac'::uuid
          AND test_id NOT IN (SELECT orderable_id FROM engagement.bookable_items WHERE tenant_id = '01a1fec9-1f8b-785f-b077-1c4d4a85e8ac'::uuid)
      )
  );

DELETE FROM catalog.critical_limits
WHERE tenant_id = '01a1fec9-1f8b-785f-b077-1c4d4a85e8ac'::uuid
  AND set_id IN (
    SELECT id FROM catalog.critical_limit_sets WHERE tenant_id = '01a1fec9-1f8b-785f-b077-1c4d4a85e8ac'::uuid
      AND analyte_id IN (
        SELECT id FROM catalog.analytes WHERE tenant_id = '01a1fec9-1f8b-785f-b077-1c4d4a85e8ac'::uuid
          AND test_id NOT IN (SELECT orderable_id FROM engagement.bookable_items WHERE tenant_id = '01a1fec9-1f8b-785f-b077-1c4d4a85e8ac'::uuid)
      )
  );

DELETE FROM catalog.reference_range_sets
WHERE tenant_id = '01a1fec9-1f8b-785f-b077-1c4d4a85e8ac'::uuid
  AND analyte_id IN (
    SELECT id FROM catalog.analytes WHERE tenant_id = '01a1fec9-1f8b-785f-b077-1c4d4a85e8ac'::uuid
      AND test_id NOT IN (SELECT orderable_id FROM engagement.bookable_items WHERE tenant_id = '01a1fec9-1f8b-785f-b077-1c4d4a85e8ac'::uuid)
  );

DELETE FROM catalog.critical_limit_sets
WHERE tenant_id = '01a1fec9-1f8b-785f-b077-1c4d4a85e8ac'::uuid
  AND analyte_id IN (
    SELECT id FROM catalog.analytes WHERE tenant_id = '01a1fec9-1f8b-785f-b077-1c4d4a85e8ac'::uuid
      AND test_id NOT IN (SELECT orderable_id FROM engagement.bookable_items WHERE tenant_id = '01a1fec9-1f8b-785f-b077-1c4d4a85e8ac'::uuid)
  );

DELETE FROM catalog.analyte_versions
WHERE tenant_id = '01a1fec9-1f8b-785f-b077-1c4d4a85e8ac'::uuid
  AND analyte_id IN (
    SELECT id FROM catalog.analytes WHERE tenant_id = '01a1fec9-1f8b-785f-b077-1c4d4a85e8ac'::uuid
      AND test_id NOT IN (SELECT orderable_id FROM engagement.bookable_items WHERE tenant_id = '01a1fec9-1f8b-785f-b077-1c4d4a85e8ac'::uuid)
  );

DELETE FROM catalog.analytes
WHERE tenant_id = '01a1fec9-1f8b-785f-b077-1c4d4a85e8ac'::uuid
  AND test_id NOT IN (
    SELECT orderable_id FROM engagement.bookable_items WHERE tenant_id = '01a1fec9-1f8b-785f-b077-1c4d4a85e8ac'::uuid
  );

-- 5. Dynamic pass to clear any custom/server-side tables referencing tests/panels/orderables (e.g. test_stage_tat_targets)
DO $$
DECLARE
  i INT;
  r RECORD;
BEGIN
  FOR i IN 1..3 LOOP
    FOR r IN (
      SELECT DISTINCT tc.table_schema, tc.table_name, kcu.column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu 
        ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
      JOIN information_schema.constraint_column_usage ccu 
        ON ccu.constraint_name = tc.constraint_name
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND ccu.table_schema = 'catalog'
        AND ccu.table_name IN ('tests', 'panels', 'orderables')
        AND NOT (tc.table_schema = 'catalog' AND tc.table_name IN ('tests', 'panels', 'orderables'))
    ) LOOP
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns 
          WHERE table_schema = r.table_schema AND table_name = r.table_name AND column_name = 'tenant_id'
        ) THEN
          EXECUTE format(
            'DELETE FROM %I.%I WHERE tenant_id = $1 AND %I NOT IN (SELECT orderable_id FROM engagement.bookable_items WHERE tenant_id = $1)',
            r.table_schema, r.table_name, r.column_name
          ) USING '01a1fec9-1f8b-785f-b077-1c4d4a85e8ac'::uuid;
        ELSE
          EXECUTE format(
            'DELETE FROM %I.%I WHERE %I NOT IN (SELECT orderable_id FROM engagement.bookable_items WHERE tenant_id = $1)',
            r.table_schema, r.table_name, r.column_name
          ) USING '01a1fec9-1f8b-785f-b077-1c4d4a85e8ac'::uuid;
        END IF;
      EXCEPTION WHEN OTHERS THEN
        NULL;
      END;
    END LOOP;
  END LOOP;
END $$;

-- 6. Delete legacy tests and panels not in engagement.bookable_items
DELETE FROM catalog.tests
WHERE tenant_id = '01a1fec9-1f8b-785f-b077-1c4d4a85e8ac'::uuid
  AND id NOT IN (
    SELECT orderable_id FROM engagement.bookable_items WHERE tenant_id = '01a1fec9-1f8b-785f-b077-1c4d4a85e8ac'::uuid
  );

DELETE FROM catalog.panels
WHERE tenant_id = '01a1fec9-1f8b-785f-b077-1c4d4a85e8ac'::uuid
  AND id NOT IN (
    SELECT orderable_id FROM engagement.bookable_items WHERE tenant_id = '01a1fec9-1f8b-785f-b077-1c4d4a85e8ac'::uuid
  );

-- 7. Delete legacy orderables not in engagement.bookable_items
DELETE FROM catalog.orderables
WHERE tenant_id = '01a1fec9-1f8b-785f-b077-1c4d4a85e8ac'::uuid
  AND id NOT IN (
    SELECT orderable_id FROM engagement.bookable_items WHERE tenant_id = '01a1fec9-1f8b-785f-b077-1c4d4a85e8ac'::uuid
  );

-- Re-enable triggers
ALTER TABLE catalog.price_list_items ENABLE TRIGGER price_list_items__parent_draft;
ALTER TABLE catalog.reference_ranges ENABLE TRIGGER reference_ranges__parent_draft;
ALTER TABLE catalog.critical_limits ENABLE TRIGGER critical_limits__parent_draft;
ALTER TABLE catalog.formula_dependencies ENABLE TRIGGER formula_dependencies__parent_draft;

COMMIT;
