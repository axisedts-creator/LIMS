-- T0B-05: platform tables (05-SCHEMA §3.5, §10 "platform tables"), class G registries, dead-letter transition trigger (§4.4),
-- RLS of event_log / dead_letters / idempotency_keys (§6, §10 RLS), rate limit (04 S11), retention purges (CV §5.11; D-200),
-- platform dead letters (08 A9.4), platform tenant list (08 A12.3), cron fan-out (P-6), tenant-code resolver (D-121),
-- throttled-IP tenant lookup (D-217). DDL copied verbatim from 05-SCHEMA §10. Owner lims_owner (file role).
-- <m>.event_inbox: 20261105001000; queue wrapper (D-201 window, owner lims_queue): 20261105001100 + 20261105001200.
SET LOCAL ROLE lims_owner;

-- ===================================================================== platform tables (IC §12)
CREATE TABLE core.event_log (
  tenant_id uuid NOT NULL, event_id uuid NOT NULL, event_type text NOT NULL, producer text NOT NULL,
  idempotency_key text NOT NULL, aggregate_type text NOT NULL, aggregate_id uuid NOT NULL, aggregate_seq integer NOT NULL,
  occurred_at timestamptz NOT NULL, envelope jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  CONSTRAINT event_log__pk PRIMARY KEY (tenant_id, event_id),
  CONSTRAINT event_log__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT event_log__idem__ck CHECK (char_length(idempotency_key) BETWEEN 1 AND 200),
  CONSTRAINT event_log__seq__ck CHECK (aggregate_seq >= 1)
);
CREATE UNIQUE INDEX event_log__tenant_id_event_type_idempotency_key__uq ON core.event_log (tenant_id, event_type, idempotency_key);
CREATE INDEX event_log__tenant_id_aggregate__idx ON core.event_log (tenant_id, aggregate_type, aggregate_id, aggregate_seq);
CREATE INDEX event_log__created_at__brin ON core.event_log USING brin (created_at);            -- EXCEPTION: retention

CREATE TABLE core.dead_letters (
  id uuid NOT NULL, tenant_id uuid,                                  -- NULL only for platform tasks (IC §12)
  task_identifier text NOT NULL, job_payload jsonb NOT NULL,
  last_error_code text NOT NULL, last_error_message_redacted text NOT NULL, attempts integer NOT NULL,
  first_failed_at timestamptz NOT NULL, dead_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'open', resolved_by uuid, resolved_at timestamptz,
  resolution_note text,                                              -- 08 A8.4: discard reason / optional replay note
  job_key text,                                                      -- 08 A23.2: the failed job's job_key (helpers.job.key), copied at dead-lettering
  version integer NOT NULL DEFAULT 1,                                -- 08 A3.4: If-Match on replay/discard
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  CONSTRAINT dead_letters__pk PRIMARY KEY (id),
  CONSTRAINT dead_letters__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT dead_letters__state__ck CHECK (state IN ('open','replayed','discarded')),
  CONSTRAINT dead_letters__resolved__ck CHECK ((state = 'open') = (resolved_at IS NULL) AND (resolved_at IS NULL) = (resolved_by IS NULL)),
  CONSTRAINT dead_letters__msg__ck CHECK (char_length(last_error_message_redacted) <= 2000),
  CONSTRAINT dead_letters__resolution_note__ck CHECK (char_length(resolution_note) BETWEEN 1 AND 500),  -- 08 A8.4
  CONSTRAINT dead_letters__job_key__ck CHECK (char_length(job_key) BETWEEN 1 AND 400)                 -- [CONV] (08 A23.2)
);
CREATE INDEX dead_letters__state_dead_at__idx ON core.dead_letters (state, dead_at);                  -- IC §12
CREATE INDEX dead_letters__tenant_id_state_dead_at__idx ON core.dead_letters (tenant_id, state, dead_at);

CREATE TABLE core.idempotency_keys (
  tenant_id uuid,                                                    -- NULL only for platform-context operations (08 A25 D-213)
  actor_id uuid NOT NULL, key text NOT NULL,
  method text NOT NULL, route text NOT NULL, request_sha256 bytea NOT NULL,
  state text NOT NULL, response_status integer, response_body jsonb,
  created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
  CONSTRAINT idempotency_keys__tenant_id_actor_id_key__uq UNIQUE NULLS NOT DISTINCT (tenant_id, actor_id, key),   -- replaces the PK (D-213)
  CONSTRAINT idempotency_keys__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT idempotency_keys__key__ck CHECK (key ~ '^[A-Za-z0-9_-]{1,64}$'),
  CONSTRAINT idempotency_keys__sha__ck CHECK (octet_length(request_sha256) = 32),   -- 02-CV §3 hash-column rule (08 R24)
  CONSTRAINT idempotency_keys__state__ck CHECK (state IN ('in_progress','completed')),
  CONSTRAINT idempotency_keys__completed__ck CHECK ((state = 'completed') = (response_status IS NOT NULL))
);
CREATE INDEX idempotency_keys__expires_at__idx ON core.idempotency_keys (expires_at);                -- IC §12

CREATE UNLOGGED TABLE core.rate_limit_counters (
  key_hash text NOT NULL, window_start timestamptz NOT NULL, hits integer NOT NULL DEFAULT 0,
  CONSTRAINT rate_limit_counters__pk PRIMARY KEY (key_hash, window_start)
);                                                                     -- RLS-exempt (rls_exempt.txt: "hashed non-tenant counters, no grants")

