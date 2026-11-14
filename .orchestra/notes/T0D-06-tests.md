# T0D-06 tests (rate limiting)
Files: `services/api/src/core/ratelimit/__tests__/{limiter.test.ts,backends.test.ts,helpers.ts}`.
Run: `.orchestra\notes\T0D-06-verify.cmd` (= `pnpm --dir services/api exec vitest run src/core/ratelimit/__tests__`). Now fails: `../index.js` missing.
Prescribed API (headers of both test files): `index.ts createRateLimiter({backend,hmacKey,log?,metrics?,tenant?})->{consume(tier,key)}`; `pg.ts createPgBackend({query})`; `redis.ts createRedisBackend({client})`; backend = `slidingWindow|tokenBucket|counter`.
Covers: every 04 §4 tier limit, HMAC key hashing, 429 + Retry-After + metric, fail-open `general` / fail-closed rest (AB-18), boundary-burst via a port of `app.ratelimit_hit` (REQ-SEC-079).
Not covered: login `f:<ip>` failed-attempt rule (C2 applies it); real SQL function (T0B-05) and real Redis (live suite only if `LIMS_TEST_REDIS_URL` is set; needs `ioredis`, a lockfile change owned by C0-0A); `general` token-bucket timing on pg is only bounded (<= burst); backend selection by `LIMS_CORE_RATELIMIT_BACKEND` and `x-rate-limit-tier` pipeline stage 5 (config.ts / pipeline, not this task's files).
Assumption: `ingest` fails closed (spec lists only `general` as fail-open). OTP lifetime for `otp_verify` counter is unspecified; tests only require a positive integer TTL.
