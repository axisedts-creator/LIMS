// Shared fixtures for the T0D-08 events.publish tests. Synthetic data only.
// An in-memory fake of ONE Postgres connection with transaction semantics (snapshot on BEGIN, restore on ROLLBACK).
// It understands only the statements publish() may issue: INSERT INTO core.event_log, SELECT FROM core.event_log, app.enqueue_job.
// Values are matched by CONTENT, never by position, so the tests do not pin the implementation's SQL layout.

export const TENANT_A = '0190a000-0000-7000-8000-00000000aaaa';
export const TENANT_B = '0190a000-0000-7000-8000-00000000bbbb';
export const USER = '0190a000-0000-7000-8000-00000000a001';
export const MEMBERSHIP = '0190a000-0000-7000-8000-00000000a002';
export const SUPPORT_SESSION = '0190a000-0000-7000-8000-00000000a003';
export const REQ_ID = '0190a000-0000-7000-8000-0000000000f1';
export const STARTED_AT = new Date(Date.UTC(2026, 10, 7, 12, 0, 0, 123));
export const UUIDV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** PHI-ish sentinel: must never appear in a log line or error (ids are still sensitive in logs). */
export const PATIENT_ID = '0190a000-0000-7000-8000-00000000ba7e';

export interface Stmt { readonly text: string; readonly values: readonly unknown[] }
export interface StoredEvent { readonly tenantId: string; readonly eventType: string; readonly key: string; readonly eventId: string; readonly envelope: any }
export interface Job { readonly text: string; readonly values: readonly unknown[] }

export const pgError = (code: string, message = `pg ${code}`) => Object.assign(new Error(message), { code });

const envelopeOf = (values: readonly unknown[]): any | undefined => {
  for (const v of values) {
    if (v && typeof v === 'object' && !(v instanceof Date) && 'event_id' in (v as object)) return v;
    if (typeof v === 'string' && v.startsWith('{')) {
      try { const o = JSON.parse(v); if (o && typeof o === 'object' && 'event_id' in o) return o; } catch { /* not json */ }
    }
  }
  return undefined;
};

export function makeEventDb() {
  let committed = { events: [] as StoredEvent[], jobs: [] as Job[] };
  let work = committed;
  const stmts: Stmt[] = [];
  const failures: Array<{ match: RegExp; error: () => Error }> = [];

  const tx = {
    startedAt: STARTED_AT,
    operation: { module: 'frontdesk', operationId: 'createOrder', context: 'tenant' },
    async query(text: string, values: unknown[] = []) {
      stmts.push({ text, values });
      const f = failures.find((x) => x.match.test(text));
      if (f) throw f.error();
      if (/INSERT\s+INTO\s+core\.event_log/i.test(text)) {
        const env = envelopeOf(values);
        if (!env) throw new Error('fake: INSERT INTO core.event_log without an envelope value');
        const dup = work.events.find((e) => e.tenantId === env.tenant_id && e.eventType === env.event_type && e.key === env.idempotency_key);
        if (dup) {
          if (!/ON\s+CONFLICT[\s\S]*DO\s+NOTHING/i.test(text)) throw pgError('23505', 'duplicate key value violates unique constraint');
          return { rows: [] };
        }
        work.events.push({ tenantId: env.tenant_id, eventType: env.event_type, key: env.idempotency_key, eventId: env.event_id, envelope: env });
        return { rows: [{ event_id: env.event_id }] };
      }
      if (/FROM\s+core\.event_log/i.test(text)) {
        const hit = work.events.find((e) => values.includes(e.tenantId) && values.includes(e.eventType) && values.includes(e.key));
        return { rows: hit ? [{ event_id: hit.eventId }] : [] };
      }
      if (/app\.enqueue_job/i.test(text)) {
        work.jobs.push({ text, values });
        return { rows: [{ enqueue_job: null }] };
      }
      return { rows: [] };
    },
    savepoint: async <T>(fn: (t: unknown) => Promise<T>) => fn(tx),
  };

  /** Runs fn as one transaction: commit on resolve, ROLLBACK (restore the snapshot) on reject. */
  async function transaction<T>(fn: () => Promise<T>, opts: { rollback?: boolean } = {}): Promise<T> {
    work = { events: [...committed.events], jobs: [...committed.jobs] };
    try {
      const out = await fn();
      if (opts.rollback) throw new Error('forced rollback');
      committed = work;
      return out;
    } catch (e) {
      work = committed;
      throw e;
    }
  }

  return {
    tx,
    stmts,
    transaction,
    get events() { return committed.events; },
    get jobs() { return committed.jobs; },
    /** Statements that wrote (not SELECT-only). */
    writes: () => stmts.filter((s) => /INSERT|UPDATE|DELETE|enqueue_job/i.test(s.text)),
    fail(match: RegExp, error: () => Error = () => new Error('injected')) { failures.push({ match, error }); },
  };
}

export type EventDb = ReturnType<typeof makeEventDb>;

export const ctxFor = (db: EventDb, over: Record<string, unknown> = {}) => ({
  tenantId: TENANT_A,
  actor: { type: 'user', id: USER, membershipId: MEMBERSHIP },
  requestId: REQ_ID,
  tx: db.tx,
  now: () => '2026-11-07T12:00:00.000Z',
  ports: {},
  ...over,
});

/** A payload that satisfies contracts/events/frontdesk.order.created.v1.schema.json. */
export const ORDER_ID = '0190a000-0000-7000-8000-0000000000d1';
export const orderCreatedPayload = (over: Record<string, unknown> = {}) => ({
  order_id: ORDER_ID,
  patient_id: PATIENT_ID,
  branch_id: '0190a000-0000-7000-8000-0000000000b1',
  centre_id: '0190a000-0000-7000-8000-0000000000c1',
  visit_type: 'opd',
  billing_mode: 'cash',
  priority: 'routine',
  collection_mode: 'walk_in',
  source: 'front_desk',
  registered_at: '2026-11-07T11:59:00.000Z',
  items: [{
    order_item_id: '0190a000-0000-7000-8000-0000000000e1',
    orderable_id: '0190a000-0000-7000-8000-0000000000e2',
    orderable_kind: 'test',
    test_ids: ['0190a000-0000-7000-8000-0000000000e3'],
    priority: 'routine',
  }],
  ...over,
});

export const publishInput = (over: Record<string, unknown> = {}) => ({
  aggregate: { type: 'order', id: ORDER_ID, seq: 1 },
  idempotencyKey: `${ORDER_ID}:created`,
  payload: orderCreatedPayload(),
  ...over,
});

export const EVENT = 'frontdesk.order.created.v1';

export function recorder() {
  const logs: Array<{ level: string; obj: any; msg?: string }> = [];
  const mk = (level: string) => (obj: any, msg?: string) => { logs.push({ level, obj, msg }); };
  const incs: Array<{ name: string; labels?: Record<string, string | number>; by: number }> = [];
  return {
    logs,
    incs,
    log: { debug: mk('debug'), info: mk('info'), warn: mk('warn'), error: mk('error') },
    metrics: {
      inc: (name: string, labels?: Record<string, string | number>, by = 1) => { incs.push({ name, labels, by }); },
      set: () => undefined,
      observe: () => undefined,
    },
    countOf: (name: string) => incs.filter((i) => i.name === name).length,
  };
}

export async function rejection(p: Promise<unknown>): Promise<any> {
  try { await p; } catch (e) { return e; }
  throw new Error('expected rejection, but it resolved');
}
