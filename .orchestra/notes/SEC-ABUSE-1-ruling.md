CR_NEEDED — the spec itself is contradictory/missing (write the CR text into `.orchestra/cr/SEC-ABUSE-1.md` using spec/program/04-CHANGE-REQUESTS.md)
1. The disputed tests (abuse1.limits.test.ts:39-54, :94-101) assert what LD-237 (1) binds: "SAME thresholds, windows and lockout semantics" — loginStaff.ts:25-29,56-61 today exposes accountState {failures, lastFailureAt} and clearAccountFailures. The tests are not wrong.
2. The only store primitive the spec defines is app.ratelimit_hit (C0 05-SCHEMA.md:1101-1119; 03-INTERFACE-CATALOG.md:3469; db/migrations/20261105000900_core__create_event_log.sql:188-206): every call INSERT/UPDATEs hits and returns only allowed/retry_after_seconds. No read without consuming, no delete, no last-hit time.
3. core.rate_limit_counters has no grants to any app role (C0 05-SCHEMA.md:254, :325; db/tests/core/T0B-05_platform.test.sql:65,359), so the API cannot read or clear it directly either.
4. The estimate is a sliding-window approximation (05-SCHEMA.md:1115), so even counting via hits cannot give the exact 60 min / 10 min windows nor lastFailureAt = T0+30 s that the tests require.
5. LD-237 forbids a migration ("No migration and no contract change"), yet (1) is impossible without new DEFINER functions: the binding decision is self-contradictory. Lead must rule (approve CR to C0-0B, or amend LD-237).
6. Unblocked parts (no migration needed) may proceed if the lead splits the task: login tier on changeOwnPassword/confirmEmailToken (LD-237 (2)), `i:` IP bucket on general (LD-237 (3)), web client-IP helper (LD-237 (4)).
7. Also noted: handlers/user.http.ts:22 calls createAuthLimits(undefined).clearAccountFailures — outside the file list; it would fail closed once moved to the store; include in the follow-up.
CR text: .orchestra/cr/SEC-ABUSE-1.md (supersedes the writer's SEC-ABUSE-1.1.nonblocking.md draft; same content, marked blocking).

----
LEAD RULING, LD-410 (CR-C1-SEC-ABUSE-1): amending LD-237 to allow this one narrow migration.

LD-237 asked for exact same lockout semantics (including clear on success) using only the existing
hit-and-check limiter, plus a blanket no-migration rule -- those two turned out incompatible. This
is rate-limiter bookkeeping, not business/user data, and EXECUTE on the two new functions goes only
to lims_api, which already holds the base grant -- not a new role or broader access, so it is within
LD-310, not a founder item. Clearing on success was deliberate in LD-237's original wording and is
worth keeping.

APPROVED exactly as the CR proposes, to C0-0B:
1. ALTER TABLE core.rate_limit_counters ADD COLUMN last_hit timestamptz (nullable), set by
   app.ratelimit_hit on insert and update; ratelimit_hit's own signature is unchanged.
2. app.ratelimit_peek(p_key_hash text, p_window_seconds int, OUT hits int, OUT last_hit
   timestamptz): STABLE, SECURITY DEFINER, search_path = '', never writes.
3. app.ratelimit_clear(p_key_hash text) RETURNS void: VOLATILE, SECURITY DEFINER, search_path = '',
   deletes only the row(s) for that one key_hash.
4. GRANT EXECUTE on both to lims_api only; owner lims_owner; both added to
   db/meta/definer-inventory.yaml.
5. RateLimitBackend gains peek/clear; RateLimiter gains peek(tier,key)/clear(tier,key) with the same
   HMAC + prefix rules as the rest of the limiter; fail closed on the login tier.
6. 60-minute failure-window bucket size is C0-0B's own implementation call.

Unblock now, no need to wait on the migration: (2) changeOwnPassword/confirmEmailToken onto the
login tier, (3) the 'i:' IP-bucket on general, (4) the web client-IP helper. Only part (1)
(loginStaff.ts's own exact failure/lockout semantics) waits on the migration landing.

Reset: C1 SEC-ABUSE-1 to changes.

----
LEAD ITEM, LD-414 (2026-11-19):

Debug rounds 1-3 (all post LD-410) confirm the same root cause: LD-410 approved migration (the
last_hit column plus app.ratelimit_peek and app.ratelimit_clear, full spec in LD-410) has not
landed in db/, and C1 is correctly refusing to add a migration itself under the general
no-migration-from-the-wrong-lane discipline. C0-0B, the lane this was nominally routed to for the
actual migration file, has zero open or runnable tasks right now; every T0B task in that chunk
shows done. There is no existing task there to attach this LEAD ITEM to through the normal
per-task reset mechanism.

Cross chunk authorization (one time supersession, same precedent as LD-405/LD-358): C1 is
authorized to write and land the migration file specified in LD-410 directly (the ALTER TABLE, the
two SECURITY DEFINER functions, the GRANT EXECUTE to lims_api only). This is scoped to exactly the
migration LD-410 already specified in full; it is not a general license for C1 to add other
migrations.

Once the migration is in db/ and applied on the throwaway PG17, the TS RateLimitBackend and
RateLimiter peek/clear methods and the loginStaff.ts wiring from LD-410 item (1) can proceed as
already planned; items 2/3/4 of the split were already unblocked by LD-410 and continue
regardless.

Reset applied: changes.
