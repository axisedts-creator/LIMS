// T-03 (C3) test fixture: an in-memory fake of Postgres for catalog.catalog_state / catalog.orderables / core.event_log,
// with REAL transaction semantics that matter for AC-19.3:
//   - row lock on the tenant's catalog_state row (SELECT … FOR UPDATE and UPDATE take it; held until COMMIT/ROLLBACK; others queue)
//   - READ COMMITTED: a plain SELECT sees the last committed value (so read-then-write without the lock loses updates)
//   - writes are private to the transaction until COMMIT; ROLLBACK discards them
//   - every query yields to the event loop first, so concurrent writers really interleave
//   - bigint columns come back as STRINGS, like node-pg does for int8
//   - RLS: every statement is scoped to the transaction's tenant (as app.current_tenant_id() would)
//   - catalog.tg_revision_monotonic: an UPDATE that lowers catalog_revision raises P0001 'immutable_row'
// Statements are recognised by content, not position. Supported (anything else throws "fake: unsupported SQL"):
//   INSERT INTO catalog.catalog_state …            (lazy create; ON CONFLICT DO NOTHING; first uuid bind that is not tenant/actor = root id)
//   SELECT … FROM catalog.catalog_state [FOR UPDATE]
//   UPDATE catalog.catalog_state SET catalog_revision = catalog_revision + 1 | = $n  … [RETURNING catalog_revision, catalog_root_id]
//   UPDATE catalog.orderables SET revision = $n … WHERE id = $m   (revision and id passed as bind values)
//   INSERT INTO core.event_log / SELECT … FROM core.event_log / app.enqueue_job      (as core/events/__tests__/helpers.ts)
// Synthetic data only.
export const TENANT_A = '0190a000-0000-7000-8000-00000000aaaa';
export const TENANT_B = '0190a000-0000-7000-8000-00000000bbbb';
export const USER = '0190a000-0000-7000-8000-00000000a001';
export const REQ_ID = '0190a000-0000-7000-8000-0000000000f1';
export const STARTED_AT = new Date(Date.UTC(2026, 10, 7, 12, 0, 0, 123));
export const UUIDV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const V7 = (n: string) => `01a1a98a-ac40-7000-8000-${n}`;
export const ROOT_A = V7('00000000c3a0');
export const ROOT_B = V7('00000000c3b0');

export interface Stmt { readonly txId: number; readonly tenantId: string; readonly text: string; readonly values: readonly unknown[] }
interface StateRow { rootId: string; rev: number; seen: number; createdBy?: string }
interface EventRow { tenantId: string; eventType: string; key: string; eventId: string; envelope: any }
interface Orderable { tenantId: string; revision: number }

const pgError = (code: string, message: string) => Object.assign(new Error(message), { code });
const tick = () => new Promise<void>((r) => setImmediate(r));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class RowLock {
  owner: number | undefined;
  private readonly q: Array<{ id: number; go: () => void }> = [];
  async acquire(id: number): Promise<void> {
    if (this.owner === id) return;
    if (this.owner === undefined) { this.owner = id; return; }
    await new Promise<void>((go) => this.q.push({ id, go }));
  }
  release(id: number): void {
    if (this.owner !== id) return;
    const next = this.q.shift();
    this.owner = next?.id;
    next?.go();
  }
}

