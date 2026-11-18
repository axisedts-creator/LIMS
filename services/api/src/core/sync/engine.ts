// T0B-SYNC-2 (LD-322 decisions 2 and 5, LD-325 b): pushSyncBatch, the offline outbox replay engine, and the op_type -> adapter registry.
// Design C:/LIMS-state/offline-design-20261117.md sections 2 (principles), 3 (catalogue), 5 (time), 7 (limits), 8 (conflicts).
// Per batch: staff user + sync.use; shape and limits (50 operations, 1 MB) before any work; one batch in flight per device (non waiting
// advisory lock, 429); the device must be the caller's and active; per device and per tenant rate limits (429).
// Per operation, in device_created_at then op_id order, results in the order sent:
//   (1) claim the op_id in core.sync_operation (a replay answers duplicate with the first outcome; another payload hash or another user
//       answers sync.op_id_reused), (2) clock skew, (3) adapter (sync.op_type_not_available until T0B-SYNC-3/4 install one),
//   (4) the wrapped operation's permission asserted NOW for the signed in user, (5) validate, (6) conflict check (core.sync_conflict),
//   (7) execute with the op id as idempotency key; (2)..(7) inside one SAVEPOINT (ctx.db.tx), so one bad operation never fails the batch
//   and a rejected one leaves no effect. Error codes are the closed SyncErrorCode list of core.yaml; anything else is common.internal.
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { uuidv7 } from '../../../../../packages/shared-ts/src/uuidv7/index.js';
import { LimsError } from '../errors.js';
import { loadSpec, REPO_ROOT, type HandlerContext } from '../module.js';
import { assertUsable, guard, ownDevice, skewOf, type SyncCtx } from './devices.service.js';
import { ISO_INSTANT, invalid, objectWith, uuidOf } from './mappers.js';
import * as repo from './repository.js';

/** One entry of the dispatcher registry (pinned in __tests__/helpers2.ts; real adapters come in T0B-SYNC-3 and T0B-SYNC-4). */
export interface SyncAdapter {
  opType: string;
  /** x-permission of the wrapped operation, asserted per operation at sync time. */
  permission: string;
  validate(payload: unknown): void;
  conflictCheck?(ctx: HandlerContext, op: SyncOp): Promise<undefined | { entityType: string; serverPayload: object }>;
  currentServerPayload?(ctx: HandlerContext, input: { entityId: string }): Promise<object>;
  applyResolution?(ctx: HandlerContext, input: { resolution: 'apply_local' | 'merge'; opId: string; entityId: string; entityType: string; payload: object; idempotencyKey: string }): Promise<unknown>;
  /** T0B-SYNC-3: `outcome: 'duplicate'` = the entity is already in that state or further (no change, no error code). */
  execute(ctx: HandlerContext, op: SyncOp): Promise<{ entityId?: string; outcome?: 'accepted' | 'duplicate'; numberMappings?: NumberMapping[] }>;
}
export interface NumberMapping { document_type: string; provisional_number: string; final_number: string }
/** T0B-SYNC-3: deviceId always; reservedNumbers from the envelope key `reserved_numbers` (registration.create_order: patient id and lab codes,
 *  accession.receive: lab codes), part of the payload hash. */
export interface SyncOp { opId: string; opType: string; entityId?: string; baseVersion?: number; payload: Record<string, unknown>; deviceCreatedAt: string; idempotencyKey: string;
  deviceId: string; reservedNumbers?: { patientId?: number; labCodes?: number[] } }

/** T0B-SYNC-3: thrown by SyncAdapter.execute when the server state contradicts the operation: the operation's SAVEPOINT is rolled back, a
 *  core.sync_conflict row is written (local = op payload, server = serverPayload) and the result is conflict with errorCode. */
export class SyncConflictError extends Error {
  readonly entityType: string; readonly entityId: string | undefined; readonly serverPayload: object; readonly errorCode: string;
  constructor(a: { entityType: string; entityId?: string | undefined; serverPayload: object; errorCode: string }) {
    super('sync conflict');
    this.name = 'SyncConflictError';
    this.entityType = a.entityType; this.entityId = a.entityId; this.serverPayload = a.serverPayload; this.errorCode = a.errorCode;
  }
}

