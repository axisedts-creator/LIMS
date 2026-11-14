-- T0B-05: D-201 window step 3 of 3: app.enqueue_job / app.queue_depth owned by lims_queue (05-SCHEMA §10 queue wrapper, verbatim),
-- then the CREATE grants of step 1 are revoked (no standing CREATE; schema test 30).
SET LOCAL ROLE lims_owner;
-- graphile_worker is installed by the runner between step 1 and this file (SP-2 step b). LD-31 / CR T0B-05 item 3: no
-- check_function_bodies fallback; a deploy without step (b) fails here at migrate time.
RESET ROLE;
SET LOCAL ROLE lims_queue;   -- this migration file switches to lims_queue for these objects only
CREATE FUNCTION app.enqueue_job(identifier text, payload jsonb, job_key text DEFAULT NULL,
                                run_at timestamptz DEFAULT NULL, max_attempts int DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_reg record;
BEGIN
  SELECT r.scope, r.max_attempts INTO v_reg FROM core.g_task_registry r
   WHERE r.identifier = enqueue_job.identifier AND r.is_active;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'unknown_task_identifier';
  END IF;
  -- per_tenant identifiers need matching tenant claims. Cron ticks (08 A23.1) and tenant-row dead-letter replays (08 A23.2) get
  -- them from the worker/API core's withTenantScope(tenantId, <module system actor>); nothing relaxes this check.
  IF v_reg.scope = 'per_tenant' AND (app.current_tenant_id() IS NULL
       OR nullif(enqueue_job.payload ->> 'tenant_id', '')::uuid IS DISTINCT FROM app.current_tenant_id()) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'job_tenant_mismatch';
  END IF;
  PERFORM graphile_worker.add_job(
            identifier   => enqueue_job.identifier,
            payload      => enqueue_job.payload::json,
            run_at       => coalesce(enqueue_job.run_at, now()),
            max_attempts => coalesce(enqueue_job.max_attempts, v_reg.max_attempts)::smallint,
            job_key      => enqueue_job.job_key,
            job_key_mode => 'unsafe_dedupe');
END $$;
-- Queue depth for lims_queue_depth{task} (review C0 m#37): counts only — never payloads, keys or errors. Column names of the
-- graphile_worker.jobs view (task_identifier, run_at, locked_at, attempts, max_attempts) are UNVERIFIED for 0.18.0; SP-2 confirms
-- them (or this body is adjusted in the SP-2 PR) before T0B-05 merges.
CREATE FUNCTION app.queue_depth() RETURNS TABLE (task_identifier text, ready bigint, locked bigint, failed bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT j.task_identifier,
         count(*) FILTER (WHERE j.locked_at IS NULL AND j.attempts < j.max_attempts AND j.run_at <= now()),
         count(*) FILTER (WHERE j.locked_at IS NOT NULL),
         count(*) FILTER (WHERE j.attempts >= j.max_attempts)
  FROM graphile_worker.jobs j
  GROUP BY j.task_identifier
$$;
REVOKE ALL ON FUNCTION app.enqueue_job(text, jsonb, text, timestamptz, int), app.queue_depth() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.enqueue_job(text, jsonb, text, timestamptz, int) TO lims_app;
GRANT EXECUTE ON FUNCTION app.queue_depth() TO lims_worker;
RESET ROLE;  SET LOCAL ROLE lims_owner;
REVOKE CREATE ON SCHEMA app FROM lims_queue;                                                      -- D-201: close the window
DO $$ BEGIN EXECUTE format('REVOKE CREATE ON DATABASE %I FROM lims_queue', current_database()); END $$;