-- class G registries (§3.5; RLS-exempt, db/tests/rls_exempt.txt). Read-only to lims_app; enqueue_job reads the registry as lims_queue.
CREATE TABLE core.g_task_registry (
  identifier text NOT NULL, module text NOT NULL, kind text NOT NULL, scope text NOT NULL,
  max_attempts integer NOT NULL, is_active boolean NOT NULL DEFAULT true,
  registered_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT g_task_registry__pk PRIMARY KEY (identifier),
  CONSTRAINT g_task_registry__kind__ck CHECK (kind IN ('task','consumer','core')),
  CONSTRAINT g_task_registry__scope__ck CHECK (scope IN ('per_tenant','platform')),
  CONSTRAINT g_task_registry__max_attempts__ck CHECK (max_attempts >= 1)                                  -- [CONV]
);
CREATE TABLE core.g_system_actors (
  module text NOT NULL, actor_id uuid NOT NULL UNIQUE,                                                    -- fixed UUIDv7 (db/meta/system-actors.yaml)
  is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT g_system_actors__pk PRIMARY KEY (module)
);
GRANT SELECT ON core.g_task_registry TO lims_queue;
GRANT SELECT ON core.g_system_actors, core.g_task_registry TO lims_app;

CREATE FUNCTION app.tg_dead_letter_transition() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF (to_jsonb(OLD) - ARRAY['state','resolved_by','resolved_at','resolution_note','version'])
     IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['state','resolved_by','resolved_at','resolution_note','version'])   -- version: 08 A3.4 If-Match bump; resolution_note: 08 A8.4
     OR NOT (OLD.state = 'open' AND NEW.state IN ('replayed','discarded')) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'immutable_row', DETAIL = 'core.dead_letters';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER dead_letters__transition BEFORE UPDATE ON core.dead_letters
  FOR EACH ROW EXECUTE FUNCTION app.tg_dead_letter_transition();

-- core.event_log (class A; shared_with: [partner, portal, patient] — INSERT of own rows only, no non-staff SELECT; 08 A23.3).
-- The table has no actor_id column: created_by is the publishing actor and is what the actor policies bind [CONV].
ALTER TABLE core.event_log ENABLE ROW LEVEL SECURITY;  ALTER TABLE core.event_log FORCE ROW LEVEL SECURITY;
CREATE POLICY event_log__select__tenant ON core.event_log FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY event_log__insert__tenant ON core.event_log FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY event_log__insert__partner ON core.event_log FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND created_by = (SELECT app.current_actor_id())
              AND (SELECT app.current_actor_type()) = 'partner');
CREATE POLICY event_log__insert__portal ON core.event_log FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND created_by = (SELECT app.current_actor_id())
              AND (SELECT app.current_actor_type()) = 'portal');
CREATE POLICY event_log__insert__patient ON core.event_log FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND created_by = (SELECT app.current_actor_id())
              AND (SELECT app.current_actor_type()) = 'patient');
GRANT SELECT, INSERT ON core.event_log TO lims_app;
-- (event_log__{select,delete}__owner_only: with the purges above)

-- core.dead_letters tenant rows (written by the worker wrapper under the job's tenant claims, system actor). The owner_only and
-- __platform policies are with the app.dl_* functions above.
ALTER TABLE core.dead_letters ENABLE ROW LEVEL SECURITY;  ALTER TABLE core.dead_letters FORCE ROW LEVEL SECURITY;
CREATE POLICY dead_letters__select__tenant ON core.dead_letters FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY dead_letters__insert__tenant ON core.dead_letters FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY dead_letters__update__tenant ON core.dead_letters FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
GRANT SELECT, INSERT, UPDATE ON core.dead_letters TO lims_app;

-- core.idempotency_keys (class E; shared_with: [partner, portal, patient] — own actor_id rows only, 08 A23.3; NULL-tenant
-- platform rows through __platform, 08 A25 D-213). DELETE (release of the actor's own in_progress key, 02-TRD §6.6 step 5 / D-202)
-- exists for every path that may INSERT [CONV].
ALTER TABLE core.idempotency_keys ENABLE ROW LEVEL SECURITY;  ALTER TABLE core.idempotency_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY idempotency_keys__select__tenant ON core.idempotency_keys FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND actor_id = (SELECT app.current_actor_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY idempotency_keys__insert__tenant ON core.idempotency_keys FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND actor_id = (SELECT app.current_actor_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY idempotency_keys__update__tenant ON core.idempotency_keys FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND actor_id = (SELECT app.current_actor_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND actor_id = (SELECT app.current_actor_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY idempotency_keys__delete__tenant ON core.idempotency_keys FOR DELETE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND actor_id = (SELECT app.current_actor_id()) AND (SELECT app.is_staff_or_system())
         AND state = 'in_progress');
-- actor-specific (08 A23.3): four statements per actor type partner, portal, patient
CREATE POLICY idempotency_keys__select__partner ON core.idempotency_keys FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND actor_id = (SELECT app.current_actor_id()) AND (SELECT app.current_actor_type()) = 'partner');
CREATE POLICY idempotency_keys__insert__partner ON core.idempotency_keys FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND actor_id = (SELECT app.current_actor_id()) AND (SELECT app.current_actor_type()) = 'partner');
CREATE POLICY idempotency_keys__update__partner ON core.idempotency_keys FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND actor_id = (SELECT app.current_actor_id()) AND (SELECT app.current_actor_type()) = 'partner')
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND actor_id = (SELECT app.current_actor_id()) AND (SELECT app.current_actor_type()) = 'partner');
CREATE POLICY idempotency_keys__delete__partner ON core.idempotency_keys FOR DELETE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND actor_id = (SELECT app.current_actor_id()) AND (SELECT app.current_actor_type()) = 'partner'
         AND state = 'in_progress');
