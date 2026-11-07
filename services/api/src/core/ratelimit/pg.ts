// Postgres fallback backend: only the SECURITY DEFINER app.ratelimit_hit (05-SCHEMA §10); core.rate_limit_counters has no grants.
import type { RateLimitBackend, RateLimitDecision } from './index.js';

const SQL = 'SELECT allowed, retry_after_seconds FROM app.ratelimit_hit($1, $2, $3)';

export function createPgBackend(db: { query(sql: string, values: unknown[]): Promise<{ rows: any[] }> }): RateLimitBackend {
  const hit = async (keyHash: string, windowSeconds: number, limit: number): Promise<RateLimitDecision> => {
    const { rows } = await db.query(SQL, [keyHash, windowSeconds, limit]);
    const row = rows[0];
    if (!row) throw new Error('ratelimit_hit returned no row'); // treated as backend down
    return { allowed: row.allowed === true, retryAfterSeconds: Number(row.retry_after_seconds) };
  };
  return {
    slidingWindow: hit,
    // ponytail: token bucket approximated as `burst` hits per ceil(burst/rate) s sliding window; same average rate, coarser refill.
    tokenBucket: (keyHash, rate, burst) => hit(keyHash, Math.max(1, Math.ceil(burst / rate)), burst),
    // Window limit*ttl+1 keeps the previous window's weight > 1-1/limit for one TTL, so total hits per TTL never exceed `limit`.
    counter: (keyHash, limit, ttlSeconds) => hit(keyHash, limit * ttlSeconds + 1, limit),
  };
}
