// T0B-SYNC-2 (LD-322, done_when 5; design section 8): list, get and resolve the conflicts the push engine records in core.sync_conflict.
// resolveSyncConflict: keep_server discards the local version; apply_local / merge go through the adapter of the operation type (the same
// domain rules as an online edit, the conflict id as idempotency key, as the resolver). The conflict row is locked first, so a conflict is
// resolved once only (a second or concurrent resolution answers common.immutable_record; the table trigger also freezes resolved rows).
// The entity moved on the server since the conflict was recorded = sync.entity_changed. Audit comes from the row trigger (app.tg_row_audit).
import { LimsError } from '../errors.js';
import type { HandlerContext } from '../module.js';
import { CURSOR_KEY, guard, type SyncCtx } from './devices.service.js';
import { canonical, type SyncAdapter } from './engine.js';
import { UUID, invalid, objectWith, uuidOf } from './mappers.js';
import * as repo from './repository.js';

const PERMISSION = 'sync.conflict.resolve';
const STATUSES: readonly string[] = ['open', 'resolved'];
const RESOLUTIONS: readonly string[] = ['keep_server', 'apply_local', 'merge'];
const ENTITY_TYPE = /^[a-z][a-z_]*$/;

const iso = (v: unknown): string | undefined => (v == null ? undefined : (v instanceof Date ? v : new Date(String(v))).toISOString());
export function toSyncConflict(r: any): Record<string, unknown> {
  const o: Record<string, unknown> = { id: r.id, op_id: r.op_id, entity_type: r.entity_type, entity_id: r.entity_id, local_payload: r.local_payload, server_payload: r.server_payload, status: r.status };
  if (r.resolution != null) o.resolution = r.resolution;
  if (r.resolved_by != null) o.resolved_by = r.resolved_by;
  if (r.resolved_at != null) o.resolved_at = iso(r.resolved_at);
  if (r.reason != null) o.reason = r.reason;
  o.created_at = iso(r.created_at);
  return o;
}

const enc = (r: any): string => Buffer.from(JSON.stringify({ r: Number(r.r), k: r.created_at_key, i: r.id })).toString('base64url');
function dec(c: unknown): { r: number; k: string; i: string } {
  try {
    if (typeof c !== 'string' || c.length > 512) throw 0;
    const o = JSON.parse(Buffer.from(c, 'base64url').toString('utf8'));
    if ((o?.r === 0 || o?.r === 1) && typeof o.k === 'string' && CURSOR_KEY.test(o.k) && typeof o.i === 'string' && UUID.test(o.i)) return { r: o.r, k: o.k, i: o.i };
  } catch { /* fallthrough */ }
  throw new LimsError('common.invalid_cursor');
}

export async function listConflicts(ctx: SyncCtx, query: unknown) {
  const w = await guard(ctx, PERMISSION);
  const q = (query && typeof query === 'object' ? query : {}) as Record<string, unknown>;
  if (q.status !== undefined && !STATUSES.includes(q.status as string)) throw invalid('/status');
  const et = q.entity_type;
  if (et !== undefined && (typeof et !== 'string' || et.length > 60 || !ENTITY_TYPE.test(et))) throw invalid('/entity_type');
  const limit = q.limit === undefined ? 50 : typeof q.limit === 'string' && /^\d{1,3}$/.test(q.limit) ? Number(q.limit) : q.limit;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 200) throw invalid('/limit');
  const after = q.cursor === undefined ? undefined : dec(q.cursor);
  const rows = await repo.listConflicts(w.tx, w.tenantId, {
    ...(q.status !== undefined ? { status: q.status as string } : {}), ...(et !== undefined ? { entityType: et as string } : {}), ...(after ? { after } : {}), limit,
  });
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return { data: page.map(toSyncConflict), page: { limit, ...(rows.length > limit && last ? { next_cursor: enc(last) } : {}) } };
}

const conflictId = (params: unknown): string => uuidOf((params as Record<string, unknown> | null)?.conflict_id, '/conflict_id');

export async function getConflict(ctx: SyncCtx, params: unknown) {
  const w = await guard(ctx, PERMISSION);
  const row = await repo.getConflict(w.tx, w.tenantId, conflictId(params));
  if (!row) throw new LimsError('common.not_found');
  return toSyncConflict(row);
}

export async function resolveConflict(ctx: SyncCtx, params: unknown, body: unknown, registry: ReadonlyMap<string, SyncAdapter>) {
  const w = await guard(ctx, PERMISSION);
  const id = conflictId(params);
  const b = objectWith(body, ['resolution', 'reason', 'merged_payload']);
  const resolution = b.resolution;
  if (typeof resolution !== 'string' || !RESOLUTIONS.includes(resolution)) throw invalid('/resolution', resolution === undefined ? 'common.field_required' : 'common.field_invalid');
  const reason = b.reason;
  if (typeof reason !== 'string' || [...reason].length < 1 || [...reason].length > 1000) throw invalid('/reason', reason === undefined ? 'common.field_required' : 'common.field_invalid');
  const merged = b.merged_payload;
  if (resolution === 'merge' && (merged === null || typeof merged !== 'object' || Array.isArray(merged))) throw invalid('/merged_payload', merged === undefined ? 'common.field_required' : 'common.field_invalid');
  if (resolution !== 'merge' && merged !== undefined) throw invalid('/merged_payload', 'common.unknown_field');
  const row = await repo.lockConflict(w.tx, w.tenantId, id);
  if (!row) throw new LimsError('common.not_found');
  if (row.status !== 'open') throw new LimsError('common.immutable_record');
  const adapter = registry.get(row.op_type);
  const hc = ctx as unknown as HandlerContext;
  if (adapter?.currentServerPayload) {
    const now = await adapter.currentServerPayload(hc, { entityId: row.entity_id });
    if (canonical(now) !== canonical(row.server_payload)) throw new LimsError('sync.entity_changed');
  }
  if (resolution !== 'keep_server') {
    if (!adapter?.applyResolution) { ctx.log?.info({ event: 'sync_conflict_no_adapter', conflict_id: id }); throw new LimsError('common.internal'); }
    await adapter.applyResolution(hc, { resolution: resolution as 'apply_local' | 'merge', opId: row.op_id, entityId: row.entity_id, entityType: row.entity_type,
      payload: (resolution === 'merge' ? merged : row.local_payload) as object, idempotencyKey: id });
  }
  const done = await repo.resolveConflict(w.tx, { tenantId: w.tenantId, id, resolution, reason, actorId: w.actorId, at: ctx.now() });
  ctx.log?.info({ event: 'sync_conflict_resolved', conflict_id: id, resolution });
  return toSyncConflict(done);
}