CREATE POLICY idempotency_keys__select__portal ON core.idempotency_keys FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND actor_id = (SELECT app.current_actor_id()) AND (SELECT app.current_actor_type()) = 'portal');
CREATE POLICY idempotency_keys__insert__portal ON core.idempotency_keys FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND actor_id = (SELECT app.current_actor_id()) AND (SELECT app.current_actor_type()) = 'portal');
CREATE POLICY idempotency_keys__update__portal ON core.idempotency_keys FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND actor_id = (SELECT app.current_actor_id()) AND (SELECT app.current_actor_type()) = 'portal')
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND actor_id = (SELECT app.current_actor_id()) AND (SELECT app.current_actor_type()) = 'portal');
CREATE POLICY idempotency_keys__delete__portal ON core.idempotency_keys FOR DELETE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND actor_id = (SELECT app.current_actor_id()) AND (SELECT app.current_actor_type()) = 'portal'
         AND state = 'in_progress');
CREATE POLICY idempotency_keys__select__patient ON core.idempotency_keys FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND actor_id = (SELECT app.current_actor_id()) AND (SELECT app.current_actor_type()) = 'patient');
CREATE POLICY idempotency_keys__insert__patient ON core.idempotency_keys FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND actor_id = (SELECT app.current_actor_id()) AND (SELECT app.current_actor_type()) = 'patient');
CREATE POLICY idempotency_keys__update__patient ON core.idempotency_keys FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND actor_id = (SELECT app.current_actor_id()) AND (SELECT app.current_actor_type()) = 'patient')
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND actor_id = (SELECT app.current_actor_id()) AND (SELECT app.current_actor_type()) = 'patient');
CREATE POLICY idempotency_keys__delete__patient ON core.idempotency_keys FOR DELETE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND actor_id = (SELECT app.current_actor_id()) AND (SELECT app.current_actor_type()) = 'patient'
         AND state = 'in_progress');
-- platform-context operations (provisionTenant, openSupportSession, invitePlatformStaff; 08 A25 D-213)
CREATE POLICY idempotency_keys__select__platform ON core.idempotency_keys FOR SELECT TO lims_app
  USING (tenant_id IS NULL AND actor_id = (SELECT app.current_actor_id()) AND (SELECT app.is_platform_actor()));
CREATE POLICY idempotency_keys__insert__platform ON core.idempotency_keys FOR INSERT TO lims_app
  WITH CHECK (tenant_id IS NULL AND actor_id = (SELECT app.current_actor_id()) AND (SELECT app.is_platform_actor()));
CREATE POLICY idempotency_keys__update__platform ON core.idempotency_keys FOR UPDATE TO lims_app
  USING (tenant_id IS NULL AND actor_id = (SELECT app.current_actor_id()) AND (SELECT app.is_platform_actor()))
  WITH CHECK (tenant_id IS NULL AND actor_id = (SELECT app.current_actor_id()) AND (SELECT app.is_platform_actor()));
CREATE POLICY idempotency_keys__delete__platform ON core.idempotency_keys FOR DELETE TO lims_app
  USING (tenant_id IS NULL AND actor_id = (SELECT app.current_actor_id()) AND (SELECT app.is_platform_actor()) AND state = 'in_progress');
CREATE POLICY idempotency_keys__delete__owner_only ON core.idempotency_keys FOR DELETE TO lims_owner
  USING (current_setting('app.maintenance', true) = 'purge_idempotency_keys' AND expires_at < now());   -- 08 A15.3
CREATE POLICY idempotency_keys__select__owner_only ON core.idempotency_keys FOR SELECT TO lims_owner
  USING (current_setting('app.maintenance', true) = 'purge_idempotency_keys' AND expires_at < now());   -- app.purge_idempotency_keys() DELETE … WHERE (08 A10.5, A15.3)
GRANT SELECT, INSERT, UPDATE, DELETE ON core.idempotency_keys TO lims_app;

-- ===================================================================== rate limit fallback (04 S11)
CREATE FUNCTION app.ratelimit_hit(p_key_hash text, p_window_seconds int, p_limit int,
                                  OUT allowed boolean, OUT retry_after_seconds int)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_now  timestamptz := clock_timestamp();
  v_cur  timestamptz := to_timestamp(floor(extract(epoch FROM v_now) / p_window_seconds) * p_window_seconds);
  v_prev timestamptz := v_cur - make_interval(secs => p_window_seconds);
  v_elapsed double precision := extract(epoch FROM v_now - v_cur);
  v_cur_hits int; v_prev_hits int; v_estimate double precision;
