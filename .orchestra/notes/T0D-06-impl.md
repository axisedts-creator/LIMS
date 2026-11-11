# T0D-06 impl
Files: `services/api/src/core/ratelimit/{index.ts,pg.ts,redis.ts}`. Tests: 49 pass, 4 skipped (live Redis, env-gated); full api suite 1040/0 failed (one flaky failure on first run, not reproducible); tsc clean.
- [CONV] keyHash = HMAC-SHA256(hmacKey, `${tier}|${key}`) so one key never shares a counter across tiers; key prefix must match the tier (02-TRD §6.7), else plain Error (never fails open).
- [CONV] otp_verify counter TTL = 600 s (04 A9: OTP TTL ≤ 10 min); pg counter window = limit*ttl+1 so ≤ limit hits per TTL (review item 1; 50 pass / 4 skipped after fix). `ingest` fails closed (only `general` listed fail-open).
- [CONV] pg tokenBucket ≈ `app.ratelimit_hit(h, ceil(burst/rate), burst)` (same average rate, ≤ burst per instant). Retry-After = ceil, min 1; malformed backend reply = reject, not allow.
- Redis: atomic Lua scripts via `client.eval` using server `TIME`; sliding window mirrors ratelimit_hit. Not run live (ioredis not a dependency, LD-05).
- Open: login `f:<ip>` prefix not accepted (C2 failed-attempt rule needs its own thresholds/API); backend selection + pipeline wiring (config.ts / stage 5) out of scope.
