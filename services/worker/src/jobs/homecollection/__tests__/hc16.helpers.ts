// HC-T16 helpers: live PG17 (tests/homecollection/HC-T16.pg.sh exports LIMS_TEST_APP_URL, LIMS_TEST_SUPER_URL, LIMS_TEST_WORKER_URL; a missing variable is a HARD FAILURE, never a skip).
// Jobs run in production as login role `lims_worker` (inherits lims_app, NOBYPASSRLS) under the module's SYSTEM actor claims, one transaction per delivery.
// Fixtures are written as superuser; assertions read as superuser. Synthetic data only.
import { SYS_ACTOR, TENANT_A, TENANT_B, closePools as closeBase, uid } from '../../../../../api/src/modules/homecollection/repository/__tests__/helpers.js';
export { SYS_ACTOR, TENANT_A, TENANT_B, uid };

const need = (k: string): string => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} is not set: run .orchestra\\notes\\HC-T16-verify.cmd (boots PG17 via docker)`);
  return v;
};
const pgModule = 'pg';
const { default: pg } = (await import(pgModule)) as any;
const workerPool = new pg.Pool({ connectionString: need('LIMS_TEST_WORKER_URL'), max: 10 });
const appPool = new pg.Pool({ connectionString: need('LIMS_TEST_APP_URL'), max: 4 });
export const closePools = async () => { await workerPool.end(); await appPool.end(); await closeBase(); };

export type Actor = 'system' | 'user';
const claims = (tenant: string | null, actor: Actor, sub: string) => JSON.stringify({ ...(tenant ? { tenant_id: tenant } : {}), sub, actor_type: actor });
async function txOn(pool: any, tenant: string | null, actor: Actor, sub: string, fn: (tx: any) => Promise<any>) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('request.jwt.claims', $1, true)", [claims(tenant, actor, sub)]);
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
}
/** one job delivery: transaction as lims_worker under `tenant`'s claims (system actor by default) */
export const workerTx = (tenant: string | null, fn: (tx: any) => Promise<any>, actor: Actor = 'system', sub: string = SYS_ACTOR) => txOn(workerPool, tenant, actor, sub, fn);
/** request-style transaction as lims_api (what an API request runs as); used for the 'user actor' probes */
export const apiTx = (tenant: string | null, fn: (tx: any) => Promise<any>, actor: Actor = 'user', sub: string = '01a1a98a-ac40-7000-8000-00000000a300') => txOn(appPool, tenant, actor, sub, fn);

export interface CtxOpts { now: string; retentionYears?: number; settingsCalls?: unknown[][]; rawSettings?: Record<string, unknown>; settingsError?: Error }
let spN = 0;
/** hand-built JobContext (as HC-T06/HC-T14): ctx.now() is the FAKE CLOCK (ISO string); the only port is identity.getTenantSettings (timezone 'Asia/Kathmandu' per 08 A13 P-15, retentionYears); every other port is a trap. */
export function makeCtx(tx: any, tenant: string, o: CtxOpts, logs: string[] = []) {
  const sink = (x: unknown, m?: unknown) => logs.push(JSON.stringify([x, m]));
  const log: any = { info: sink, warn: sink, error: sink, debug: sink, child: () => log };
  const identity = {
    getTenantSettings: async (...args: unknown[]) => {
      o.settingsCalls?.push(args);
      if (o.settingsError) throw o.settingsError;
      return o.rawSettings ?? { timezone: 'Asia/Kathmandu', retentionYears: o.retentionYears ?? 5 };
    },
  };
  const ports: any = new Proxy({ identity }, { get(t: any, p) { if (p in t) return t[p]; throw new Error(`the task must not use ports.${String(p)}`); } });
  const ctx: any = {
    tenantId: tenant, tx, actor: { type: 'system', id: SYS_ACTOR }, requestId: uid(), attempt: 1, maxAttempts: 5, jobId: '1',
    now: () => o.now, isNewer: () => true, events: {}, core: {}, audit: { access: async () => undefined }, storage: {}, files: {}, log, metrics: { inc() {}, set() {}, observe() {} }, ports,
  };
  ctx.db = {
    tx: async (fn: (c: any) => Promise<any>) => {
      const sp = `hc_t16_sp_${++spN}`;
      await tx.query(`SAVEPOINT ${sp}`);
      try { const r = await fn(ctx); await tx.query(`RELEASE SAVEPOINT ${sp}`); return r; }
      catch (e) { await tx.query(`ROLLBACK TO SAVEPOINT ${sp}`); throw e; }
    },
  };
  return ctx;
}

/** one delivery = one transaction as lims_worker; returns the thrown error instead of throwing */
export async function runTask(handler: (payload: any, ctx: any) => Promise<void>, payload: unknown, tenant: string, o: CtxOpts) {
  const logs: string[] = []; let threw: any;
  try { await workerTx(tenant, async (tx) => { await handler(payload, makeCtx(tx, tenant, o, logs)); }); } catch (e) { threw = e; }
  return { logs, threw };
}

// ---- Asia/Kathmandu (UTC+05:45, no DST) clock helpers ----
/** ISO instant for `hh:mm` Kathmandu time on calendar `date` (YYYY-MM-DD), shifted by `addDays` */
export const kathmandu = (date: string, hhmm: string, addDays = 0): string => {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(Date.parse(`${date}T00:00:00Z`) + addDays * 86_400_000 + (h! * 60 + m!) * 60_000 - (5 * 60 + 45) * 60_000).toISOString();
};
