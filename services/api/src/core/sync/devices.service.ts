// T0B-SYNC-1 (LD-322 decision 4, design section 6): device registry. registerSyncDevice is idempotent per device id and user; a device
// belongs to one user at a time; revoke and wipe take effect on the device's next contact (getSyncStatus, reserveNumberBlock, register).
// Every handler asserts its x-permission itself (LD-261: central stage 8a is shadow by default) and serves staff USER actors only.
// Error codes follow contracts/errors.yaml meanings: an id that is not this tenant's (and, for device side calls, this user's) device is
// sync.device_unknown; revoked = sync.device_revoked (403); pending wipe = sync.wipe_required (409).
import { LimsError } from '../errors.js';
import { DEVICE_STATUSES, ISO_INSTANT, APP_VERSION, PLATFORMS, invalid, objectWith, toSyncDevice, uuidOf } from './mappers.js';
import * as repo from './repository.js';

export interface SyncCtx {
  tenantId?: string; actor?: { type?: string; id?: string }; tx?: repo.Tx; now(): string;
  ports: { IdentityPort: { assertRole(ctx: unknown, r: { permission: string }): Promise<unknown> } };
  log?: { info(o: object, m?: string): void };
}
export interface Who { tenantId: string; actorId: string; tx: repo.Tx }

/** Staff user actor + the operation's permission, before anything is read or written. */
export async function guard(ctx: SyncCtx, permission: string): Promise<Who> {
  if (ctx.actor?.type !== 'user' || typeof ctx.actor.id !== 'string' || typeof ctx.tenantId !== 'string') throw new LimsError('auth.forbidden');
  try {
    await ctx.ports.IdentityPort.assertRole(ctx, { permission });
  } catch (e) {
    const o = e as { code?: unknown } | null;   // the port may throw the contracts' LimsError class: same code, re-wrapped for the API mapper
    if (!(e instanceof LimsError) && typeof o?.code === 'string') throw new LimsError(o.code);
    throw e;
  }
  if (!ctx.tx) throw new LimsError('common.internal');
  return { tenantId: ctx.tenantId, actorId: ctx.actor.id.toLowerCase(), tx: ctx.tx };
}

/** A device side call on a revoked or wipe pending device stops here (design section 6). */
export function assertUsable(row: { status: string }): void {
  if (row.status === 'revoked') throw new LimsError('sync.device_revoked');
  if (row.status === 'wipe_requested') throw new LimsError('sync.wipe_required');
}

/** The caller's own device of this tenant, or sync.device_unknown (no oracle on other users' or tenants' ids). */
export async function ownDevice(w: Who, id: string, mode: 'update' | 'share' = 'update') {
  const row = await repo.lockDevice(w.tx, w.tenantId, id, mode);
  if (!row || String(row.user_id).toLowerCase() !== w.actorId) throw new LimsError('sync.device_unknown');
  return row;
}

const chars = (s: string): number => [...s].length;   // sync_device__device_label__ck counts characters

export async function registerDevice(ctx: SyncCtx, body: unknown) {
  const w = await guard(ctx, 'sync.use');
  const b = objectWith(body, ['id', 'device_label', 'platform', 'app_version']);
  const id = uuidOf(b.id, '/id');
  const label = b.device_label;
  if (typeof label !== 'string' || chars(label) < 1 || chars(label) > 120) throw invalid('/device_label');
  if (typeof b.platform !== 'string' || !PLATFORMS.includes(b.platform)) throw invalid('/platform');
  const ver = b.app_version;
  if (typeof ver !== 'string' || ver.length > 40 || !APP_VERSION.test(ver)) throw invalid('/app_version');
  const a = { tenantId: w.tenantId, id, userId: w.actorId, label, platform: b.platform, appVersion: ver, at: ctx.now() };
  const created = await repo.insertDeviceIfAbsent(w.tx, a);
  if (created) {
    ctx.log?.info({ event: 'sync_device_registered', device_id: id });
    return toSyncDevice(created);
  }
  const row = await repo.lockDevice(w.tx, w.tenantId, id);
  // the id exists in another tenant (invisible under RLS) or belongs to another user: one user per device, never a takeover
  if (!row || String(row.user_id).toLowerCase() !== w.actorId) throw new LimsError('auth.forbidden');
  assertUsable(row);
  return toSyncDevice(await repo.refreshDevice(w.tx, a));
}

export async function deviceStatus(ctx: SyncCtx, query: unknown, headers: unknown) {
  const w = await guard(ctx, 'sync.use');
  const q = (query && typeof query === 'object' ? query : {}) as Record<string, unknown>;
  const id = uuidOf(q.device_id, '/device_id');
  assertUsable(await ownDevice(w, id));
  const now = ctx.now();
  const row = await repo.touchDevice(w.tx, { tenantId: w.tenantId, id, userId: w.actorId, at: now, ...skewOf(headers, now) });
  return { now, row };
}