BEGIN
  INSERT INTO core.rate_limit_counters AS c (key_hash, window_start, hits) VALUES (p_key_hash, v_cur, 1)
  ON CONFLICT (key_hash, window_start) DO UPDATE SET hits = c.hits + 1 RETURNING c.hits INTO v_cur_hits;
  SELECT coalesce(max(hits), 0) INTO v_prev_hits FROM core.rate_limit_counters
   WHERE key_hash = p_key_hash AND window_start = v_prev;
  v_estimate := v_prev_hits * (1 - v_elapsed / p_window_seconds) + v_cur_hits;   -- sliding-window approximation (REQ-SEC-079)
  allowed := v_estimate <= p_limit;
  retry_after_seconds := CASE WHEN allowed THEN 0 ELSE greatest(1, ceil(p_window_seconds - v_elapsed)::int) END;
END $$;
GRANT EXECUTE ON FUNCTION app.ratelimit_hit(text, int, int) TO lims_api, lims_worker;

-- ===================================================================== retention purges (CV §5.11) — batched
-- Cross-tenant maintenance (08 A12.2, A15.3; §4.3 GUC rule): each purge that touches a FORCE-RLS table sets
-- set_config('app.maintenance', '<function name>', true) first and resets it to '' before returning; its owner policies are
-- gated on that value, so they admit nothing outside the function (a lims_app session setting the GUC gains nothing: TO lims_owner).
-- 08 A25 D-200: core.retention_purge calls each function in its own transaction with statement_timeout = 300000 (taskOptions,
-- 02-TRD §7.6); each loop stops after 4 minutes (under the 300 s ceiling) and reports capped = true, so the metric
-- lims_core_retention_purge_capped_total{table} counts it and the next daily run continues where this one stopped.
-- OUT (deleted, capped) [CONV: the capped flag is what the D-200 metric needs]. Batches of 10,000 rows [CONV].
CREATE FUNCTION app.purge_event_log(OUT deleted bigint, OUT capped boolean)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_n int;
BEGIN
  deleted := 0; capped := false;
  PERFORM set_config('app.maintenance', 'purge_event_log', true);   -- admits event_log__{select,delete}__owner_only (08 A15.3)
  LOOP
    DELETE FROM core.event_log e WHERE (e.tenant_id, e.event_id) IN (
      SELECT x.tenant_id, x.event_id FROM core.event_log x WHERE x.created_at < now() - interval '90 days' LIMIT 10000);
    GET DIAGNOSTICS v_n = ROW_COUNT; deleted := deleted + v_n;
    EXIT WHEN v_n = 0;
    IF clock_timestamp() - now() > interval '4 minutes' THEN capped := true; EXIT; END IF;   -- D-200
  END LOOP;
  PERFORM set_config('app.maintenance', '', true);
END $$;
CREATE FUNCTION app.purge_event_inboxes(OUT deleted bigint, OUT capped boolean)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_s text; v_n int;
BEGIN
  deleted := 0; capped := false;
  PERFORM set_config('app.maintenance', 'purge_event_inboxes', true);   -- admits event_inbox__{select,delete}__owner_only
  FOREACH v_s IN ARRAY ARRAY['identity','frontdesk','billing','lab','instruments','reporting','analytics','quality',
                             'micro','anatomic','inventory','partners','smartreport','payments','engagement','homecollection'] LOOP   -- §3.9 (08 A31.4)
    LOOP
      EXECUTE format('DELETE FROM %I.event_inbox e WHERE (e.tenant_id, e.event_id) IN ('
                  || 'SELECT x.tenant_id, x.event_id FROM %I.event_inbox x WHERE x.received_at < now() - interval ''90 days'' LIMIT 10000)',
                     v_s, v_s);                                      -- fixed list + %I (REQ-SEC-082)
      GET DIAGNOSTICS v_n = ROW_COUNT; deleted := deleted + v_n;
      EXIT WHEN v_n = 0;
      IF clock_timestamp() - now() > interval '4 minutes' THEN capped := true; EXIT; END IF;
    END LOOP;
    EXIT WHEN capped;
  END LOOP;
  PERFORM set_config('app.maintenance', '', true);
END $$;
-- core.idempotency_keys has NULL-tenant rows (D-213): a row-value IN over (tenant_id, …) never matches NULL, so the batch is
-- addressed by ctid within the same statement.
CREATE FUNCTION app.purge_idempotency_keys(OUT deleted bigint, OUT capped boolean)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_n int;
BEGIN
  deleted := 0; capped := false;
  PERFORM set_config('app.maintenance', 'purge_idempotency_keys', true);
  LOOP
    DELETE FROM core.idempotency_keys k WHERE k.ctid = ANY (ARRAY(
      SELECT x.ctid FROM core.idempotency_keys x WHERE x.expires_at < now() LIMIT 10000));
    GET DIAGNOSTICS v_n = ROW_COUNT; deleted := deleted + v_n;
    EXIT WHEN v_n = 0;
    IF clock_timestamp() - now() > interval '4 minutes' THEN capped := true; EXIT; END IF;
  END LOOP;
  PERFORM set_config('app.maintenance', '', true);
