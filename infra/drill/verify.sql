-- infra/drill/verify.sql - restore-drill step 3 (02-TRD s9.6, AC-13.1), run by psql as the scratch
-- superuser on the restored copy:  psql -X -At -v target_time='<ts>' -f verify.sql
-- One line per check: "<check> PASS|FAIL|SKIP <counts>". No ON_ERROR_STOP: a check that errors prints
-- no PASS line and the playbook counts it as failed (03-APP-FLOW s4.1 "failures counted, not fatal").
-- Counts only, never row contents (03-APP-FLOW s4.3, 07-SEC control 2). Read-only except
-- CREATE EXTENSION amcheck on the scratch copy. Expected check lines: 5 (the playbook relies on it).

-- 1. recovery ended (target-action=promote)
SELECT 'recovery_ended ' || CASE WHEN NOT pg_is_in_recovery() THEN 'PASS' ELSE 'FAIL' END;

-- 2. newest audit row within 45 min of the PITR target
SELECT 'audit_recency '
       || CASE WHEN max(occurred_at) IS NOT NULL
                AND max(occurred_at) BETWEEN (:'target_time')::timestamptz - interval '45 minutes'
                                         AND (:'target_time')::timestamptz + interval '45 minutes'
               THEN 'PASS' ELSE 'FAIL' END
       || ' gap_s=' || coalesce(round(extract(epoch FROM (:'target_time')::timestamptz - max(occurred_at)))::text, 'none')
  FROM audit.audit_log;

-- 3./4. per-tenant row counts > 0 for every active tenant
SELECT 'tenant_invoices '
       || CASE WHEN count(*) FILTER (WHERE NOT EXISTS (
                 SELECT 1 FROM billing.invoices i WHERE i.tenant_id = t.id)) = 0 THEN 'PASS' ELSE 'FAIL' END
       || ' active_tenants=' || count(*)
       || ' without_rows=' || count(*) FILTER (WHERE NOT EXISTS (
                 SELECT 1 FROM billing.invoices i WHERE i.tenant_id = t.id))
  FROM core.tenants t WHERE t.status = 'active';

SELECT 'tenant_audit '
       || CASE WHEN count(*) FILTER (WHERE NOT EXISTS (
                 SELECT 1 FROM audit.audit_log a WHERE a.tenant_id = t.id)) = 0 THEN 'PASS' ELSE 'FAIL' END
       || ' active_tenants=' || count(*)
       || ' without_rows=' || count(*) FILTER (WHERE NOT EXISTS (
                 SELECT 1 FROM audit.audit_log a WHERE a.tenant_id = t.id))
  FROM core.tenants t WHERE t.status = 'active';

-- 5. amcheck bt_index_check on the 20 largest btree indexes; SKIP when the image lacks amcheck
SELECT EXISTS (SELECT 1 FROM pg_available_extensions() AS x(ext, v, c) WHERE ext = 'amcheck')
       AS amcheck_available \gset
\if :amcheck_available
CREATE EXTENSION IF NOT EXISTS amcheck;
DO $$
DECLARE
  r record;
  checked int := 0;
  corrupt int := 0;
BEGIN
  FOR r IN
    SELECT c.oid AS idx
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
      JOIN pg_am am ON am.oid = c.relam
     WHERE am.amname = 'btree' AND i.indisvalid AND c.relpersistence <> 't'
     ORDER BY pg_relation_size(c.oid) DESC
     LIMIT 20
  LOOP
    checked := checked + 1;
    BEGIN
      PERFORM bt_index_check(r.idx::regclass);
    EXCEPTION WHEN OTHERS THEN
      corrupt := corrupt + 1;
    END;
  END LOOP;
  RAISE NOTICE 'amcheck_top20 % checked=% corrupt=%',
    CASE WHEN corrupt = 0 THEN 'PASS' ELSE 'FAIL' END, checked, corrupt;
END
$$;
\else
SELECT 'amcheck_top20 SKIP amcheck not available in the image';
\endif

-- verified LSN for the drill log (AC-13.1); informational, not a check
SELECT 'verified_lsn ' || pg_current_wal_lsn();
