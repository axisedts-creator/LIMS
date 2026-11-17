// T0D-06 test helpers. Fakes only — no Redis/Postgres needed.
export const KEY = 'test-hmac-key-0123456789abcdef';

export interface Decision { allowed: boolean; retryAfterSeconds: number }
export type Call = { kind: 'slidingWindow' | 'tokenBucket' | 'counter'; args: unknown[] };

/** Backend that records every call and answers with `decide()` (default: allow), or throws when `down`. */
export function recordingBackend(decide: () => Decision = () => ({ allowed: true, retryAfterSeconds: 0 })) {
  const calls: Call[] = [];
  const state = { down: false };
  const run = (kind: Call['kind']) => async (...args: unknown[]): Promise<Decision> => {
    calls.push({ kind, args });
    if (state.down) throw new Error('backend down');
    return decide();
  };
  return {
    calls, state,
    backend: { slidingWindow: run('slidingWindow'), tokenBucket: run('tokenBucket'), counter: run('counter') },
  };
}

export function recordingLog() {
  const entries: Array<{ level: string; obj: any; msg?: string }> = [];
  const mk = (level: string) => (obj: unknown, msg?: string) => { entries.push({ level, obj, msg }); };
  return { entries, log: { info: mk('info'), warn: mk('warn'), error: mk('error') } };
}

export function recordingMetrics() {
  const incs: Array<{ name: string; labels: Record<string, unknown> | undefined }> = [];
  return { incs, metrics: { inc: (name: string, labels?: Record<string, unknown>) => { incs.push({ name, labels }); }, set() {}, observe() {} } };
}

/** Fake clock in ms epoch. */
export function clock(startMs: number) {
  let t = startMs;
  return { now: () => t, set: (ms: number) => { t = ms; }, advance: (ms: number) => { t += ms; } };
}

/**
 * In-memory stand-in for `app.ratelimit_hit(p_key_hash, p_window_seconds, p_limit)` — a line-by-line port of
 * 05-SCHEMA.md §10 (sliding-window approximation, REQ-SEC-079). Exposed as a pg-style `query(sql, values)`.
 * Records the SQL text so tests can prove only the SECURITY DEFINER function is touched (table has no grants).
 */
export function fakePg(now: () => number) {
  const counters = new Map<string, number>(); // `${key_hash}|${window_start_s}` -> hits
  const executed: Array<{ sql: string; values: unknown[] }> = [];
  const state = { down: false };
  async function query(sql: string, values: unknown[] = []): Promise<{ rows: any[] }> {
    executed.push({ sql, values });
    if (state.down) throw new Error('ECONNREFUSED');
    if (!/app\.ratelimit_hit/.test(sql)) throw new Error(`unexpected SQL: ${sql}`);
    const [keyHash, windowSeconds, limit] = values as [string, number, number];
    const nowS = now() / 1000;
    const cur = Math.floor(nowS / windowSeconds) * windowSeconds;
    const prev = cur - windowSeconds;
    const elapsed = nowS - cur;
    const ck = `${keyHash}|${cur}`;
    const curHits = (counters.get(ck) ?? 0) + 1;
    counters.set(ck, curHits);
    const prevHits = counters.get(`${keyHash}|${prev}`) ?? 0;
    const estimate = prevHits * (1 - elapsed / windowSeconds) + curHits;
    const allowed = estimate <= limit;
    return { rows: [{ allowed, retry_after_seconds: allowed ? 0 : Math.max(1, Math.ceil(windowSeconds - elapsed)) }] };
  }
  return { query, executed, state };
}
