// Shared fixtures for the T0D-09 worker-core tests. Synthetic data only.
// An in-memory fake of the worker's Postgres connection with REAL transaction semantics (snapshot on BEGIN, restore on ROLLBACK,
// transactions serialised like a row lock would) and just enough SQL understanding for the statements the worker core may issue.
// Statements are matched by CONTENT (table / function names, values), never by SQL layout, except where the spec fixes a positional
// signature: app.enqueue_job(identifier, payload, job_key, run_at, max_attempts) and app.dl_insert_platform(8 args, 05-SCHEMA §10).
import { expect } from 'vitest';

export const TENANT_A = '0190a000-0000-7000-8000-00000000aaaa';
export const TENANT_B = '0190a000-0000-7000-8000-00000000bbbb';
export const TENANT_C = '0190a000-0000-7000-8000-00000000cccc';
export const TENANT_PROV = '0190a000-0000-7000-8000-00000000d001';
export const TENANT_OFF = '0190a000-0000-7000-8000-00000000d002';
export const CORE_ACTOR = '0190a000-0000-7000-8000-0000000c0000';
export const EVENT_ID = '0190a000-0000-7000-8000-00000000e001';
export const ORDER_ID = '0190a000-0000-7000-8000-00000000f001';
export const PATIENT_ID = '0190a000-0000-7000-8000-00000000ba7e';
export const UUIDV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const FIXED_NOW = new Date('2026-11-07T12:00:30.000Z');
export const OCCURRED_AT = '2026-11-07T12:00:00.000Z';
export const ORDER_CREATED = 'frontdesk.order.created.v1';
/** PHI-ish sentinel placed in job payloads / error messages: must never reach a log line or a metric label. */
export const PHI = 'SENTINEL-PHI-Sita-Karki';

const MODULE_INDEX = ['core', 'identity', 'audit', 'catalog', 'frontdesk', 'billing', 'lab', 'instruments', 'reporting', 'analytics',
  'quality', 'micro', 'anatomic', 'inventory', 'partners', 'smartreport', 'payments', 'engagement', 'homecollection'];
export const systemActorOf = (m: string): string => `0190a000-0000-7000-8000-0000000a${String(MODULE_INDEX.indexOf(m) + 1).padStart(4, '0')}`;

export const pgError = (code: string, message = `pg ${code}`) => Object.assign(new Error(message), { code });

export function orderCreatedEnvelope(over: Record<string, unknown> = {}, payloadOver: Record<string, unknown> = {}): any {
  return {
    event_id: EVENT_ID, event_type: ORDER_CREATED, tenant_id: TENANT_A, occurred_at: OCCURRED_AT,
    actor: { type: 'user', id: '0190a000-0000-7000-8000-00000000a001' },
    idempotency_key: 'order-created-1', producer: 'frontdesk',
    aggregate: { type: 'order', id: ORDER_ID, seq: 1 },
    request_id: '0190a000-0000-7000-8000-0000000000f1',
    payload: {
      order_id: ORDER_ID, patient_id: PATIENT_ID, branch_id: '0190a000-0000-7000-8000-00000000b001',
      centre_id: '0190a000-0000-7000-8000-00000000c001', visit_type: 'opd', billing_mode: 'cash', priority: 'routine',
      collection_mode: 'walk_in', source: 'front_desk', registered_at: OCCURRED_AT,
      items: [{ order_item_id: '0190a000-0000-7000-8000-00000000d101', orderable_id: '0190a000-0000-7000-8000-00000000d102',
        orderable_kind: 'test', test_ids: ['0190a000-0000-7000-8000-00000000d103'], priority: 'routine' }],
      ...payloadOver,
    },
    ...over,
  };
}

