// T0B-SWEEP-2 (LD-270 done_when 1): the per-user `u:` bucket (10/s, burst 20, src/core/ratelimit/index.ts) is hard-coded, not configuration,
// so the harness paces calls per session subject under it and retries a 429 after Retry-After. Any 429 left is NOT EXERCISED (classify.ts).

export function createPacer(o: { ratePerSecond: number; burst: number; now: () => number; sleep: (ms: number) => Promise<void> }): { acquire(subject: string): Promise<void> } {
  const buckets = new Map<string, { tokens: number; at: number }>();
  return {
    async acquire(subject) {
      const t = o.now();
      const b = buckets.get(subject) ?? { tokens: o.burst, at: t };
      b.tokens = Math.min(o.burst, b.tokens + ((t - b.at) * o.ratePerSecond) / 1000);
      b.at = t;
      if (b.tokens < 1) {
        const wait = Math.ceil(((1 - b.tokens) * 1000) / o.ratePerSecond);
        await o.sleep(wait);
        const t2 = o.now();
        b.tokens = Math.min(o.burst, b.tokens + ((t2 - b.at) * o.ratePerSecond) / 1000);
        b.at = t2;
      }
      b.tokens -= 1;
      buckets.set(subject, b);
    },
  };
}

/** Retries a 429 after Retry-After (>= 1 s). A wait longer than `maxWaitMs` (hour-window tiers such as login) gives up at once: NOT EXERCISED. */
export async function withRateLimitRetry<T extends { statusCode: number; headers: Record<string, unknown> }>(
  send: () => Promise<T>, o: { sleep: (ms: number) => Promise<void>; maxAttempts?: number; maxWaitMs?: number },
): Promise<{ res: T; attempts: number }> {
  const max = o.maxAttempts ?? 5;
  for (let attempts = 1; ; attempts++) {
    const res = await send();
    if (res.statusCode !== 429 || attempts >= max) return { res, attempts };
    const s = Number(res.headers['retry-after']);
    const ms = Math.max(1000, Number.isFinite(s) ? s * 1000 : 0);
    if (ms > (o.maxWaitMs ?? Infinity)) return { res, attempts };
    await o.sleep(ms);
  }
}