/** T0B-SYNC-3 (LD-322 decision 1, design section 4): the provisional number of a document printed offline, derived from (device id, op id)
 *  only, so the device and the server compute the same one and a replay returns the identical mapping. `doc` tells documents of one op apart. */
export const provisionalNumber = (deviceId: string, opId: string, doc: string): string =>
  `OFF-${deviceId.replace(/-/g, '').slice(0, 8)}-${opId.replace(/-/g, '')}-${doc}`.toUpperCase();

/** T0B-SYNC-3: top level shape of a wrapped request schema (required keys present, no unknown key), the closed code
 *  common.validation_failed otherwise. Deeper rules stay with the wrapped service. */
export function payloadShape(file: string, schema: string): (payload: unknown) => void {
  let s: { required?: string[]; properties?: Record<string, unknown> } | undefined;
  return (payload) => {
    s ??= (loadSpec(join(REPO_ROOT, 'contracts', 'openapi', file)) as any).components.schemas[schema];
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) throw new LimsError('common.validation_failed');
    const keys = Object.keys(payload);
    if (keys.some((k) => !Object.hasOwn(s!.properties ?? {}, k)) || (s!.required ?? []).some((k) => !keys.includes(k))) throw new LimsError('common.validation_failed');
  };
}

export interface PushSettings {
  maxBatchOperations: number; maxBatchBytes: number;
  /** design section 5: flag above 5 minutes, reject above 24 hours. */
  skewFlagMs: number; skewRejectMs: number;
  /** [CONV] defaults leave room for an outage recovery (LD-322 decision 5: 200 devices); per createSyncPart2Handlers instance. */
  deviceBatchesPerMinute: number; tenantBatchesPerMinute: number;
}

/** The closed catalogue (core.yaml SyncOperation) with the fields each wrapped operation requires. */
const CATALOGUE: Readonly<Record<string, { entity: boolean; version: boolean }>> = {
  'registration.create_order': { entity: false, version: false }, 'billing.record_receipt': { entity: true, version: false },
  'collection.mark_collected': { entity: true, version: true }, 'accession.receive': { entity: true, version: true },
  'result.enter': { entity: false, version: false }, 'result.verify': { entity: true, version: true },
  'report.print_marker': { entity: true, version: false }, 'daily_cash.close': { entity: true, version: true },
};
const OP_KEYS = ['op_id', 'op_type', 'entity_id', 'base_version', 'payload', 'device_created_at', 'reserved_numbers'];
/** T0B-SYNC-3: which op types may carry reserved numbers of a device block, and which series (design section 4: blocks for lab codes and patient ids only). */
const RESERVED: Readonly<Record<string, readonly string[]>> = { 'registration.create_order': ['patient_id', 'lab_codes'], 'accession.receive': ['lab_codes'] };
const MAX_LAB_CODES = 50;
const blockNo = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 1;
function reservedOf(v: unknown, opType: string, w: string): SyncOp['reservedNumbers'] {
  if (v === undefined) return undefined;
  const allowed = RESERVED[opType];
  if (!allowed) throw invalid(w);
  const o = objectWith(v, allowed, w);
  if (o.patient_id !== undefined && !blockNo(o.patient_id)) throw invalid(`${w}/patient_id`);
  const labs = o.lab_codes;
  if (labs !== undefined && (!Array.isArray(labs) || labs.length > MAX_LAB_CODES || !labs.every(blockNo))) throw invalid(`${w}/lab_codes`);
  return { ...(o.patient_id !== undefined ? { patientId: o.patient_id as number } : {}), ...(labs !== undefined ? { labCodes: labs as number[] } : {}) };
}