// ---------------------------------------------------------------------------------------------------- doubles
export function makeMetrics() {
  const calls: Array<{ kind: 'inc' | 'set' | 'observe'; name: string; labels: Record<string, unknown>; value: number }> = [];
  const rec = (kind: 'inc' | 'set' | 'observe') => (name: string, a?: any, b?: any) => {
    // inc(name, labels?, by?) | set(name, value, labels?) | observe(name, value, labels?)
    if (kind === 'inc') calls.push({ kind, name, labels: a ?? {}, value: b ?? 1 });
    else calls.push({ kind, name, labels: b ?? {}, value: a });
  };
  const match = (c: { labels: Record<string, unknown> }, labels: Record<string, unknown>) => Object.entries(labels).every(([k, v]) => c.labels[k] === v);
  return {
    calls, inc: rec('inc'), set: rec('set'), observe: rec('observe'),
    /** Sum of inc() values for name whose labels contain `labels`. */
    total: (name: string, labels: Record<string, unknown> = {}) => calls.filter((c) => c.kind === 'inc' && c.name === name && match(c, labels)).reduce((s, c) => s + c.value, 0),
    last: (kind: 'set' | 'observe', name: string, labels: Record<string, unknown> = {}) => [...calls].reverse().find((c) => c.kind === kind && c.name === name && match(c, labels)),
  };
}

export function makeLog() {
  const lines: Array<{ level: string; args: unknown[] }> = [];
  const log: any = {};
  for (const level of ['debug', 'info', 'warn', 'error']) log[level] = (...args: unknown[]) => { lines.push({ level, args }); };
  log.child = () => log;
  const safe = (v: unknown) => { try { return JSON.stringify(v, (_k, x) => (x instanceof Error ? { name: x.name, message: x.message, stack: x.stack } : x)); } catch { return String(v); } };
  return { log, lines, text: () => lines.map((l) => safe(l.args)).join('\n'), has: (name: string) => lines.some((l) => safe(l.args).includes(name)) };
}

/** Fault-injectable clock for the purge simulation (D-200): time advances 10 ms per batch; `jumpAfter` adds a big jump. */
export function makeSimClock() {
  let ms = 0;
  const batches: Record<string, number> = {};
  const faults: Array<{ table: string; afterBatches: number; jumpMs: number }> = [];
  return {
    now: () => ms,
    jumpAfter(table: string, afterBatches: number, jumpMs: number) { faults.push({ table, afterBatches, jumpMs }); },
    clearFaults() { faults.length = 0; },
    tick(table: string) {
      batches[table] = (batches[table] ?? 0) + 1;
      ms += 10;
      for (const f of faults) if (f.table === table && batches[table] === f.afterBatches) ms += f.jumpMs;
    },
  };
}

export const PURGE_TABLES = ['idempotency_keys', 'event_log', 'event_inboxes', 'dead_letters', 'ratelimit_counters'] as const;
export const CAP_MS = 4 * 60 * 1000;
const BATCH = 1000;

// ---------------------------------------------------------------------------------------------------- the world
export interface Tenant { id: string; status: 'provisioning' | 'active' | 'suspended' | 'offboarded' }
export interface JobRow { identifier: string; payload: any; jobKey: string | null; maxAttempts: number | null; claims: any; txId: number }
export interface TxRec { id: number; claims0: any; statementTimeoutMs: number | undefined; operation: string | undefined; outcome: 'open' | 'commit' | 'rollback'; stmts: Array<{ text: string; values: unknown[]; claims: any }> }

