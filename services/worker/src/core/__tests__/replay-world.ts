// Fake Postgres for the replay tests (T0D-09 reopen, LD-65). Real transaction semantics (snapshot on BEGIN, restore on ROLLBACK, serialised),
// STRICT tenant RLS on core.event_log (a row is visible only when the tx claims carry its tenant_id), app.enqueue_job with the
// g_task_registry / tenant-match / unsafe_dedupe behaviour of 02-TRD §7.3, and app.cron_tenant_ids(). Statements are matched by CONTENT.
// Listing query contract assumed for replay.ts (spec gives none): a SELECT on core.event_log whose bound parameters carry the event type
// (string), the `since` lower bound (Date or ISO string; the smallest date-like value is the lower bound), optionally a keyset cursor
// (a uuid that is not the claim tenant: rows with event_id <= cursor are skipped) and optionally a LIMIT (integer parameter or literal).
import { CORE_ACTOR, FIXED_NOW, pgError, systemActorOf } from './helpers.js';

export interface EventRow { tenant_id: string; event_id: string; event_type: string; occurred_at: string }
export interface Job { identifier: string; payload: any; jobKey: string | null; claims: any; maxAttempts: number | null }
export { CORE_ACTOR, FIXED_NOW, systemActorOf };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EVENT_TYPE = /^[a-z_]+\.[a-z_.]+\.v\d+$/;
const dateLike = (v: unknown): number | undefined => {
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v) && !Number.isNaN(Date.parse(v))) return Date.parse(v);
  return undefined;
};

