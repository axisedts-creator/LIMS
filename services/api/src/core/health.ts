// getLiveness / getReadiness (02-TRD §8, contracts/openapi/core.yaml). x-public: dependency names and states only.
import type { Handler } from './module.js';

export type CheckState = 'ok' | 'degraded' | 'down';
export interface HealthChecks {
  db(): Promise<CheckState>;
  ratelimit(): Promise<CheckState>;
}

const STATES: readonly unknown[] = ['ok', 'degraded', 'down'];
/** A throw or an out-of-enum value is `down`; the error itself never reaches the response.
 *  ponytail: no per-check timeout; the real checks (later tasks) bound their own I/O via statement/connect timeouts. */
const run = async (c: () => Promise<CheckState>): Promise<CheckState> => {
  try {
    const s = await c();
    return STATES.includes(s) ? s : 'down';
  } catch {
    return 'down';
  }
};

export function createHealthHandlers(checks: HealthChecks): { getLiveness: Handler; getReadiness: Handler } {
  return {
    // Process-only: never touches a dependency.
    getLiveness: async () => ({ status: 200, body: { status: 'ok' } }),
    // Checks run per request (no caching). [CONV] degraded -> 200 {status:'degraded'}; any down -> 503.
    getReadiness: async () => {
      const [db, ratelimit] = await Promise.all([run(() => checks.db()), run(() => checks.ratelimit())]);
      const all = [db, ratelimit];
      const status: CheckState = all.includes('down') ? 'down' : all.includes('degraded') ? 'degraded' : 'ok';
      return { status: status === 'down' ? 503 : 200, body: { status, checks: { db, ratelimit } } };
    },
  };
}

/** [CONV] until the DB pool / rate-limit backend wire their real checks: fail closed (not ready). */
export const UNWIRED_CHECKS: HealthChecks = { db: async () => 'down', ratelimit: async () => 'down' };
