// Real readiness checks (LD-193, WIRE-HEALTH; C0 02-TRD §8 getReadiness { status, checks: { db, ratelimit } }).
// Read-only and bounded: `SELECT 1` and one catalog statement; app.ratelimit_hit is never called (a call consumes a hit).
import type { CheckState, HealthChecks } from '../health.js';

/** LD-193 rule 2: fixed bound for every check (no config key / env var). */
export const HEALTH_CHECK_TIMEOUT_MS = 2000;

// LD-193 rule 3: pg_proc + has_function_privilege, schema app, name ratelimit_hit. No row = function missing.
const RATELIMIT_CATALOG_SQL =
  "SELECT has_function_privilege(p.oid, 'EXECUTE') AS can_execute FROM pg_catalog.pg_proc p " +
  "JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'app' AND p.proname = 'ratelimit_hit'";

type Query = (text: string, values?: unknown[]) => Promise<{ rows: any[] }>;
type Warn = { warn(o: object, m?: string): void };

export function createHealthChecks(o: { query: Query; limiterConfigured: boolean; log?: Warn }): HealthChecks {
  // LD-193 rule 5: coalesce the in-flight promise per dependency; the slot is freed on settle, results are never cached.
  const inflight = new Map<string, Promise<CheckState>>();

  const bounded = (name: string, probe: () => Promise<CheckState>): Promise<CheckState> => {
    const running = inflight.get(name);
    if (running) return running;
    const p = (async (): Promise<CheckState> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let errorClass = 'error';
      try {
        const work = probe();
        work.catch(() => undefined); // a late rejection of the losing query must not become unhandled
        const deadline = new Promise<never>((_, rej) => {
          timer = setTimeout(() => { errorClass = 'timeout'; rej(new Error('timeout')); }, HEALTH_CHECK_TIMEOUT_MS);
        });
        const s = await Promise.race([work, deadline]);
        if (s !== 'ok') errorClass = 'unavailable';
        else return s;
      } catch { /* class only; the error itself is dropped (LD-193 rule 6) */ }
      finally { clearTimeout(timer); }
      // one warn per failed in-flight check: dependency name and a coarse class, never error text / host / SQLSTATE
      try { o.log?.warn({ event: 'health_check_failed', dependency: name, error_class: errorClass }, 'health_check_failed'); } catch { /* logging never breaks readiness */ }
      return 'down';
    })().finally(() => { inflight.delete(name); });
    inflight.set(name, p);
    return p;
  };

  return {
    db: () => bounded('db', async () => { await o.query('SELECT 1'); return 'ok'; }),
    ratelimit: async () => {
      if (!o.limiterConfigured) return 'down'; // fail closed, no SQL needed
      return bounded('ratelimit', async () => {
        const { rows } = await o.query(RATELIMIT_CATALOG_SQL);
        return rows.length > 0 && rows.every((r) => r?.can_execute === true) ? 'ok' : 'down';
      });
    },
  };
}
