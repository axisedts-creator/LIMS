// T0B-PERF-1 (LD-310) done_when 2-3: per request database query count and time. The HTTP layer opens one scope per
// request (installRequestTiming); core/db/tx.ts records into it; Server-Timing and the request log line read it.
import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestStats {
  recordQuery(ms: number): void;
  snapshot(): { count: number; ms: number };
}

export function createRequestStats(): RequestStats {
  let count = 0;
  let ms = 0;
  return {
    recordQuery(d: number) {
      count += 1;
      if (Number.isFinite(d) && d > 0) ms += d; // negative / NaN: counted, no time
    },
    snapshot: () => ({ count, ms }),
  };
}

const als = new AsyncLocalStorage<RequestStats>();
export const withRequestStats = <T>(stats: RequestStats, fn: () => T): T => als.run(stats, fn);
export const currentRequestStats = (): RequestStats | undefined => als.getStore();