export function makeCatalogDb(seed: { state?: Record<string, { rootId: string; revision: number; globalReleaseSeen?: number }>; orderables?: Record<string, { tenantId: string; revision: number }> } = {}) {
  const state = new Map<string, StateRow>();
  for (const [t, s] of Object.entries(seed.state ?? {})) state.set(t, { rootId: s.rootId, rev: s.revision, seen: s.globalReleaseSeen ?? 0 });
  const orderables = new Map<string, Orderable>(Object.entries(seed.orderables ?? {}).map(([id, o]) => [id, { ...o }]));
  const events: EventRow[] = [];
  const jobs: Array<{ text: string; values: readonly unknown[] }> = [];
  const locks = new Map<string, RowLock>();
  const stmts: Stmt[] = [];
  const commitLog: Array<{ txId: number; tenantId: string; revisions: Record<string, number> }> = [];
  const failures: Array<{ match: RegExp; make: () => Error }> = [];
  let nextTx = 1;
  const lockOf = (t: string) => { let l = locks.get(t); if (!l) locks.set(t, (l = new RowLock())); return l; };

  /** Opens one transaction scoped to `tenantId`. */
  function begin(tenantId: string, actorId = USER) {
    const id = nextTx++;
    const local = {
      state: new Map<string, StateRow>(), orderables: new Map<string, Orderable>(),
      events: [] as EventRow[], jobs: [] as Array<{ text: string; values: readonly unknown[] }>,
    };
    const held = new Set<string>();
    const cur = () => local.state.get(tenantId) ?? state.get(tenantId);
    const take = async () => { await lockOf(tenantId).acquire(id); held.add(tenantId); };
    const releaseAll = () => { for (const t of held) lockOf(t).release(id); held.clear(); };

    const facade = {
      startedAt: STARTED_AT,
      operation: { module: 'catalog', operationId: 'fake', context: 'tenant' },
      async query(text: string, values: unknown[] = []): Promise<{ rows: any[] }> {
        await tick();
        stmts.push({ txId: id, tenantId, text, values });
        const f = failures.find((x) => x.match.test(text));
        if (f) throw f.make();
        const t = text.replace(/\s+/g, ' ').trim();

        if (/INSERT INTO catalog\.catalog_state/i.test(t)) {
          if (cur()) return { rows: [] };
          const wasHeld = held.has(tenantId);
          await take();                                    // waits for another transaction's uncommitted insert
          if (state.has(tenantId)) { if (!wasHeld) { lockOf(tenantId).release(id); held.delete(tenantId); } return { rows: [] }; }
          const rootId = values.find((v): v is string => typeof v === 'string' && UUID.test(v) && v !== tenantId && v !== actorId) ?? 'no-root-id-bound';
          local.state.set(tenantId, { rootId, rev: 0, seen: 0, createdBy: values.includes(actorId) ? actorId : undefined });
          return { rows: [{ tenant_id: tenantId }] };
        }
        if (/FROM catalog\.catalog_state/i.test(t) && /^SELECT/i.test(t)) {
          if (/FOR UPDATE/i.test(t)) await take();
          const s = cur();
          return { rows: s ? [{ tenant_id: tenantId, catalog_root_id: s.rootId, catalog_revision: String(s.rev), global_release_seen: s.seen }] : [] };
        }
        if (/^UPDATE catalog\.catalog_state/i.test(t)) {
          await take();                                    // UPDATE always row-locks (as Postgres does)
          const s = cur();
          if (!s) return { rows: [] };
          let next: number;
          const abs = /catalog_revision\s*=\s*\$(\d+)/i.exec(t);
          if (/catalog_revision\s*=\s*catalog_revision\s*\+\s*1/i.test(t)) next = s.rev + 1;
          else if (abs) next = Number(values[Number(abs[1]) - 1]);
          else throw new Error(`fake: unsupported catalog_state UPDATE: ${t}`);
          if (!Number.isFinite(next)) throw new Error('fake: non-numeric catalog_revision bind');
          if (next < s.rev) throw pgError('P0001', 'immutable_row');
          local.state.set(tenantId, { ...s, rev: next });
          return { rows: /RETURNING/i.test(t) ? [{ catalog_revision: String(next), catalog_root_id: s.rootId, tenant_id: tenantId }] : [] };
        }
        if (/^UPDATE catalog\.orderables/i.test(t)) {
          const oid = values.find((v): v is string => typeof v === 'string' && orderables.has(v) && orderables.get(v)!.tenantId === tenantId);
          const rev = values.find((v) => typeof v === 'number' || (typeof v === 'string' && /^\d+$/.test(v)));
          if (rev === undefined) throw new Error('fake: orderables UPDATE must bind the new revision as a value');
          if (oid === undefined) return { rows: [] };      // RLS hides other tenants' rows; unknown ids match nothing
          local.orderables.set(oid, { tenantId, revision: Number(rev) });
          return { rows: [{ id: oid }] };
        }
        if (/INSERT INTO core\.event_log/i.test(t)) {
          const env = values.map((v) => (typeof v === 'string' && v.startsWith('{') ? safeJson(v) : v))
            .find((v) => v && typeof v === 'object' && !(v instanceof Date) && 'event_id' in (v as object)) as any;
          if (!env) throw new Error('fake: event_log INSERT without envelope');
          const all = [...events, ...local.events];
          if (all.some((e) => e.tenantId === env.tenant_id && e.eventType === env.event_type && e.key === env.idempotency_key)) {
            if (!/ON CONFLICT[\s\S]*DO NOTHING/i.test(t)) throw pgError('23505', 'duplicate key');
            return { rows: [] };
          }
          local.events.push({ tenantId: env.tenant_id, eventType: env.event_type, key: env.idempotency_key, eventId: env.event_id, envelope: env });
          return { rows: [{ event_id: env.event_id }] };
        }
        if (/FROM core\.event_log/i.test(t)) {
          const hit = [...events, ...local.events].find((e) => values.includes(e.tenantId) && values.includes(e.eventType) && values.includes(e.key));
          return { rows: hit ? [{ event_id: hit.eventId }] : [] };
        }
        if (/app\.enqueue_job/i.test(t)) { local.jobs.push({ text, values }); return { rows: [{ enqueue_job: null }] }; }
        throw new Error(`fake: unsupported SQL: ${t.slice(0, 160)}`);
      },
      savepoint: async <T>(fn: (t: unknown) => Promise<T>) => fn(facade),
    };

    return {
      id, tenantId, actorId, facade,
      commit() {
        for (const [t, s] of local.state) state.set(t, s);
        for (const [k, o] of local.orderables) orderables.set(k, o);
        events.push(...local.events); jobs.push(...local.jobs);
        commitLog.push({ txId: id, tenantId, revisions: Object.fromEntries([...state].map(([t, s]) => [t, s.rev])) });
        releaseAll();
      },
      rollback() { releaseAll(); },
    };
  }

  type Tx = ReturnType<typeof begin>;
  const ctxFor = (tx: Tx, over: Record<string, unknown> = {}) => ({
    tenantId: tx.tenantId,
    actor: { type: 'user', id: tx.actorId },
    requestId: REQ_ID,
    tx: tx.facade,
    now: () => '2026-11-07T12:00:00.000Z',
    ports: {},
    ...over,
  });

  /** One transaction: COMMIT when fn resolves (and `rollback` is not set), ROLLBACK when it rejects. */
  async function run<T>(fn: (ctx: ReturnType<typeof ctxFor>) => Promise<T>, o: { tenantId?: string; rollback?: boolean; actorId?: string } = {}): Promise<T> {
    const tx = begin(o.tenantId ?? TENANT_A, o.actorId ?? USER);
    try {
      const out = await fn(ctxFor(tx));
      if (o.rollback) throw new Error('forced rollback');
      tx.commit();
      return out;
    } catch (e) { tx.rollback(); throw e; }
  }

  return {
    run, begin, ctxFor, stmts, commitLog,
    get events() { return events; },
    get jobs() { return jobs; },
    revisionOf: (t: string) => state.get(t)?.rev,
    rootOf: (t: string) => state.get(t)?.rootId,
    createdByOf: (t: string) => state.get(t)?.createdBy,
    orderableRevision: (id: string) => orderables.get(id)?.revision,
    hasState: (t: string) => state.has(t),
    fail(match: RegExp, make: () => Error = () => new Error('injected')) { failures.push({ match, make }); },
  };
}
export type CatalogDb = ReturnType<typeof makeCatalogDb>;

function safeJson(s: string): unknown { try { return JSON.parse(s); } catch { return s; } }