END $$;
CREATE FUNCTION app.purge_dead_letters(OUT deleted bigint, OUT capped boolean)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_n int;
BEGIN
  deleted := 0; capped := false;
  PERFORM set_config('app.maintenance', 'purge_dead_letters', true);
  LOOP
    DELETE FROM core.dead_letters d WHERE d.id IN (
      SELECT x.id FROM core.dead_letters x
       WHERE x.state <> 'open' AND x.resolved_at < now() - interval '90 days' LIMIT 10000);
    GET DIAGNOSTICS v_n = ROW_COUNT; deleted := deleted + v_n;
    EXIT WHEN v_n = 0;
    IF clock_timestamp() - now() > interval '4 minutes' THEN capped := true; EXIT; END IF;
  END LOOP;
  PERFORM set_config('app.maintenance', '', true);
END $$;
-- core.rate_limit_counters is RLS-exempt (§3.5): no owner policy, no app.maintenance.
CREATE FUNCTION app.purge_ratelimit_counters(OUT deleted bigint, OUT capped boolean)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_n int;
BEGIN
  deleted := 0; capped := false;
  LOOP
    DELETE FROM core.rate_limit_counters c WHERE (c.key_hash, c.window_start) IN (
      SELECT x.key_hash, x.window_start FROM core.rate_limit_counters x
       WHERE x.window_start < now() - interval '48 hours' LIMIT 10000);
    GET DIAGNOSTICS v_n = ROW_COUNT; deleted := deleted + v_n;
    EXIT WHEN v_n = 0;
    IF clock_timestamp() - now() > interval '4 minutes' THEN capped := true; EXIT; END IF;
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION app.purge_event_log(), app.purge_event_inboxes(), app.purge_idempotency_keys(), app.purge_dead_letters(),
  app.purge_ratelimit_counters() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.purge_event_log(), app.purge_event_inboxes(), app.purge_idempotency_keys(), app.purge_dead_letters(),
  app.purge_ratelimit_counters() TO lims_worker;
-- Owner policies the purges need under FORCE RLS (08 A10.5; §4.3 owner-policy rule): a DELETE … WHERE (and the batching
-- subquery) reads the row, so lims_owner needs a SELECT policy with the same expiry predicate as the DELETE policy (§6).
-- Both are gated on app.maintenance = the purge's name (08 A15.3): no static owner policy for maintenance remains.
CREATE POLICY event_log__select__owner_only ON core.event_log FOR SELECT TO lims_owner
  USING (current_setting('app.maintenance', true) = 'purge_event_log' AND created_at < now() - interval '90 days');
CREATE POLICY event_log__delete__owner_only ON core.event_log FOR DELETE TO lims_owner
  USING (current_setting('app.maintenance', true) = 'purge_event_log' AND created_at < now() - interval '90 days');
-- core.idempotency_keys: idempotency_keys__{select,delete}__owner_only (gated on 'purge_idempotency_keys') are with the table's policies below.
-- (The other 16 inbox schemas of §3.9 get the same two policies, generated with their inbox.)
-- core.dead_letters: the purge predicate (gated on 'purge_dead_letters') is part of dead_letters__select__owner_only /
-- __delete__owner_only (platform dead letters block).

-- ===================================================================== platform dead letters (tenant_id IS NULL; IC §12; §4.3; 08 A9.4)
-- Owner lims_owner (file role). FORCE RLS applies to the owner, so these functions see only rows admitted by the
-- owner_only policies below (§6: tenant_id IS NULL). app.dl_list_platform never returns job_payload (08 A8.5, A9.4);
-- app.dl_resolve returns it for a replay to the C0 core service only, which strips it before building DeadLetterRow (08 A10.1).
-- The tenant-row path (ctx.core.deadLetters under platform claims, __platform policies) applies the same guard and transition.
-- (ENABLE + FORCE RLS on core.dead_letters comes from the RLS template below, as for every C0 table.)
-- SELECT owner_only also admits the purge predicate of app.purge_dead_letters(): its DELETE … WHERE reads the row, which
-- under FORCE RLS needs a SELECT policy for lims_owner (08 A10.5; §4.3 owner-policy rule). One SELECT owner_only policy per table.
CREATE POLICY dead_letters__select__owner_only ON core.dead_letters FOR SELECT TO lims_owner
  USING (tenant_id IS NULL                                                                  -- app.dl_* (platform rows)
      OR (current_setting('app.maintenance', true) = 'purge_dead_letters'                   -- app.purge_dead_letters() (08 A15.3)
          AND state <> 'open' AND resolved_at < now() - interval '90 days'));
CREATE POLICY dead_letters__delete__owner_only ON core.dead_letters FOR DELETE TO lims_owner
  USING (current_setting('app.maintenance', true) = 'purge_dead_letters'
         AND state <> 'open' AND resolved_at < now() - interval '90 days');                 -- app.purge_dead_letters() (§6; 08 A15.3)
CREATE POLICY dead_letters__insert__owner_only ON core.dead_letters FOR INSERT TO lims_owner WITH CHECK (tenant_id IS NULL);
CREATE POLICY dead_letters__update__owner_only ON core.dead_letters FOR UPDATE TO lims_owner
  USING (tenant_id IS NULL) WITH CHECK (tenant_id IS NULL);
-- __platform policies (C2 05-SCHEMA §5.3, §10.2; written here by C0, used by ctx.core.deadLetters under platform claims, 08 A8.6).
-- Tenant rows only: NULL-tenant rows are reachable only through the app.dl_* DEFINERs (08 A10.4).
CREATE POLICY dead_letters__select__platform ON core.dead_letters FOR SELECT TO lims_app
  USING (tenant_id IS NOT NULL AND (SELECT app.is_platform_actor()));
