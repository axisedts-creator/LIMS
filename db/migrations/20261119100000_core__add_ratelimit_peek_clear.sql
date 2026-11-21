-- SEC-ABUSE-1 (LD-237 (1), amended by LD-410 = CR-C1-SEC-ABUSE-1; landed by C1 under the one-time LD-414 authorization):
-- the staff-login failure windows and per-IP counters move from process Maps into the limiter store, which needs a
-- non-consuming read and a per-key clear. Exactly LD-410 items 1-4, nothing else:
--   (1) core.rate_limit_counters.last_hit (nullable), set by app.ratelimit_hit on insert and update; its signature is unchanged.
--   (2) app.ratelimit_peek(p_key_hash, p_window_seconds, OUT hits, OUT last_hit): STABLE, never writes.
--   (3) app.ratelimit_clear(p_key_hash): deletes only the rows of that one key_hash.
--   (4) EXECUTE on (2) and (3) to lims_api only; owner lims_owner; both in db/meta/definer-inventory.yaml.
-- Additive: no table grant (the table stays reachable only through DEFINERs, 04 S11), no policy, no RLS change.
-- NOT RUN in the lane (no psql / docker): has to be applied against a migrated database.

SET LOCAL ROLE lims_owner;

ALTER TABLE core.rate_limit_counters ADD COLUMN last_hit timestamptz;

-- (1) same body as 20261105000900, plus last_hit = the hit time.
CREATE OR REPLACE FUNCTION app.ratelimit_hit(p_key_hash text, p_window_seconds int, p_limit int,
                                             OUT allowed boolean, OUT retry_after_seconds int)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_now  timestamptz := clock_timestamp();
  v_cur  timestamptz := to_timestamp(floor(extract(epoch FROM v_now) / p_window_seconds) * p_window_seconds);
  v_prev timestamptz := v_cur - make_interval(secs => p_window_seconds);
  v_elapsed double precision := extract(epoch FROM v_now - v_cur);
  v_cur_hits int; v_prev_hits int; v_estimate double precision;
BEGIN
  INSERT INTO core.rate_limit_counters AS c (key_hash, window_start, hits, last_hit) VALUES (p_key_hash, v_cur, 1, v_now)
  ON CONFLICT (key_hash, window_start) DO UPDATE SET hits = c.hits + 1, last_hit = v_now RETURNING c.hits INTO v_cur_hits;
  SELECT coalesce(max(hits), 0) INTO v_prev_hits FROM core.rate_limit_counters
   WHERE key_hash = p_key_hash AND window_start = v_prev;
  v_estimate := v_prev_hits * (1 - v_elapsed / p_window_seconds) + v_cur_hits;   -- sliding-window approximation (REQ-SEC-079)
  allowed := v_estimate <= p_limit;
  retry_after_seconds := CASE WHEN allowed THEN 0 ELSE greatest(1, ceil(p_window_seconds - v_elapsed)::int) END;
END $$;

-- (2) the same sliding-window estimate as ratelimit_hit, without the hit; rounded up (an over-count only restricts more).
-- p_window_seconds must be the window the key is hit with (same bucket alignment). last_hit = latest hit of the key, any window.
CREATE FUNCTION app.ratelimit_peek(p_key_hash text, p_window_seconds int, OUT hits int, OUT last_hit timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_now  timestamptz := clock_timestamp();
  v_cur  timestamptz := to_timestamp(floor(extract(epoch FROM v_now) / p_window_seconds) * p_window_seconds);
  v_prev timestamptz := v_cur - make_interval(secs => p_window_seconds);
  v_elapsed double precision := extract(epoch FROM v_now - v_cur);
  v_cur_hits int; v_prev_hits int;
BEGIN
  SELECT coalesce(max(c.hits) FILTER (WHERE c.window_start = v_cur), 0),
         coalesce(max(c.hits) FILTER (WHERE c.window_start = v_prev), 0),
         max(c.last_hit)
    INTO v_cur_hits, v_prev_hits, last_hit
    FROM core.rate_limit_counters c WHERE c.key_hash = p_key_hash;
  hits := ceil(v_prev_hits * (1 - v_elapsed / p_window_seconds) + v_cur_hits)::int;
END $$;
REVOKE ALL ON FUNCTION app.ratelimit_peek(text, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.ratelimit_peek(text, int) TO lims_api;

-- (3) one key only.
CREATE FUNCTION app.ratelimit_clear(p_key_hash text) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  DELETE FROM core.rate_limit_counters c WHERE c.key_hash = p_key_hash;
END $$;
REVOKE ALL ON FUNCTION app.ratelimit_clear(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.ratelimit_clear(text) TO lims_api;
