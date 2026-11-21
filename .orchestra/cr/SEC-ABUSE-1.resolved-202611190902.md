Title: CR-C1-SEC-ABUSE-1: non-consuming read and reset for the Postgres rate limiter (move staff-login failure windows out of process Maps)
From chunk: C1            To owner: C0-0B
Type: schema
Blocking? yes — SEC-ABUSE-1 part (1) of LD-237 (loginStaff.ts failure/IP state, audit 6.1). Parts (2) login tier on changeOwnPassword + confirmEmailToken, (3) `i:` IP bucket on general, (4) web client-IP helper are not blocked.
Problem (what you cannot do today, with the user story / acceptance criterion it serves): LD-237 requires the per-account failure window (count in 60 min + time of the latest failure, cleared on success/reset) and per-IP state (10 failures in 10 min engages a 30 min throttle; 5 attempts / 60 s while throttled) to live in the limiter's login tier with unchanged semantics. The only primitive, app.ratelimit_hit(text,int,int) (C0 05-SCHEMA §4.3, 05-SCHEMA.md:1101-1119), always increments and returns only allowed/retry_after_seconds, using a sliding-window approximation; core.rate_limit_counters has no grants to any app role (05-SCHEMA.md:254). So the API cannot read a count without consuming it, cannot clear a key, and cannot learn the last-hit time. LD-237 also forbids a migration in SEC-ABUSE-1.
Proposed change (exact):
  ALTER TABLE core.rate_limit_counters ADD COLUMN last_hit timestamptz;   -- UNLOGGED, nullable; set to clock_timestamp() by app.ratelimit_hit on insert and on update
  CREATE FUNCTION app.ratelimit_peek(p_key_hash text, p_window_seconds int, OUT hits int, OUT last_hit timestamptz)
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''   -- exact sum of hits with window_start > now() - p_window_seconds; never writes
  CREATE FUNCTION app.ratelimit_clear(p_key_hash text) RETURNS void
    LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = ''   -- DELETE FROM core.rate_limit_counters WHERE key_hash = p_key_hash
  GRANT EXECUTE ON both TO lims_api only; owner lims_owner; add both to db/meta/definer-inventory.yaml.
  TS: RateLimitBackend gains peek(keyHash, windowS) / clear(keyHash); RateLimiter gains peek(tier, key) / clear(tier, key) with the same HMAC + prefix rules; fail closed on the login tier.
  Note: failure windows need exact per-event bucketing (e.g. 60 s window_start buckets summed over 60 min) for "older than 60 minutes no longer count"; C0-0B to choose the bucket size.
Backward compatible? yes (additive column + two new functions; ratelimit_hit signature unchanged).
Tenant/security impact: no RLS change (table stays RLS-exempt), no PHI, no public surface; keys stay HMAC'd (REQ-SEC-078, REQ-SEC-079).
IRD/regulatory impact (billing changes only): none.
Alternatives considered: (a) hit-only tricks (read-by-hit, test-and-set slots) — each read increments, corrupts counts, no last-hit time; (b) keep process Maps — the audit 6.1 finding itself; (c) a separate table with its own DEFINER functions — same migration need; (d) drop accountState/backoff and keep only the 10/h attempt cap — changes lockout semantics, which LD-237 forbids; (e) lead amends LD-237 to allow this migration inside SEC-ABUSE-1.
Tests that will prove it: services/api/src/modules/identity/handlers/__tests__/abuse1.limits.test.ts (already written); db tests: peek never changes hits, clear removes only its key, last_hit set by ratelimit_hit, EXECUTE granted to lims_api only and denied to lims_app/lims_worker.