CREATE POLICY dead_letters__update__platform ON core.dead_letters FOR UPDATE TO lims_app
  USING (tenant_id IS NOT NULL AND (SELECT app.is_platform_actor()))
  WITH CHECK (tenant_id IS NOT NULL AND (SELECT app.is_platform_actor()));

-- Worker dead-letter wrapper, tenantScope 'platform' tasks only (02-TRD §7.4). Id = UUIDv7 from app code (04 D9).
CREATE FUNCTION app.dl_insert_platform(p_id uuid, p_task_identifier text, p_job_payload jsonb,
                                       p_last_error_code text, p_last_error_message_redacted text,
                                       p_attempts integer, p_first_failed_at timestamptz,
                                       p_job_key text DEFAULT NULL)       -- 08 A23.2: helpers.job.key of the failed job
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_scope text;
BEGIN
  SELECT r.scope INTO v_scope FROM core.g_task_registry r WHERE r.identifier = p_task_identifier;   -- registry rows are never deleted (02-TRD §7.7)
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'unknown_task_identifier';
  END IF;
  IF v_scope <> 'platform' THEN                                  -- tenant_id is NULL only for platform tasks (IC §12)
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'job_tenant_mismatch';
  END IF;
  INSERT INTO core.dead_letters (id, tenant_id, task_identifier, job_payload, last_error_code, last_error_message_redacted,
                                 attempts, first_failed_at, dead_at, state, job_key, created_by)
  VALUES (p_id, NULL, p_task_identifier, p_job_payload, p_last_error_code, p_last_error_message_redacted,
          p_attempts, p_first_failed_at, now(), 'open', p_job_key, app.current_actor_id());   -- created_by = core system actor claims (NOT NULL)
END $$;

-- ctx.core.deadLetters.list({ platformRows: true, state?, taskIdentifier?, deadAtFrom?, deadAtTo?, cursor?, limit? }) (08 A9.2)
-- and ctx.core.deadLetters.get({ deadLetterId }) for a platform row (p_dead_letter_id; 0 rows → common.not_found, 08 A9.1).
-- Keyset: core decodes the cursor (02-CV §4.3) into (p_after_dead_at, p_after_id) and passes p_limit = limit + 1 to detect next_cursor.
-- Order dead_at DESC, id DESC [CONV]; served by dead_letters__state_dead_at__idx; task_identifier filtered in-page [CONV] (08 A9.2).
-- Confirmed by 08 A10.3: get via the optional p_dead_letter_id, sort dead_at DESC, id DESC [CONV].
CREATE FUNCTION app.dl_list_platform(p_state text DEFAULT NULL, p_task_identifier text DEFAULT NULL,
                                     p_dead_at_from timestamptz DEFAULT NULL, p_dead_at_to timestamptz DEFAULT NULL,
                                     p_after_dead_at timestamptz DEFAULT NULL, p_after_id uuid DEFAULT NULL,
                                     p_limit integer DEFAULT 51, p_dead_letter_id uuid DEFAULT NULL)
RETURNS TABLE (id uuid, tenant_id uuid, task_identifier text, last_error_code text, last_error_message_redacted text,
               attempts integer, first_failed_at timestamptz, dead_at timestamptz, state text,
               resolved_by uuid, resolved_at timestamptz, resolution_note text, version integer)   -- = DeadLetterRow (02-TRD §6.8); no job_payload
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT d.id, d.tenant_id, d.task_identifier, d.last_error_code, d.last_error_message_redacted,
         d.attempts, d.first_failed_at, d.dead_at, d.state,
         d.resolved_by, d.resolved_at, d.resolution_note, d.version
  FROM core.dead_letters d
  WHERE d.tenant_id IS NULL
    AND (SELECT app.is_platform_actor())                         -- platform context only (08 §4.7); fail-closed: no rows otherwise
    AND (p_dead_letter_id IS NULL OR d.id = p_dead_letter_id)
    AND (p_state IS NULL OR d.state = p_state)
    AND (p_task_identifier IS NULL OR d.task_identifier = p_task_identifier)
    AND (p_dead_at_from IS NULL OR d.dead_at >= p_dead_at_from)  -- inclusive (02-CV §4.4)
    AND (p_dead_at_to IS NULL OR d.dead_at < p_dead_at_to)       -- exclusive (02-CV §4.4)
    AND (p_after_dead_at IS NULL OR (d.dead_at, d.id) < (p_after_dead_at, p_after_id))
  ORDER BY d.dead_at DESC, d.id DESC
  LIMIT least(greatest(coalesce(p_limit, 51), 1), 201)           -- 02-CV §4.3: limit ≤ 200, + 1 look-ahead row
$$;