export function makeReplayWorld() {
  let state = {
    events: [] as EventRow[],
    jobs: [] as Job[],
    tenants: [] as Array<{ id: string; status: string }>,
    registry: {} as Record<string, { scope: string; active: boolean }>,
  };
  const txLog: Array<{ id: number; claims0: any; outcome: 'open' | 'commit' | 'rollback'; stmts: Array<{ text: string; values: unknown[]; claims: any }> }> = [];
  const failures: Array<{ match: RegExp; times: number; error: () => Error; when?: (values: unknown[], claims: any) => boolean }> = [];
  let lock: Promise<unknown> = Promise.resolve();
  let nextTx = 1;

  function query(rec: (typeof txLog)[number], tx: { claims: any }, text: string, values: unknown[] = []) {
    const t = text.replace(/\s+/g, ' ').trim();
    rec.stmts.push({ text: t, values, claims: tx.claims });
    for (const f of failures) if (f.times > 0 && f.match.test(t) && (!f.when || f.when(values, tx.claims))) { f.times -= 1; throw f.error(); }
    const claimTenant = tx.claims?.tenant_id as string | undefined;

    if (/app\.enqueue_job/i.test(t)) {
      const [identifier, rawPayload, jobKey] = values as [string, unknown, string | null];
      const payload = typeof rawPayload === 'string' ? JSON.parse(rawPayload) : rawPayload;
      const reg = state.registry[identifier];
      if (!reg || !reg.active) throw pgError('P0001', 'unknown_task_identifier');
      if (reg.scope === 'per_tenant' && (claimTenant === undefined || (payload as any)?.tenant_id !== claimTenant)) throw pgError('P0001', 'job_tenant_mismatch');
      const maxAttempts = (values.find((v, i) => i >= 3 && typeof v === 'number') as number | undefined) ?? null;
      if (jobKey && state.jobs.some((j) => j.identifier === identifier && j.jobKey === jobKey)) return { rows: [{ enqueue_job: null }] };   // unsafe_dedupe
      state.jobs.push({ identifier, payload, jobKey: jobKey ?? null, claims: { ...tx.claims }, maxAttempts });
      return { rows: [{ enqueue_job: null }] };
    }
    if (/app\.cron_tenant_ids/i.test(t)) {
      return { rows: state.tenants.filter((x) => x.status === 'active' || x.status === 'suspended').map((x) => ({ cron_tenant_ids: x.id, id: x.id, tenant_id: x.id })) };
    }
    if (/^SELECT[\s\S]*FROM\s+core\.event_log/i.test(t)) {
      if (claimTenant === undefined) return { rows: [] };                           // RLS __select__tenant: no tenant claim, no rows
      const type = values.find((v) => typeof v === 'string' && EVENT_TYPE.test(v)) as string | undefined;
      const dates = values.map(dateLike).filter((d): d is number => d !== undefined);
      const since = dates.length ? Math.min(...dates) : undefined;
      const cursors = values.filter((v): v is string => typeof v === 'string' && UUID.test(v) && v !== claimTenant);
      const cursor = cursors.length ? cursors.sort().at(-1) : undefined;
      const lit = /LIMIT\s+(\d+)/i.exec(t);
      const limitParam = values.find((v): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0);
      const limit = lit ? Number(lit[1]) : limitParam;
      let rows = state.events.filter((e) => e.tenant_id === claimTenant);
      if (type) rows = rows.filter((e) => e.event_type === type);
      if (since !== undefined) rows = rows.filter((e) => Date.parse(e.occurred_at) >= since);
      if (cursor) rows = rows.filter((e) => e.event_id > cursor);
      rows = [...rows].sort((a, b) => (a.event_id < b.event_id ? -1 : 1));
      if (limit) rows = rows.slice(0, limit);
      return { rows: rows.map((e) => ({ ...e, envelope: { event_id: e.event_id, event_type: e.event_type, tenant_id: e.tenant_id, occurred_at: e.occurred_at } })) };
    }
    if (/\b(INSERT|UPDATE|DELETE)\b/i.test(t) && !/^SELECT/i.test(t)) throw new Error(`fake: replay may only write through app.enqueue_job, got: ${t.slice(0, 120)}`);
    return { rows: [] };
  }

  const db = {
    async tx<T>(input: { claims: any; statementTimeoutMs?: number; operation?: string }, fn: (tx: any) => Promise<T>): Promise<T> {
      const prev = lock; let release!: () => void;
      lock = new Promise<void>((r) => { release = r; });
      await prev;
      const snapshot = structuredClone(state);
      const rec = { id: nextTx++, claims0: { ...input.claims }, outcome: 'open' as 'open' | 'commit' | 'rollback', stmts: [] as any[] };
      txLog.push(rec);
      const tx: any = { claims: { ...input.claims }, startedAt: FIXED_NOW };
      tx.query = async (text: string, values?: unknown[]) => query(rec, tx, text, values);
      try { const out = await fn(tx); rec.outcome = 'commit'; return out; }
      catch (e) { state = snapshot; rec.outcome = 'rollback'; throw e; }
      finally { release(); }
    },
  };
  const withTenantScope = async <T>(tx: any, tenantId: string, systemActorId: string, fn: () => Promise<T>): Promise<T> => {
    const prev = tx.claims;
    tx.claims = { sub: systemActorId, tenant_id: tenantId, actor_type: 'system' };
    try { return await fn(); } finally { tx.claims = prev; }
  };

  return {
    db, withTenantScope, txLog,
    get jobs() { return state.jobs; },
    seedEvents(rows: EventRow[]) { state.events.push(...rows); },
    seedTenants(ts: Array<{ id: string; status: string }>) { state.tenants = ts; },
    loadRegistry(entries: any[]) { state.registry = {}; for (const e of entries) state.registry[e.identifier] = { scope: e.scope, active: true }; },
    failOn(match: RegExp, error: () => Error, o: { times?: number; when?: (values: unknown[], claims: any) => boolean } = {}) {
      failures.push({ match, error, ...(o.when ? { when: o.when } : {}), times: o.times ?? Infinity });
    },
    stmts: (re: RegExp) => txLog.flatMap((t) => t.stmts).filter((s) => re.test(s.text)),
  };
}
export type ReplayWorld = ReturnType<typeof makeReplayWorld>;
export const replayCoreActor = CORE_ACTOR;
