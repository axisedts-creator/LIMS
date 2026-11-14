// Redis backend (ephemeral, no persistence — 04 S11). ioredis-shaped client; every client error rejects so the
// limiter applies its fail-open/closed policy. Each algorithm is one atomic Lua script using the server clock.
import type { RateLimitBackend, RateLimitDecision } from './index.js';

export interface RedisLike { eval(script: string, numKeys: number, ...args: Array<string | number>): Promise<unknown> }

const NOW = "local t = redis.call('TIME'); local now = tonumber(t[1]) + tonumber(t[2]) / 1e6\n";

// Same sliding-window approximation as app.ratelimit_hit (REQ-SEC-079); rejected hits count too.
const SLIDING = NOW + `
local w = tonumber(ARGV[1]); local limit = tonumber(ARGV[2])
local cur = math.floor(now / w) * w; local elapsed = now - cur
local ck = KEYS[1] .. ':' .. cur
local hits = redis.call('INCR', ck)
if hits == 1 then redis.call('EXPIRE', ck, w * 2) end
local prev = tonumber(redis.call('GET', KEYS[1] .. ':' .. (cur - w)) or '0')
if prev * (1 - elapsed / w) + hits <= limit then return {1, 0} end
return {0, math.max(1, math.ceil(w - elapsed))}`;

const BUCKET = NOW + `
local rate = tonumber(ARGV[1]); local burst = tonumber(ARGV[2])
local s = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(s[1]) or burst; local ts = tonumber(s[2]) or now
tokens = math.min(burst, tokens + math.max(0, now - ts) * rate)
local ok = tokens >= 1
if ok then tokens = tokens - 1 end
redis.call('HSET', KEYS[1], 'tokens', tostring(tokens), 'ts', tostring(now))
redis.call('EXPIRE', KEYS[1], math.ceil(burst / rate) + 1)
if ok then return {1, 0} end
return {0, math.max(1, math.ceil((1 - tokens) / rate))}`;

const COUNTER = `
local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('EXPIRE', KEYS[1], tonumber(ARGV[2])) end
if n <= tonumber(ARGV[1]) then return {1, 0} end
return {0, math.max(1, redis.call('TTL', KEYS[1]))}`;

export function createRedisBackend({ client }: { client: RedisLike }): RateLimitBackend {
  const run = async (script: string, key: string, a: number, b: number): Promise<RateLimitDecision> => {
    const r = await client.eval(script, 1, key, a, b);
    if (!Array.isArray(r)) throw new Error('ratelimit: unexpected redis reply');
    return { allowed: Number(r[0]) === 1, retryAfterSeconds: Number(r[1]) };
  };
  return {
    slidingWindow: (h, w, limit) => run(SLIDING, `rl:sw:${h}`, w, limit),
    tokenBucket: (h, rate, burst) => run(BUCKET, `rl:tb:${h}`, rate, burst),
    counter: (h, limit, ttl) => run(COUNTER, `rl:c:${h}`, limit, ttl),
  };
}