-- ctx.core.deadLetters.replay / discard for a platform row (08 A6.4, A8.4, A9.3, A9.4).
-- p_state 'replayed' (p_resolution_note optional) or 'discarded' (p_resolution_note required); length 1–500 by dead_letters__resolution_note__ck.
-- Version guard: the UPDATE matches only an open row with version = p_expected_version. 0 rows returned → C0 core throws
-- LimsError('common.version_conflict') (409, 08 A6.4) and enqueues nothing; 1 row → the updated DeadLetterRow (version + 1).
-- app.tg_dead_letter_transition() still enforces the allowed-change list and open → replayed | discarded.
-- Replay payload (08 A10.1): for p_state = 'replayed' the result also carries job_payload (NULL for 'discarded'). Only the C0
-- core service (services/api/src/core/core-repo, 02-TRD §6.8/§7.4) calls this function; it strips job_payload before building
-- DeadLetterRow and re-enqueues it through app.enqueue_job in the same transaction. No HTTP response or log contains it (08 A8.5).
-- Defensive message dl_resolve_invalid_input confirmed by 08 A10.3.
CREATE FUNCTION app.dl_resolve(p_dead_letter_id uuid, p_expected_version integer, p_state text,
                               p_resolution_note text DEFAULT NULL)
RETURNS TABLE (id uuid, tenant_id uuid, task_identifier text, last_error_code text, last_error_message_redacted text,
               attempts integer, first_failed_at timestamptz, dead_at timestamptz, state text,
               resolved_by uuid, resolved_at timestamptz, resolution_note text, version integer,   -- = DeadLetterRow
               job_payload jsonb,                                 -- core-only, replay only (08 A10.1); never in DeadLetterRow
               job_key text)                                      -- core-only: replay job_key source (08 A23.2); never in DeadLetterRow
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
BEGIN
  IF p_state IS NULL OR p_state NOT IN ('replayed','discarded')
     OR (p_state = 'discarded' AND p_resolution_note IS NULL) THEN   -- discard requires a reason (08 A8.4)
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'dl_resolve_invalid_input';   -- 08 A10.3
  END IF;
  RETURN QUERY
  UPDATE core.dead_letters d
     SET state           = p_state,
         resolved_by     = app.current_actor_id(),               -- platform staff user (claims sub)
         resolved_at     = now(),
         resolution_note = p_resolution_note,
         version         = d.version + 1
   WHERE d.id = p_dead_letter_id
     AND d.tenant_id IS NULL
     AND d.state = 'open'
     AND d.version = p_expected_version
     AND (SELECT app.is_platform_actor())                        -- platform context only (08 §4.7)
  RETURNING d.id, d.tenant_id, d.task_identifier, d.last_error_code, d.last_error_message_redacted,
            d.attempts, d.first_failed_at, d.dead_at, d.state,
            d.resolved_by, d.resolved_at, d.resolution_note, d.version,
            CASE WHEN p_state = 'replayed' THEN d.job_payload END,   -- 08 A10.1
            d.job_key;                                              -- replay key = coalesce(job_key, task_identifier||':'||id)||':replay:'||version (08 A23.2)
END $$;

REVOKE ALL ON FUNCTION app.dl_insert_platform(uuid, text, jsonb, text, text, integer, timestamptz, text),
  app.dl_list_platform(text, text, timestamptz, timestamptz, timestamptz, uuid, integer, uuid),
  app.dl_resolve(uuid, integer, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.dl_insert_platform(uuid, text, jsonb, text, text, integer, timestamptz, text) TO lims_worker;
GRANT EXECUTE ON FUNCTION app.dl_list_platform(text, text, timestamptz, timestamptz, timestamptz, uuid, integer, uuid),
  app.dl_resolve(uuid, integer, text, text) TO lims_api;

-- ===================================================================== platform tenant list (CR-C0-004; 08 A12.3)
-- C2 listTenants (GET /platform/tenants: filter status; sort code | -created_at; C2 02-TRD §5.10). Keyset as app.dl_list_platform:
-- the caller decodes the cursor (02-CV §4.3) into the last row's sort key (p_after_tenant_code for 'code'; p_after_created_at +
-- p_after_id for '-created_at') and passes p_limit = limit + 1 to detect next_cursor. Platform context only: no row unless
-- (SELECT app.is_platform_actor()). Reads core.tenants through tenants__select__owner_only (app.maintenance branch), which it sets
-- with set_config(…, true) and resets to '' before returning (§4.3 GUC rule). Output columns [CONV]: the tenant's identifying,
-- status and lifecycle columns; status_reason (free text typed by platform staff) and created_by / updated_by (staff user ids)
-- are not returned, so the list carries no free text and no person identifiers ("non-PHI tenant columns only", 08 A12.3).
-- p_sort outside ('code','-created_at') raises platform_list_tenants_invalid_input [CONV] (same pattern as dl_resolve_invalid_input;
-- the C2 handler validates sort first, so this is defensive).
CREATE FUNCTION app.platform_list_tenants(p_sort text, p_status text DEFAULT NULL, p_after_tenant_code text DEFAULT NULL,
                                          p_after_created_at timestamptz DEFAULT NULL, p_after_id uuid DEFAULT NULL,
                                          p_limit integer DEFAULT 51)
RETURNS TABLE (id uuid, tenant_code text, legal_name text, display_name text, status text, timezone text,
               activated_at timestamptz, suspended_at timestamptz, offboarded_at timestamptz, billing_live_on date,
               is_active boolean, version integer, created_at timestamptz, updated_at timestamptz)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
