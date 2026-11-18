// T0B-SYNC-2 helpers (not a test). Builds on ./helpers.ts (real PG17, tenant_a / tenant_b, users, a HandlerContext over a REAL request tx under RLS).
// MODULE SURFACE PINNED FOR THE WRITER (see .orchestra/notes/T0B-SYNC-2-tests.md; every item may be overruled by the lead/arbiter, then the tests follow):
//   services/api/src/core/sync/index.ts keeps `syncHandlers` / `createSyncHandlers` = the 7 part 1 operations (T0B-SYNC-1 tests stay valid) and ADDS
//     `syncPart2Handlers` and `createSyncPart2Handlers(deps?: { settings?: Partial<SyncSettings & Part2Settings>; adapters?: readonly SyncAdapter[] })`
//     = pushSyncBatch, pullChanges, listSyncConflicts, getSyncConflict, resolveSyncConflict. bootstrap merges both over the health handlers.
//   Each `adapters` entry replaces the default adapter of its opType (default = none: every op type answers sync.op_type_not_available until T0B-SYNC-3/4).
//   interface SyncAdapter { opType: string; permission: string;                      // permission = the wrapped operation's x-permission, asserted per operation at sync time
//     validate(payload: unknown): void;                                                // throws LimsError (closed code) when the payload is invalid; runs before any write
//     conflictCheck?(ctx, op): Promise<undefined | { entityType: string; serverPayload: object }>;   // stale base_version etc.; undefined = no conflict
//     currentServerPayload?(ctx, { entityId }): Promise<object>;                       // the server version now; compared with the conflict's stored server_payload at resolve (sync.entity_changed)
//     applyResolution?(ctx, { resolution: 'apply_local'|'merge', opId, entityId, entityType, payload, idempotencyKey (= conflict id) }): Promise<unknown>;   // the same domain rules as an online edit
//     execute(ctx, op): Promise<{ entityId?: string; numberMappings?: Array<{ document_type: 'bill'|'invoice'|'receipt'; provisional_number: string; final_number: string }> }>;
//   }  where op = { opId, opType, entityId?, baseVersion?, payload, deviceCreatedAt, idempotencyKey (= opId) } and ctx is the per operation HandlerContext
//   (same tx, a SAVEPOINT made with ctx.db.tx; ctx.actor is the authenticated user).
//   Per operation the engine: (1) ledger lookup by (tenant, op_id) -> duplicate / sync.op_id_reused; (2) device clock skew; (3) adapter lookup (sync.op_type_not_available);
//   (4) IdentityPort.assertRole(adapter.permission) NOW; (5) validate; (6) conflictCheck; (7) execute inside the savepoint; and writes the ledger row (core.sync_operation).
//   Metrics (ctx.metrics.inc / set): lims_core_sync_operations_total{status} per operation, lims_core_sync_batches_total{outcome}, lims_core_sync_oldest_unsynced_age_seconds{tenant_id} set by getSyncStatus.
import { afterAll } from 'vitest';
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { LimsError } from '../../errors.js';
import { createSyncPart2Handlers, syncPart2Handlers } from '../index.js';
import { A1, TENANT_A, USER, ownerRows, superTx, uid, type Outcome, type Reply, type Tx, type Who } from './helpers.js';

export { createSyncPart2Handlers, syncPart2Handlers };
export * from './helpers.js';

const pgModule = 'pg';
const { default: pg } = (await import(pgModule)) as any;
const need = (k: string): string => { const v = process.env[k]; if (!v) throw new Error(`${k} is not set: run .orchestra\\notes\\T0B-SYNC-2-verify.cmd`); return v; };
const appPool = new pg.Pool({ connectionString: need('LIMS_TEST_APP_URL'), max: 60 });
const supPool = new pg.Pool({ connectionString: need('LIMS_TEST_SUPER_URL'), max: 4 });
export const closePools = async (): Promise<void> => { await appPool.end().catch(() => {}); await supPool.end().catch(() => {}); };
afterAll(closePools, 60_000);