export function makeWorld(opts: { clock?: ReturnType<typeof makeSimClock> } = {}) {
  const clock = opts.clock ?? makeSimClock();
  let state = {
    eventLog: [] as Array<{ tenant_id: string; event_id: string; event_type: string; envelope: any }>,
    inbox: [] as Array<{ module: string; tenant_id: string; event_id: string }>,
    jobs: [] as JobRow[],
    deadLetters: [] as any[],
    writes: [] as Array<{ text: string; values: unknown[]; claims: any }>,
    tenants: [] as Tenant[],
    purge: {} as Record<string, number>,
    registry: {} as Record<string, { scope: string; active: boolean }>,
  };
  const txLog: TxRec[] = [];
  const failures: Array<{ match: RegExp; error: () => Error; when?: (claims: any, values: unknown[]) => boolean; times: number }> = [];
  const purgeThrows: Record<string, () => Error> = {};
  let queueDepth: Array<{ task_identifier: string; ready: number; locked: number; failed: number }> = [];
  let lock: Promise<unknown> = Promise.resolve();
  let nextTx = 1;

  function query(rec: TxRec, tx: { claims: any }, text: string, values: unknown[] = []) {
    const t = text.replace(/\s+/g, ' ').trim();
    rec.stmts.push({ text: t, values, claims: tx.claims });
    for (const f of failures) {
      if (f.times > 0 && f.match.test(t) && (!f.when || f.when(tx.claims, values))) { f.times -= 1; throw f.error(); }
    }
    const claimTenant = tx.claims?.tenant_id as string | undefined;
    const rls = (tenantId: unknown) => {
      if (claimTenant !== tenantId) throw pgError('42501', 'new row violates row-level security policy');
    };

    let m: RegExpExecArray | null;
    if (/app\.enqueue_job/i.test(t)) {
      const [identifier, rawPayload, jobKey] = values as [string, unknown, string | null];
      const payload = typeof rawPayload === 'string' ? JSON.parse(rawPayload) : rawPayload;
      const reg = state.registry[identifier];
      if (!reg || !reg.active) throw Object.assign(pgError('P0001', 'unknown_task_identifier'), { message: 'unknown_task_identifier' });
      if (reg.scope === 'per_tenant' && (claimTenant === undefined || payload?.tenant_id !== claimTenant)) {
        throw Object.assign(pgError('P0001', 'job_tenant_mismatch'), { message: 'job_tenant_mismatch' });
      }
      const maxAttempts = (values.find((v, i) => i >= 3 && typeof v === 'number') as number | undefined) ?? null;
      // unsafe_dedupe (02-TRD §7.3): an existing job with the same key is left untouched.
      if (jobKey && state.jobs.some((j) => j.identifier === identifier && j.jobKey === jobKey)) return { rows: [{ enqueue_job: null }] };
      state.jobs.push({ identifier, payload, jobKey: jobKey ?? null, maxAttempts, claims: { ...tx.claims }, txId: rec.id });
      return { rows: [{ enqueue_job: null }] };
    }
    if (/app\.cron_tenant_ids/i.test(t)) {
      const rows = state.tenants.filter((x) => x.status === 'active' || x.status === 'suspended').map((x) => ({ cron_tenant_ids: x.id, id: x.id, tenant_id: x.id }));
      return { rows };
    }
    if (/app\.queue_depth/i.test(t)) return { rows: queueDepth };
    if (/app\.dl_insert_platform/i.test(t)) {
      if (values.length !== 8) throw new Error(`fake: app.dl_insert_platform expects its 8 positional arguments (05-SCHEMA §10), got ${values.length}`);
      const [id, task, payload, code, msg, attempts, firstFailedAt, jobKey] = values as any[];
      if (state.registry[task]?.scope === 'per_tenant') throw Object.assign(pgError('P0001', 'job_tenant_mismatch'), { message: 'job_tenant_mismatch' });
      state.deadLetters.push({ id, tenant_id: null, task_identifier: task, job_payload: typeof payload === 'string' ? JSON.parse(payload) : payload,
        last_error_code: code, last_error_message_redacted: msg, attempts, first_failed_at: firstFailedAt, dead_at: FIXED_NOW, state: 'open', version: 1,
        job_key: jobKey ?? null, via: 'dl_insert_platform', claims: { ...tx.claims } });
      return { rows: [] };
    }
    if ((m = /app\.purge_(\w+)\s*\(/i.exec(t))) {
      const table = m[1]!;
      if (purgeThrows[table]) throw purgeThrows[table]!();
      const start = clock.now();
      let deleted = 0; let capped = false;
      while ((state.purge[table] ?? 0) > 0) {
        if (clock.now() - start > CAP_MS) { capped = true; break; }
        const n = Math.min(BATCH, state.purge[table]!);
        state.purge[table]! -= n; deleted += n;
        clock.tick(table);
      }
      return { rows: [{ deleted, capped }] };
    }
    if (/INSERT\s+INTO\s+core\.dead_letters/i.test(t)) {
      const cols = /\(([^)]*)\)\s*VALUES\s*\(([^)]*)\)/i.exec(t);
      if (!cols) throw new Error('fake: INSERT INTO core.dead_letters needs an explicit column list and VALUES');
      const names = cols[1]!.split(',').map((s) => s.trim());
      const exprs = cols[2]!.split(',').map((s) => s.trim());
      const row: any = { state: 'open', version: 1, job_key: null, via: 'insert', claims: { ...tx.claims } };
      names.forEach((n, i) => {
        const e = exprs[i]!; const p = /^\$(\d+)/.exec(e);
        if (p) row[n] = values[Number(p[1]) - 1];
        else if (/^now\(\)/i.test(e)) row[n] = FIXED_NOW;
        else if (/^'(.*)'$/.test(e)) row[n] = e.slice(1, -1);
      });
      if (typeof row.job_payload === 'string') row.job_payload = JSON.parse(row.job_payload);
      rls(row.tenant_id);
      row.dead_at ??= FIXED_NOW;
      state.deadLetters.push(row);
      return { rows: [{ id: row.id }] };
    }
    if ((m = /INSERT\s+INTO\s+(\w+)\.event_inbox/i.exec(t))) {
      const eventId = values.find((v) => typeof v === 'string' && (state.eventLog.some((e) => e.event_id === v) || v === EVENT_ID)) as string | undefined;
      const tenantId = values.find((v) => v === TENANT_A || v === TENANT_B || v === TENANT_C) as string | undefined;
      if (!eventId || !tenantId) throw new Error('fake: event_inbox INSERT without (tenant_id, event_id) values');
      rls(tenantId);
      if (state.inbox.some((r) => r.module === m![1] && r.tenant_id === tenantId && r.event_id === eventId)) {
        if (!/ON\s+CONFLICT[\s\S]*DO\s+NOTHING/i.test(t)) throw pgError('23505', 'duplicate key value violates unique constraint');
        return { rows: [] };
      }
      state.inbox.push({ module: m[1]!, tenant_id: tenantId, event_id: eventId });
      return { rows: [{ event_id: eventId }] };
    }
    if (/^SELECT[\s\S]*FROM\s+core\.event_log/i.test(t)) {
      const hit = state.eventLog.find((e) => values.includes(e.tenant_id) && values.includes(e.event_id));
      if (!hit || hit.tenant_id !== claimTenant) return { rows: [] };      // RLS: __select__tenant
      return { rows: [{ event_id: hit.event_id, tenant_id: hit.tenant_id, event_type: hit.event_type, envelope: structuredClone(hit.envelope), occurred_at: hit.envelope.occurred_at }] };
    }
    if (/INSERT\s+INTO\s+\w+\.\w+/i.test(t) || /UPDATE\s+\w+\.\w+/i.test(t)) {
      state.writes.push({ text: t, values, claims: { ...tx.claims } });
      return { rows: [] };
    }
    return { rows: [] };                                                    // BEGIN / set_config / SAVEPOINT / ...
  }

  /** db.tx(input, fn): the worker core's transaction seam (assumed shape, see T0D-09-tests.md). */
  const db = {
    async tx<T>(input: { claims: any; statementTimeoutMs?: number; operation?: string }, fn: (tx: any) => Promise<T>): Promise<T> {
      const prev = lock; let release!: () => void;
      lock = new Promise<void>((r) => { release = r; });
      await prev;
      const snapshot = structuredClone(state);
      const rec: TxRec = { id: nextTx++, claims0: { ...input.claims }, statementTimeoutMs: input.statementTimeoutMs, operation: input.operation, outcome: 'open', stmts: [] };
      txLog.push(rec);
      const tx: any = { claims: { ...input.claims }, startedAt: FIXED_NOW, operation: { module: 'core', operationId: input.operation ?? 'job', context: 'tenant' } };
      tx.query = async (text: string, values?: unknown[]) => query(rec, tx, text, values);
      tx.savepoint = async (f: (t: unknown) => Promise<unknown>) => f(tx);
      try {
        const out = await fn(tx);
        rec.outcome = 'commit';
        return out;
      } catch (e) {
        state = snapshot; rec.outcome = 'rollback';
        throw e;
      } finally { release(); }
    },
  };

  /** Core-internal 4-arg withTenantScope (08 A23.2): swaps the claims on the open transaction for the callback. */
  const withTenantScope = async <T>(tx: any, tenantId: string, systemActorId: string, fn: () => Promise<T>): Promise<T> => {
    const prev = tx.claims;
    tx.claims = { sub: systemActorId, tenant_id: tenantId, actor_type: 'system' };
    try { return await fn(); } finally { tx.claims = prev; }
  };

  return {
    clock, db, withTenantScope, txLog,
    get jobs() { return state.jobs; },
    get inbox() { return state.inbox; },
    get deadLetters() { return state.deadLetters; },
    get writes() { return state.writes; },
    get purge() { return state.purge; },
    seedEvent(envelope: any) { state.eventLog.push({ tenant_id: envelope.tenant_id, event_id: envelope.event_id, event_type: envelope.event_type, envelope: structuredClone(envelope) }); },
    seedTenants(ts: Tenant[]) { state.tenants = ts; },
    seedPurge(table: string, rows: number) { state.purge[table] = rows; },
    setQueueDepth(rows: typeof queueDepth) { queueDepth = rows; },
    loadRegistry(entries: any[]) {
      state.registry = {};
      for (const e of entries) state.registry[e.identifier] = { scope: e.scope, active: e.isActive ?? e.is_active ?? true };
    },
    failOn(match: RegExp, error: () => Error, o: { times?: number; when?: (claims: any, values: unknown[]) => boolean } = {}) {
      failures.push({ match, error, ...(o.when ? { when: o.when } : {}), times: o.times ?? Infinity });
    },
    failPurge(table: string, error: () => Error) { purgeThrows[table] = error; },
    stmtsMatching: (re: RegExp) => txLog.flatMap((t) => t.stmts).filter((s) => re.test(s.text)),
  };
}
export type World = ReturnType<typeof makeWorld>;