BEGIN
  IF p_sort IS NULL OR p_sort NOT IN ('code','-created_at') THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'platform_list_tenants_invalid_input';
  END IF;
  IF NOT coalesce((SELECT app.is_platform_actor()), false) THEN
    RETURN;                                                       -- platform context only (08 §4.7, A12.3); fail-closed: no rows
  END IF;
  PERFORM set_config('app.maintenance', 'platform_list_tenants', true);
  IF p_sort = 'code' THEN
    RETURN QUERY
    SELECT t.id, t.tenant_code, t.legal_name, t.display_name, t.status, t.timezone,
           t.activated_at, t.suspended_at, t.offboarded_at, t.billing_live_on, t.is_active, t.version, t.created_at, t.updated_at
    FROM core.tenants t
    WHERE (p_status IS NULL OR t.status = p_status)
      AND (p_after_tenant_code IS NULL OR t.tenant_code > p_after_tenant_code)   -- tenants__tenant_code__uq (unique, global)
    ORDER BY t.tenant_code
    LIMIT least(greatest(coalesce(p_limit, 51), 1), 201);         -- 02-CV §4.3: limit ≤ 200, + 1 look-ahead row
  ELSE
    RETURN QUERY
    SELECT t.id, t.tenant_code, t.legal_name, t.display_name, t.status, t.timezone,
           t.activated_at, t.suspended_at, t.offboarded_at, t.billing_live_on, t.is_active, t.version, t.created_at, t.updated_at
    FROM core.tenants t
    WHERE (p_status IS NULL OR t.status = p_status)
      AND (p_after_created_at IS NULL OR (t.created_at, t.id) < (p_after_created_at, p_after_id))
    ORDER BY t.created_at DESC, t.id DESC
    LIMIT least(greatest(coalesce(p_limit, 51), 1), 201);
  END IF;
  PERFORM set_config('app.maintenance', '', true);
  RETURN;
END $$;
REVOKE ALL ON FUNCTION app.platform_list_tenants(text, text, text, timestamptz, uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.platform_list_tenants(text, text, text, timestamptz, uuid, integer) TO lims_api;

-- ===================================================================== per-tenant cron fan-out (08 A13 P-6, A23.1)
-- The worker core calls this at each tick of a tenantScope 'per_tenant' crontab entry (claims of the core system actor, no tenant),
-- then, per returned id, opens withTenantScope(tenantId, <owning module's system actor>) and calls
-- app.enqueue_job(<identifier>, {tenant_id}, '<identifier>:<tenant_id>:<tick ISO minute>') (02-TRD §7.2). Reads core.tenants
-- through tenants__select__owner_only (app.maintenance = 'cron_tenant_ids' branch).
CREATE FUNCTION app.cron_tenant_ids() RETURNS SETOF uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM set_config('app.maintenance', 'cron_tenant_ids', true);
  RETURN QUERY SELECT t.id FROM core.tenants t WHERE t.status IN ('active','suspended') ORDER BY t.id;   -- [CONV] P-6
  PERFORM set_config('app.maintenance', '', true);
  RETURN;
END $$;
REVOKE ALL ON FUNCTION app.cron_tenant_ids() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.cron_tenant_ids() TO lims_worker;

-- ===================================================================== tenant-code resolver (08 A19 D-121; replaces app.engagement_resolve_tenant_code)
-- Pre-tenant lookup (A12.1 naming): sets app.pre_tenant_code inside the body, reads core.tenants through tenants__select__owner_only
-- (tenant_code branch), resets the GUC to '' before returning. The caller (C16; C18 D-134 deferred) filters status = 'active'.
CREATE FUNCTION app.core_resolve_tenant_code(p_code text) RETURNS TABLE (tenant_id uuid, status text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
BEGIN
  PERFORM set_config('app.pre_tenant_code', coalesce(p_code, ''), true);
  RETURN QUERY SELECT t.id, t.status FROM core.tenants t WHERE t.tenant_code = p_code;
  PERFORM set_config('app.pre_tenant_code', '', true);
  RETURN;
END $$;
REVOKE ALL ON FUNCTION app.core_resolve_tenant_code(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.core_resolve_tenant_code(text) TO lims_api;

-- ===================================================================== tenants targeted by a throttled IP (08 A25 D-217)
-- Requesting spec: C2 05-SCHEMA §10.3 (P-41). This text and C2's must be identical; a difference is a CR to C2 and C0 builds C2's.
-- Called only by the C2 worker task identity.notify_ip_throttle (platform scope). Reads core.users through users__select__owner_only
-- (app.maintenance = 'identity_tenants_for_email_hmacs' AND email_hmac IS NOT NULL). No HTTP response can observe the result.
CREATE FUNCTION app.identity_tenants_for_email_hmacs(p_hmacs bytea[]) RETURNS SETOF uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF coalesce(cardinality(p_hmacs), 0) > 100 THEN                    -- D-217: at most 100 values
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'identity_tenants_for_email_hmacs_invalid_input';   -- [CONV] (dl_resolve pattern)
  END IF;
  PERFORM set_config('app.maintenance', 'identity_tenants_for_email_hmacs', true);
  RETURN QUERY SELECT DISTINCT u.tenant_id FROM core.users u WHERE u.email_hmac = ANY (p_hmacs);
  PERFORM set_config('app.maintenance', '', true);
  RETURN;
END $$;
REVOKE ALL ON FUNCTION app.identity_tenants_for_email_hmacs(bytea[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.identity_tenants_for_email_hmacs(bytea[]) TO lims_worker;