// ---- the effect table the test adapters write to (so a rolled back operation leaves NO trace: proves one transaction per operation)
let effectTable = false;
export async function ensureEffectTable(): Promise<void> {
  if (effectTable) return;
  const c = await supPool.connect();
  try {
    await c.query('CREATE SCHEMA IF NOT EXISTS sync2_test');
    await c.query(`CREATE TABLE IF NOT EXISTS sync2_test.effect (n bigserial PRIMARY KEY, tenant_id uuid NOT NULL, op_id uuid NOT NULL, op_type text NOT NULL, entity_id uuid,
      actor_id uuid, idempotency_key uuid, tag text, at timestamptz NOT NULL DEFAULT clock_timestamp())`);
    await c.query('GRANT USAGE ON SCHEMA sync2_test TO PUBLIC; GRANT ALL ON ALL TABLES IN SCHEMA sync2_test TO PUBLIC; GRANT ALL ON ALL SEQUENCES IN SCHEMA sync2_test TO PUBLIC');
  } finally { c.release(); }
  effectTable = true;
}
export const effects = (opIds: string[]): Promise<any[]> => ownerRows('SELECT * FROM sync2_test.effect WHERE op_id = ANY($1::uuid[]) ORDER BY n', [opIds]);

// ---- payload switches understood by the test adapter (payloads are plain JSON objects; nothing here is a real domain payload)
//   { tag }                    stored in the effect row (a "value")
//   { fail: '<code>' }         execute throws LimsError(code) AFTER writing its effect row (the row must be rolled back)
//   { boom: true }             execute throws a plain Error (an unexpected bug): the operation is rejected common.internal, the batch goes on, nothing leaks
//   { invalid: true }          validate throws common.validation_failed
//   { conflict: true }         conflictCheck reports a conflict with server payload { status: 'verified', version: 4 }
//   { hold: '<name>' }         execute waits until gate('<name>') is opened (used to hold a batch in flight)
//   { numbers: true }          execute returns a provisional -> final number mapping for a receipt
const gates = new Map<string, { promise: Promise<void>; open: () => void }>();
export function gate(name: string): { promise: Promise<void>; open: () => void } {
  let g = gates.get(name);
  if (!g) { let open!: () => void; const promise = new Promise<void>((r) => { open = r; }); g = { promise, open }; gates.set(name, g); }
  return g;
}
export const entered: string[] = [];   // op ids whose execute started (in start order)
export const serverStates = new Map<string, object>();   // entityId -> the server payload the test adapter reports now (default { status: 'verified', version: 4 })

export function testAdapter(opType: string, permission: string): any {
  return {
    opType, permission,
    validate(payload: any) { if (payload?.invalid === true) throw new LimsError('common.validation_failed'); },
    async conflictCheck(_ctx: any, op: any) { return op.payload?.conflict === true ? { entityType: 'result', serverPayload: { status: 'verified', version: 4 } } : undefined; },
    // conflict resolution hooks (resolveSyncConflict): apply_local / merge go through the adapter = the same domain rules as an online edit;
    // currentServerPayload(ctx, { entityId }) is compared with the server_payload stored in the conflict (a difference = sync.entity_changed).
    async currentServerPayload(_ctx: any, input: { entityId: string }) { return serverStates.get(input.entityId) ?? { status: 'verified', version: 4 }; },
    async applyResolution(ctx: any, input: { resolution: string; opId: string; entityId: string; entityType: string; payload: any; idempotencyKey: string }) {
      await ctx.tx.query(`INSERT INTO sync2_test.effect (tenant_id, op_id, op_type, entity_id, actor_id, idempotency_key, tag) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [ctx.tenantId, input.opId, opType, input.entityId, ctx.actor.id, input.idempotencyKey, `resolved:${input.resolution}:${input.payload?.tag ?? ''}`]);
      if (typeof input.payload?.fail === 'string') throw new LimsError(input.payload.fail);
      return {};
    },
    async execute(ctx: any, op: any) {
      entered.push(op.opId);
      await ctx.tx.query(`INSERT INTO sync2_test.effect (tenant_id, op_id, op_type, entity_id, actor_id, idempotency_key, tag) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [ctx.tenantId, op.opId, opType, op.entityId ?? null, ctx.actor.id, op.idempotencyKey, op.payload?.tag ?? null]);
      if (typeof op.payload?.hold === 'string') await gate(op.payload.hold).promise;
      if (typeof op.payload?.fail === 'string') throw new LimsError(op.payload.fail);
      if (op.payload?.boom === true) throw new Error('boom: secret-detail-that-must-not-leak');
      return {
        ...(op.entityId ? { entityId: op.entityId } : {}),
        ...(op.payload?.numbers === true ? { numberMappings: [{ document_type: 'receipt', provisional_number: `OFF-5C0001-${String(op.payload.n ?? 1)}`, final_number: `RCP-2083-${op.opId.slice(-6)}` }] } : {}),
      };
    },
  };
}
export const ADAPTERS = [
  testAdapter('result.enter', 'lab.result.enter'), testAdapter('collection.mark_collected', 'lab.specimen.collect'),
  testAdapter('billing.record_receipt', 'billing.payment.record'), testAdapter('result.verify', 'lab.result.verify'),
];
/** Handlers with the test adapters installed (and optional settings). */
export const engine = (settings: Record<string, unknown> = {}, adapters: readonly any[] = ADAPTERS): Record<string, any> => createSyncPart2Handlers({ settings, adapters });

