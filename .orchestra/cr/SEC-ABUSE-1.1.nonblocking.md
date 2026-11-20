Title: CR-C1-SEC-ABUSE-1.1: non-consuming read and reset for the Postgres limiter (needed to move login failure windows out of process Maps)
From chunk: C1            To owner: C0-0B
Type: schema
Blocking? yes for the part of SEC-ABUSE-1 that moves loginStaff.ts failure/IP state (audit 6.1); the other parts (login tier on changeOwnPassword + confirmEmailToken, `i:` IP bucket on `general`, web client IP helper) do not need it.
Problem: loginStaff.ts keeps failure windows, IP engagement and throttle in process Maps (N instances multiply thresholds; restart forgets). `app.ratelimit_hit(key_hash, window_s, limit)` only increments; no read without consuming, no delete, no last-hit time; core.rate_limit_counters has no grants. auth.service.ts:142-161 needs: failure count in 60 min, time of the latest failure, clear on success/reset, IP failures 10 in 10 min -> 30 min throttle, 5 attempts/60 s while throttled.
Proposed change (exact): add SECURITY DEFINER functions in schema app, EXECUTE to lims_api only, search_path pinned, same HMAC'd key_hash input:
  app.ratelimit_peek(p_key_hash text, p_window_seconds int) RETURNS TABLE(hits int, last_hit timestamptz)   -- reads, never writes
  app.ratelimit_clear(p_key_hash text) RETURNS void                                                    -- deletes that key's rows
  (last_hit needs a new column core.rate_limit_counters.last_hit timestamptz, set by ratelimit_hit; UNLOGGED table, nullable, default now())
Then RateLimitBackend gains peek/clear and RateLimiter gains `peek(tier,key)` / `clear(tier,key)` with the same prefix rules, fail closed on login.
Backward compatible? yes (additive).
Tenant/security impact: no RLS change, no PHI, no public surface; keys stay HMAC'd (REQ-SEC-078/079).
Alternatives considered: (a) hit-only tricks (test-and-set slots) — read sets the slot, impossible; (b) keep Maps — the audit finding; (c) a new table with its own DEFINER functions — same migration need; (d) drop accountState/backoff and use only the 10/h cap — changes lockout semantics, LD-237 says unchanged.
Tests that will prove it: abuse1.limits.test.ts (already written) plus db tests for peek/clear grants and last_hit.
