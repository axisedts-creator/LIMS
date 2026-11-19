# SEC-ABUSE-1 debugger (2026-11-19)
Cause: the 10 reds in abuse1.limits.test.ts are LD-410 part (1): loginStaff.ts:25-80 still uses process Maps; the limiter (core/ratelimit index.ts, pg.ts) has no peek/clear. Tests are right (LD-410 binds them, no dispute).
Why no code fix: app.ratelimit_peek/_clear + core.rate_limit_counters.last_hit are NOT in db/ (C0-0B migration not landed; grep db/ empty). Store-backed code against today's DB = missing function = DB error = fail closed = every staff login 503 (writer proved it, identity-actor/bff-key tests). Reds cannot go green without it; LD-235/237 bar C1 from adding a migration.
Needed: land C0-0B migration per LD-410 items 1-4 (+definer-inventory), then writer adds RateLimitBackend.peek/clear (pg.ts: SELECT * FROM app.ratelimit_peek($1,$2) / SELECT app.ratelimit_clear($1)), RateLimiter.peek/clear (HMAC+prefix, login fails closed), rewrites createAuthLimits on them, and keeps user.http.ts:22 clear non-throwing.
## round 2 (2026-11-19 09:17 verify)
Same 10 reds (abuse1.limits.test.ts fail-closed/no-Maps), 126 other tests green. Cause unchanged: LD-410 part (1) needs app.ratelimit_peek/_clear + last_hit; grep of db/ still empty (C0-0B migration not landed).
No code fix: store-backed loginStaff against today DB = missing function = every staff login 503. No test edit, no migration from C1. Tests right, no dispute.
Needed: lead lands C0-0B per LD-410 items 1-4, then writer does items 5 (RateLimitBackend/RateLimiter peek/clear, createAuthLimits on them, user.http.ts:22 clear non-throwing).