// ---- operation builders (shapes from contracts/openapi/core.yaml SyncOperation)
export interface Op { op_id: string; op_type: string; entity_id?: string; base_version?: number; payload: Record<string, unknown>; device_created_at: string }
export const iso = (d: Date): string => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
export const NOW = new Date('2026-11-17T10:00:00Z');
export function op(type: string, o: Partial<Op> & { payload?: Record<string, unknown> } = {}, at: Date = new Date(NOW.getTime() - 3_600_000)): Op {
  return { op_id: uid(), op_type: type, payload: { tag: 'x' }, device_created_at: iso(at), ...o } as Op;
}
export const enter = (o: Partial<Op> = {}, at?: Date): Op => op('result.enter', o, at);
export const collect = (o: Partial<Op> = {}, at?: Date): Op => op('collection.mark_collected', { base_version: 2, entity_id: uid(), ...o }, at);
export const receipt = (o: Partial<Op> = {}, at?: Date): Op => op('billing.record_receipt', { entity_id: uid(), ...o }, at);
export const verify = (o: Partial<Op> = {}, at?: Date): Op => op('result.verify', { base_version: 3, entity_id: uid(), ...o }, at);

// ---- identity fake with per call permission and centre scope control (sync permission codes are all granted by default)
export interface Grants { codes?: readonly string[] | ((permission: string) => boolean); centreIds?: readonly string[]; all?: boolean }
const EVERYTHING = (): boolean => true;
export interface Fire2 { now?: Date; grants?: Grants; headers?: Record<string, string>; metrics?: Array<{ kind: string; name: string; labels?: any; v?: number }>; bypassRls?: boolean; requestId?: string }
const claims = (tenant: string, sub: string, type: string) => JSON.stringify({ tenant_id: tenant, sub, actor_type: type, membership_id: sub });

/** One request = one tx under `who`'s claims (RLS on), like helpers.fire, PLUS ctx.db.tx (SAVEPOINT per operation), ctx.metrics capture and a getActor with a centre scope.
 *  Commits on success; on a throw it rolls back and RETURNS the error. The engine may run its operations sequentially only; ctx.tx is shared by the whole request. */