let closedCodes: ReadonlySet<string> | undefined;
/** core.yaml SyncErrorCode: the only codes a result may carry (registered codes, never free text). */
function syncErrorCodes(): ReadonlySet<string> {
  closedCodes ??= new Set((loadSpec(join(REPO_ROOT, 'contracts', 'openapi', 'core.yaml')) as any).components.schemas.SyncErrorCode.enum as string[]);
  return closedCodes;
}
const codeOf = (e: unknown): string => {
  const c = (e as { code?: unknown } | null)?.code;
  return (e instanceof LimsError || typeof c === 'string') && typeof c === 'string' && syncErrorCodes().has(c) ? c : 'common.internal';
};

/** Canonical JSON (keys sorted at every level): the payload hash ignores key order. */
export const canonical = (v: unknown): string =>
  Array.isArray(v) ? `[${v.map(canonical).join(',')}]`
    : v !== null && typeof v === 'object' ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`
      : JSON.stringify(v) ?? 'null';

/** [ms, microseconds within the ms] of an IsoDateTime (up to 6 fraction digits survive the sort). */
const instant = (s: string): [number, number] => {
  const us = Number((/\.(\d{1,6})Z$/.exec(s)?.[1] ?? '').padEnd(6, '0'));
  return [Date.parse(s.replace(/\.\d+Z$/, 'Z')) + Math.floor(us / 1000), us % 1000];
};
const msOf = (s: string): number => { const [ms, us] = instant(s); return ms + us / 1000; };

interface Parsed extends SyncOp { index: number; hash: string; at: [number, number] }
function parseOp(v: unknown, i: number): Parsed {
  const w = `/operations/${i}`;
  const o = objectWith(v, OP_KEYS, w);
  const opId = uuidOf(o.op_id, `${w}/op_id`);
  const opType = o.op_type;
  if (typeof opType !== 'string' || !Object.hasOwn(CATALOGUE, opType)) throw invalid(`${w}/op_type`);
  const need = CATALOGUE[opType]!;
  const entityId = o.entity_id === undefined ? undefined : uuidOf(o.entity_id, `${w}/entity_id`);
  if (need.entity && entityId === undefined) throw invalid(`${w}/entity_id`, 'common.field_required');
  const bv = o.base_version;
  if (bv !== undefined && (typeof bv !== 'number' || !Number.isInteger(bv) || bv < 1 || bv > 2_147_483_647)) throw invalid(`${w}/base_version`);
  if (need.version && bv === undefined) throw invalid(`${w}/base_version`, 'common.field_required');
  const p = o.payload;
  if (p === null || typeof p !== 'object' || Array.isArray(p)) throw invalid(`${w}/payload`);
  const at = o.device_created_at;
  if (typeof at !== 'string' || !ISO_INSTANT.test(at) || !Number.isFinite(Date.parse(at))) throw invalid(`${w}/device_created_at`);
  const reservedNumbers = reservedOf(o.reserved_numbers, opType, `${w}/reserved_numbers`);
  // reserved_numbers joins the hash only when present, so the hash of an operation without it is unchanged since T0B-SYNC-2
  const hashed = { op_type: opType, entity_id: entityId ?? null, base_version: bv ?? null, payload: p, ...(o.reserved_numbers !== undefined ? { reserved_numbers: o.reserved_numbers } : {}) };
  const hash = createHash('sha256').update(canonical(hashed)).digest('hex');
  return { index: i, opId, opType, ...(entityId ? { entityId } : {}), ...(bv !== undefined ? { baseVersion: bv } : {}), payload: p as Record<string, unknown>,
    deviceCreatedAt: at, idempotencyKey: opId, deviceId: '', ...(reservedNumbers ? { reservedNumbers } : {}), hash, at: instant(at) };
}

/** ponytail: in process sliding window per handler instance (pinned by the tests); several API instances each allow the limit, move to
 *  core/ratelimit (pg or redis) when more than one instance serves sync. */
class Window {
  private readonly hits = new Map<string, number[]>();
  /** seconds to wait, or 0 when the key is under `limit` in the 60 s before `now`. */
  wait(key: string, limit: number, now: number): number {
    const live = (this.hits.get(key) ?? []).filter((t) => t > now - 60_000 && t <= now);
    if (live.length) this.hits.set(key, live); else this.hits.delete(key);
    return live.length < limit ? 0 : Math.max(1, Math.ceil((live[0]! + 60_000 - now) / 1000));
  }
  hit(key: string, now: number): void { this.hits.set(key, [...(this.hits.get(key) ?? []), now]); }
}

type Ctx = HandlerContext & SyncCtx;
type Result = { op_id: string; status: string; error_code?: string; conflict_id?: string; entity_id?: string; number_mappings?: unknown[]; skew_flag?: boolean };
const busy = (seconds: number): LimsError => { const e = new LimsError('common.rate_limited'); e.retryAfterSeconds = seconds; return e; };

export function createPushEngine(s: PushSettings, registry: ReadonlyMap<string, SyncAdapter>) {
  const window = new Window();
  const count = (ctx: Ctx, name: string, labels: Record<string, string>) => ctx.metrics?.inc(name, labels);

  async function runOne(ctx: Ctx, w: { tenantId: string; actorId: string; tx: repo.Tx }, deviceId: string, op: Parsed, nowMs: number, headerSkew: number | undefined): Promise<Result> {
    const claimed = await repo.claimOperation(w.tx, { tenantId: w.tenantId, opId: op.opId, deviceId, userId: w.actorId, opType: op.opType, baseVersion: op.baseVersion,
      hash: op.hash, payload: op.payload, deviceCreatedAt: op.deviceCreatedAt, at: ctx.now() });
    if (!claimed) {
      const prior = await repo.storedOperation(w.tx, w.tenantId, op.opId);
      if (!prior || String(prior.user_id).toLowerCase() !== w.actorId || prior.payload_hash !== op.hash) return { op_id: op.opId, status: 'rejected', error_code: 'sync.op_id_reused' };
      if (!prior.result) return { op_id: op.opId, status: 'rejected', error_code: 'common.internal' };
      return { ...prior.result, op_id: op.opId, status: 'duplicate' };
    }
    const ahead = Math.max(0, msOf(op.deviceCreatedAt) - nowMs);   // an old operation is an outage, not skew; a future one is skew
    const skewMs = Math.max(ahead, Math.abs(headerSkew ?? 0));
    const skew = skewMs > s.skewFlagMs;
    let out: Result;
    if (skewMs > s.skewRejectMs) out = { op_id: op.opId, status: 'rejected', error_code: 'sync.clock_skew_too_large', skew_flag: skew };
    else {
      const adapter = registry.get(op.opType);
      if (!adapter) out = { op_id: op.opId, status: 'rejected', error_code: 'sync.op_type_not_available', skew_flag: skew };
      else {
        try {
          const ran: Result | undefined = await ctx.db.tx?.(async (cx): Promise<Result> => {
            await (cx as Ctx).ports.IdentityPort.assertRole(cx, { permission: adapter.permission });   // the permissions the user has NOW
            adapter.validate(op.payload);
            const found = await adapter.conflictCheck?.(cx, op);
            if (found) {
              if (!op.entityId) throw new LimsError('common.internal');
              const id = uuidv7();
              await repo.insertConflict((cx as Ctx).tx ?? w.tx, { tenantId: w.tenantId, id, opId: op.opId, entityType: found.entityType, entityId: op.entityId,
                local: op.payload, server: found.serverPayload, actorId: w.actorId });
              return { op_id: op.opId, status: 'conflict', error_code: 'sync.base_version_stale', conflict_id: id, entity_id: op.entityId, skew_flag: skew };
            }
            const r = await adapter.execute(cx, op);
            return { op_id: op.opId, status: r?.outcome === 'duplicate' ? 'duplicate' : 'accepted', ...(r?.entityId ? { entity_id: r.entityId } : {}),
              ...(r?.numberMappings?.length ? { number_mappings: r.numberMappings.slice(0, 3) } : {}), skew_flag: skew };
          });
          if (!ran) throw new LimsError('common.internal');   // no SAVEPOINT available: never run an operation outside its own transaction
          out = ran;
        } catch (e) {
          if (e instanceof SyncConflictError) {
            // the SAVEPOINT is rolled back already (no effect, no number); the conflict row is written on the request tx, outside it.
            // A create has no server entity yet: the op id names the conflict's entity [CONV] (core.sync_conflict.entity_id is NOT NULL).
            const id = uuidv7();
            const entityId = e.entityId ?? op.entityId ?? op.opId;
            await repo.insertConflict(w.tx, { tenantId: w.tenantId, id, opId: op.opId, entityType: e.entityType, entityId, local: op.payload, server: e.serverPayload, actorId: w.actorId });
            const code = syncErrorCodes().has(e.errorCode) ? e.errorCode : 'common.internal';
            const named = e.entityId ?? op.entityId;
            out = { op_id: op.opId, status: 'conflict', error_code: code, conflict_id: id, ...(named ? { entity_id: named } : {}), skew_flag: skew };
            await repo.writeOutcome(w.tx, w.tenantId, op.opId, { status: out.status, result: out, errorCode: out.error_code, skew });
            return out;
          }
          const code = codeOf(e);
          if (code === 'common.internal') ctx.log?.warn({ event: 'sync_operation_failed', op_type: op.opType });
          out = { op_id: op.opId, status: 'rejected', error_code: code, skew_flag: skew };
        }
      }
    }
    await repo.writeOutcome(w.tx, w.tenantId, op.opId, { status: out.status, result: out, errorCode: out.error_code, skew });
    return out;
  }

  return async function pushBatch(ctx: Ctx, body: unknown, headers: unknown): Promise<{ results: Result[] }> {
    const w = await guard(ctx, 'sync.use');
    const b = objectWith(body, ['device_id', 'operations']);
    const deviceId = uuidOf(b.device_id, '/device_id');
    const list = b.operations;
    if (!Array.isArray(list) || list.length === 0) throw invalid('/operations', list === undefined ? 'common.field_required' : 'common.field_invalid');
    if (list.length > s.maxBatchOperations || Buffer.byteLength(JSON.stringify(body)) > s.maxBatchBytes) {
      count(ctx, 'lims_core_sync_batches_total', { outcome: 'too_large' });
      throw new LimsError('sync.batch_too_large');
    }
    const ops = list.map(parseOp).map((o) => ({ ...o, deviceId }));
    if (!(await repo.tryDeviceLock(w.tx, w.tenantId, deviceId))) {
      count(ctx, 'lims_core_sync_batches_total', { outcome: 'busy' });
      throw busy(5);
    }
    assertUsable(await ownDevice(w, deviceId, 'share'));
    const now = ctx.now();
    const nowMs = Date.parse(now);
    const dKey = `${w.tenantId}:${deviceId}`;
    const wait = Math.max(window.wait(dKey, s.deviceBatchesPerMinute, nowMs), window.wait(w.tenantId, s.tenantBatchesPerMinute, nowMs));
    if (wait > 0) {
      count(ctx, 'lims_core_sync_batches_total', { outcome: 'rate_limited' });
      throw busy(wait);
    }
    window.hit(dKey, nowMs); window.hit(w.tenantId, nowMs);
    const { skewMs } = skewOf(headers, now);
    const order = [...ops].sort((x, y) => x.at[0] - y.at[0] || x.at[1] - y.at[1] || (x.opId < y.opId ? -1 : x.opId > y.opId ? 1 : 0));
    const results: Result[] = new Array(ops.length);
    for (const op of order) {
      const r = await runOne(ctx, w, deviceId, op, nowMs, skewMs);   // sequential on purpose: ctx.tx is one connection
      count(ctx, 'lims_core_sync_operations_total', { status: r.status });
      results[op.index] = r;
    }
    await repo.markSynced(w.tx, { tenantId: w.tenantId, id: deviceId, userId: w.actorId, at: now, ...(skewMs !== undefined ? { skewMs } : {}) });
    count(ctx, 'lims_core_sync_batches_total', { outcome: 'processed' });
    return { results };
  };
}