/** Design section 5: the device reports its clock in `x-device-time` (ISO instant). Absent or malformed = not reported (a client bug never stops sync). */
function skewOf(headers: unknown, now: string): { skewMs?: number } {
  const h = headers && typeof headers === 'object' ? (headers as Record<string, unknown>)['x-device-time'] : undefined;
  const v = Array.isArray(h) ? h[0] : h;
  if (typeof v !== 'string' || v.length > 30 || !ISO_INSTANT.test(v)) return {};
  const t = Date.parse(v);
  return Number.isFinite(t) ? { skewMs: t - Date.parse(now) } : {};
}

export async function listDevices(ctx: SyncCtx, query: unknown) {
  const w = await guard(ctx, 'sync.device.manage');
  const q = (query && typeof query === 'object' ? query : {}) as Record<string, unknown>;
  if (q.status !== undefined && !DEVICE_STATUSES.includes(q.status as string)) throw invalid('/status');
  if (q.platform !== undefined && !PLATFORMS.includes(q.platform as string)) throw invalid('/platform');
  const userId = q.user_id === undefined ? undefined : uuidOf(q.user_id, '/user_id');
  const limit = q.limit === undefined ? 50 : typeof q.limit === 'string' && /^\d{1,3}$/.test(q.limit) ? Number(q.limit) : q.limit;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 200) throw invalid('/limit');
  const after = q.cursor === undefined ? undefined : decodeCursor(q.cursor);
  const rows = await repo.listDevices(w.tx, w.tenantId, {
    ...(q.status !== undefined ? { status: q.status as string } : {}), ...(userId ? { userId } : {}),
    ...(q.platform !== undefined ? { platform: q.platform as string } : {}), ...(after ? { after } : {}), limit,
  });
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    data: page.map(toSyncDevice),
    page: { limit, ...(rows.length > limit && last ? { next_cursor: Buffer.from(JSON.stringify({ k: last.created_at_key, i: last.id })).toString('base64url') } : {}) },
  };
}

const CURSOR_KEY = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?[+-]\d{2}(:\d{2})?$/;
function decodeCursor(c: unknown): { k: string; i: string } {
  try {
    if (typeof c !== 'string' || c.length > 512) throw 0;
    const o = JSON.parse(Buffer.from(c, 'base64url').toString('utf8'));
    if (typeof o?.k === 'string' && CURSOR_KEY.test(o.k) && typeof o?.i === 'string' && /^[0-9a-f-]{36}$/.test(o.i)) return { k: o.k, i: o.i };
  } catch { /* fallthrough */ }
  throw new LimsError('common.invalid_cursor');
}

const tenantDevice = async (w: Who, params: unknown) => {
  const id = uuidOf((params as Record<string, unknown> | null)?.device_id, '/device_id');
  const row = await repo.lockDevice(w.tx, w.tenantId, id);
  if (!row) throw new LimsError('sync.device_unknown');
  return row;
};

/** Revoking a revoked device answers the unchanged row (no write, no second audit event). */
export async function revokeDevice(ctx: SyncCtx, params: unknown) {
  const w = await guard(ctx, 'sync.device.manage');
  const row = await tenantDevice(w, params);
  if (row.status === 'revoked') return toSyncDevice(row);
  return toSyncDevice(await repo.changeDevice(w.tx, w.tenantId, row.id, w.actorId, { status: 'revoked' }));
}

/** A second request keeps the first wipe_requested_at; a revoked device stays revoked (revoke is the stronger state). */
export async function requestWipe(ctx: SyncCtx, params: unknown) {
  const w = await guard(ctx, 'sync.device.manage');
  const row = await tenantDevice(w, params);
  if (row.status !== 'active') return toSyncDevice(row);
  return toSyncDevice(await repo.changeDevice(w.tx, w.tenantId, row.id, w.actorId, { status: 'wipe_requested', at: ctx.now() }));
}

/** Only the signed in owner acknowledges; the status stays wipe_requested (an administrator decides what happens next). */
export async function ackWipe(ctx: SyncCtx, params: unknown) {
  const w = await guard(ctx, 'sync.use');
  const row = await tenantDevice(w, params);
  if (String(row.user_id).toLowerCase() !== w.actorId) throw new LimsError('auth.forbidden');
  if (row.status === 'revoked') throw new LimsError('sync.device_revoked');
  if (row.status !== 'wipe_requested') throw new LimsError('common.not_found');   // no wipe pending: nothing to acknowledge
  if (row.wipe_acked_at) return toSyncDevice(row);
  return toSyncDevice(await repo.changeDevice(w.tx, w.tenantId, row.id, w.actorId, { ackAt: ctx.now() }));
}