export async function fire2(handlers: Record<string, any>, operationId: string, r: { params?: object; query?: object; headers?: object; body?: unknown }, who: Who, o: Fire2 = {}): Promise<Outcome & { metrics: NonNullable<Fire2['metrics']> }> {
  await ensureEffectTable();
  const requestId = o.requestId ?? uid();
  const logs: string[] = [];
  const metrics: NonNullable<Fire2['metrics']> = o.metrics ?? [];
  const at = o.now ?? NOW;
  const log = (lvl: string) => (obj: unknown, msg?: string) => { logs.push(`${lvl} ${typeof obj === 'string' ? obj : JSON.stringify(obj)} ${msg ?? ''}`); };
  const g = o.grants ?? {};
  const allowed = (p: string): boolean => (typeof g.codes === 'function' ? g.codes(p) : Array.isArray(g.codes) ? (g.codes as readonly string[]).includes(p) : EVERYTHING());
  const asserted: string[] = [];
  const handler = handlers[operationId];
  if (!handler) return { error: new Error(`no handler for ${operationId}`), logs, requestId, metrics };
  const c = await (o.bypassRls ? supPool : appPool).connect();
  let sp = 0;
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('request.jwt.claims', $1, true)", [claims(who.tenant, who.userId, who.type ?? 'user')]);
    await c.query("SELECT set_config('app.request_id', $1, true)", [requestId]);
    const tx: any = { query: (t: string, v?: unknown[]) => c.query(t, v), startedAt: at, operation: { module: 'core', operationId } };
    const ctx: any = {
      operationId, tenantId: who.tenant, requestId, tx, now: () => at.toISOString(), clientIp: '203.0.113.9',
      actor: { type: who.type ?? 'user', id: who.userId, membershipId: who.userId },
      log: { info: log('info'), warn: log('warn'), error: log('error'), debug: log('debug') },
      metrics: { inc: (name: string, labels?: any, v?: number) => { metrics.push({ kind: 'inc', name, labels, v: v ?? 1 }); }, set: (name: string, v: number, labels?: any) => { metrics.push({ kind: 'set', name, labels, v }); }, observe: () => undefined },
      audit: { access: async () => undefined }, events: {}, core: {}, db: {}, noRetry: () => undefined,
      ports: { IdentityPort: {
        async assertRole(_c: unknown, req: { permission: string }) { asserted.push(req?.permission); if (!allowed(req?.permission)) throw new LimsError('auth.forbidden'); },
        async getActor() { return { centreScope: { all: g.all ?? (g.centreIds === undefined), centreIds: g.centreIds ?? [] } }; },
      } },
    };
    ctx.db.tx = async (fn: (cx: any) => Promise<unknown>) => {   // SAVEPOINT inside the request transaction (HandlerContext.db.tx)
      const name = `sp${++sp}`;
      await c.query(`SAVEPOINT ${name}`);
      try { const out = await fn(ctx); await c.query(`RELEASE SAVEPOINT ${name}`); return out; } catch (e) { await c.query(`ROLLBACK TO SAVEPOINT ${name}`); await c.query(`RELEASE SAVEPOINT ${name}`).catch(() => {}); throw e; }
    };
    const reply: Reply = await handler({ params: {}, query: {}, headers: {}, body: undefined, ...r, headers: { ...(r.headers ?? {}), ...(o.headers ?? {}) } }, ctx);
    await c.query('COMMIT');
    return { reply, logs, requestId, asserted, metrics };
  } catch (error) { await c.query('ROLLBACK').catch(() => {}); return { error, logs, requestId, asserted, metrics }; } finally { c.release(); }
}

export const code = (o: { error?: any }): string | undefined => (o.error instanceof LimsError ? o.error.code : undefined);
export const okBody = (o: Outcome): any => { if (o.error) throw o.error; return o.reply!.body; };

// ---- device helpers
import { newDevice } from './helpers.js';
export { newDevice, uuidv7 };
export const devicePush = (h: Record<string, any>, who: Who, deviceId: string, operations: Op[], o: Fire2 = {}) =>
  fire2(h, 'pushSyncBatch', { body: { device_id: deviceId, operations } }, who, o);
export const pull = (h: Record<string, any>, who: Who, deviceId: string, entities: Array<{ entity_type: string; cursor?: string }>, limit?: number, o: Fire2 = {}) =>
  fire2(h, 'pullChanges', { body: { device_id: deviceId, entities, ...(limit !== undefined ? { limit } : {}) } }, who, o);
export const listConflicts = (h: Record<string, any>, who: Who, query: object = {}, o: Fire2 = {}) => fire2(h, 'listSyncConflicts', { query }, who, o);
export const getConflict = (h: Record<string, any>, who: Who, id: string, o: Fire2 = {}) => fire2(h, 'getSyncConflict', { params: { conflict_id: id } }, who, o);
export const resolve = (h: Record<string, any>, who: Who, id: string, body: object, o: Fire2 = {}) => fire2(h, 'resolveSyncConflict', { params: { conflict_id: id }, body }, who, o);
/** The ledger row(s) of ops (owner side truth). */
export const ledger = (opIds: string[]): Promise<any[]> => ownerRows('SELECT * FROM core.sync_operation WHERE op_id = ANY($1::uuid[]) ORDER BY device_created_at, op_id', [opIds]);
export const conflictsOf = (opIds: string[]): Promise<any[]> => ownerRows('SELECT * FROM core.sync_conflict WHERE op_id = ANY($1::uuid[]) ORDER BY created_at, id', [opIds]);
export { A1, TENANT_A, USER, ownerRows, superTx, uid };
export type { Tx, Who };