// ---------------------------------------------------------------------------------------------------- setup
export interface Setup { world: World; metrics: ReturnType<typeof makeMetrics>; logs: ReturnType<typeof makeLog>; deps: any; built: any;
  /** Runs the task as Graphile Worker would: task(payload, helpers). */
  run(identifier: string, payload: unknown, job?: { id?: string; key?: string | null; attempts?: number; maxAttempts?: number }): Promise<void>;
  entry(identifier: string): any }

function makeDeps(world: World, metrics: ReturnType<typeof makeMetrics>, logs: ReturnType<typeof makeLog>) {
  return {
    db: world.db, withTenantScope: world.withTenantScope, systemActorOf, coreActorId: CORE_ACTOR, metrics, log: logs.log, now: () => FIXED_NOW,
    events: { publish: async () => ({ eventId: EVENT_ID, duplicate: false }) }, core: { deadLetters: {} }, storage: { read: async () => Buffer.alloc(0) },
    files: { scan: async () => ({ clean: true }) }, audit: { access: async () => undefined },
  };
}

export async function setup(manifests: any[], o: { clock?: ReturnType<typeof makeSimClock> } = {}): Promise<Setup> {
  const { buildTaskList } = await import('../tasklist.js');
  const world = makeWorld(o.clock ? { clock: o.clock } : {});
  const metrics = makeMetrics();
  const logs = makeLog();
  const deps = makeDeps(world, metrics, logs);
  const built: any = await buildTaskList(deps, manifests);
  world.loadRegistry(built.registry);
  const entry = (identifier: string) => built.registry.find((e: any) => e.identifier === identifier);
  let jobSeq = 0;
  const run: Setup['run'] = async (identifier, payload, job = {}) => {
    const task = built.taskList[identifier];
    if (typeof task !== 'function') throw new Error(`no task ${identifier} in taskList (${Object.keys(built.taskList).join(', ')})`);
    const max = job.maxAttempts ?? entry(identifier)?.maxAttempts ?? entry(identifier)?.max_attempts ?? 25;
    const jobRow = { id: job.id ?? String(++jobSeq), key: job.key ?? null, attempts: job.attempts ?? 1, max_attempts: max, task_identifier: identifier, created_at: new Date(FIXED_NOW.getTime() - 60_000) };
    await task(payload, { job: jobRow, logger: logs.log, abortSignal: undefined });
  };
  return { world, metrics, logs, deps, built, run, entry };
}

export const evtId = (module: string, type: string = ORDER_CREATED) => `evt.${module}.${type}`;

/** The vitest rejection helper: awaiting `p` must reject (any error). */
export async function rejects(p: Promise<unknown>): Promise<any> {
  try { await p; } catch (e) { return e; }
  expect.unreachable('expected the promise to reject');
}

/** buildTaskList(manifests) must reject. The module import is OUTSIDE the rejection check, so a missing module fails the test (not passes it). */
export async function rejectsBuild(manifests: any[]): Promise<any> {
  const { buildTaskList } = await import('../tasklist.js');
  const world = makeWorld(); const deps = makeDeps(world, makeMetrics(), makeLog());
  return rejects(Promise.resolve().then(() => buildTaskList(deps, manifests)));
}
