// T-26 (C3) test helper: JobContext runner for the per_tenant cron tasks (catalog.expire_imports / purge_files / global_release_fanout).
// ctx.tx = the job transaction: COMMITTED when the handler resolves, ROLLED BACK when it throws (as the worker core does). ctx.events.publish
// is buffered in the same transaction: events are kept only on COMMIT (the real publish inserts into the event log in ctx.tx, 02-CV §7.4).
// ctx.db.tx(fn) = fn(ctx), the SAME transaction (services/worker/src/core/consumer.ts:58). Synthetic data only.
import { makeCronDb, NOW, TENANT_A, TENANT_B, USER, V7, type CronDb } from './cronDb.js';

export { makeCronDb, NOW, TENANT_A, TENANT_B, USER, V7 };
export type { CronDb };
export const SYS = '0190a000-0000-7000-8000-0000000a0004';           // catalog system actor (shape only)
export const DAY = 86_400_000;
export const uid = (n: number) => `0190c326-0000-7000-8000-${String(n).padStart(12, '0')}`;
export const ago = (ms: number) => new Date(Date.parse(NOW) - ms);
export const ahead = (ms: number) => new Date(Date.parse(NOW) + ms);

export function makeLog() {
  const lines: string[] = [];
  const safe = (v: unknown) => { try { return JSON.stringify(v, (_k, x) => (x instanceof Error ? { name: x.name, message: x.message, stack: x.stack } : typeof x === 'bigint' ? String(x) : x)); } catch { return String(v); } };
  const log: any = {};
  for (const level of ['debug', 'info', 'warn', 'error']) log[level] = (...args: unknown[]) => { lines.push(`${level} ${safe(args)}`); };
  log.child = () => log;
  return { log, lines, text: () => lines.join('\n') };
}

export interface PublishedEvent { type: string; input: any; ctx: any }

export function makeRunner(db: CronDb, handler: (payload: any, ctx: any) => Promise<void>, o: { tenantId?: string; publishError?: Error } = {}) {
  const tenantId = o.tenantId ?? TENANT_A;
  const events: PublishedEvent[] = [];
  const metrics: Array<{ name: string; labels: any }> = [];
  const l = makeLog();
  return {
    events, metrics, log: l,
    /** One attempt under `tenantId`'s claims. Rejects when the handler throws (after rolling back ctx.tx and discarding its events). */
    async run(payload: any = { tenant_id: tenantId }, attempt = 1, maxAttempts = 1) {
      const tx = db.begin(tenantId, SYS);
      const pending: PublishedEvent[] = [];
      const ctx: any = {
        tenantId, actor: { type: 'system', id: SYS }, requestId: uid(9000), tx: tx.facade, attempt, maxAttempts, jobId: '1', now: () => NOW, isNewer: () => true,
        events: { publish: async (c: any, type: string, input: any) => { if (o.publishError) throw o.publishError; pending.push({ type, input, ctx: c }); } },
        core: {}, storage: {}, audit: {}, files: {}, log: l.log,
        metrics: { inc: (name: string, labels: any = {}) => { metrics.push({ name, labels }); }, set() {}, observe() {} },
      };
      ctx.db = { tx: async (fn: (c: any) => Promise<unknown>) => fn(ctx) };
      try { await handler(payload, ctx); tx.commit(); events.push(...pending); } catch (e) { tx.rollback(); throw e; }
    },
  };
}
