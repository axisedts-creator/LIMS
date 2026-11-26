// PHLEBO-UI-FULL-1 updateVisitTracking: PUT /v1/homecollection/visits/{visit_id}/tracking (homecollection.sync.upload).
// The assigned phlebotomist starts sharing ("On my way"), sends the latest position, or stops. Online only (never through
// the offline outbox). Only the caller's own assigned visit can be tracked; anything else answers
// homecollection.visit_not_assigned without saying why. No position is ever logged.
import { LimsError } from '../../core/errors.js';
import { bad, isObj, noExtra } from './device.service.js';
import { HOMECOLLECTION_PERMISSIONS } from './permissions.js';
import { getTrackingByVisit, insertTracking, restartTracking, setTrackingPosition, stopTracking } from './repository/visitTracking.repo.js';
import { getVisitById } from './repository/visits.repo.js';
import { uuidv7 } from '../../../../../packages/shared-ts/src/uuidv7/index.js';

const PERM_SYNC_UPLOAD = HOMECOLLECTION_PERMISSIONS[5];   // 'homecollection.sync.upload'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DECIMAL = /^-?\d{1,3}(\.\d{1,6})?$/;
type Obj = Record<string, any>;
interface Ctx {
  readonly tenantId: string; readonly tx: { query(t: string, v?: unknown[]): Promise<{ rows: any[]; rowCount?: number | null }> };
  readonly actor: { readonly id: string; readonly membershipId?: string }; readonly now: () => Date;
  readonly db: { tx<T>(fn: (c: any) => Promise<T>): Promise<T> };
  readonly ports: { readonly IdentityPort: { assertRole(ctx: unknown, r: { permission: string }): Promise<void> } };
  readonly core: { readonly memberships: { list(ctx: unknown, i: Obj): Promise<ReadonlyArray<{ membershipId: string; displayName: string }>> } };
}

const coord = (v: unknown, max: number, path: string): string => {
  if (typeof v !== 'string' || !DECIMAL.test(v) || Math.abs(Number(v)) > max) throw bad(path);
  return v;
};

export const trackingDto = (row: Obj | null): Obj => row === null
  ? { state: 'not_started' }
  : {
      state: row['state'],
      started_at: new Date(row['started_at']).toISOString(),
      ...(row['stop_reason'] ? { stop_reason: row['stop_reason'] } : {}),
      ...(row['position_at'] ? { position_at: new Date(row['position_at']).toISOString() } : {}),
    };

async function displayName(ctx: Ctx, membershipId: string): Promise<string> {
  try {
    const rows = await ctx.db.tx((x) => ctx.core.memberships.list(x, { membershipIds: [membershipId], activeOnly: false }));
    const name = rows.find((r) => r.membershipId === membershipId)?.displayName;
    if (typeof name === 'string' && name.trim() !== '') return name.slice(0, 120);
  } catch { /* the name is cosmetic: tracking still starts */ }
  return 'Phlebotomist';
}

export async function updateVisitTracking(hctx: unknown, params: unknown, body: unknown): Promise<{ status: number; body: unknown }> {
  const ctx = hctx as Ctx;
  if (typeof ctx?.tenantId !== 'string' || !ctx.tx || typeof ctx.actor?.id !== 'string') throw new LimsError('auth.unauthenticated');
  await ctx.ports.IdentityPort.assertRole(ctx, { permission: PERM_SYNC_UPLOAD });
  const me = ctx.actor.membershipId;
  if (!me) throw new LimsError('auth.forbidden');
  const visitId = isObj(params) ? params['visit_id'] : undefined;
  if (typeof visitId !== 'string' || !UUID.test(visitId)) throw bad('/visit_id');
  if (!isObj(body)) throw bad('');
  noExtra(body, ['state', 'position']);
  const state = body['state'];
  if (state !== 'en_route' && state !== 'stopped') throw bad('/state');
  let position: { latitude: string; longitude: string; accuracyM: number | null } | undefined;
  if (body['position'] !== undefined) {
    const p = body['position'];
    if (!isObj(p) || state !== 'en_route') throw bad('/position');
    noExtra(p, ['latitude', 'longitude', 'accuracy_m']);
    const acc = p['accuracy_m'];
    if (acc !== undefined && (!Number.isInteger(acc) || acc < 0 || acc > 10000)) throw bad('/position/accuracy_m');
    position = { latitude: coord(p['latitude'], 90, '/position/latitude'), longitude: coord(p['longitude'], 180, '/position/longitude'), accuracyM: acc ?? null };
  }

  const visit = await getVisitById(ctx.tx, ctx.tenantId, visitId);   // RLS: invisible = not found
  if (!visit || visit['assigned_membership_id'] !== me) throw new LimsError('homecollection.visit_not_assigned');
  const now = ctx.now();

  if (state === 'stopped') {
    await stopTracking(ctx.tx, ctx.tenantId, visitId, 'stopped', now);
    return { status: 200, body: trackingDto(await getTrackingByVisit(ctx.tx, ctx.tenantId, visitId)) };
  }
  // Sharing is only for the trip: an arrived, closed or cancelled visit cannot be tracked.
  if (visit['status'] !== 'assigned') throw new LimsError('homecollection.visit_closed');

  let row = await getTrackingByVisit(ctx.tx, ctx.tenantId, visitId);
  if (!row || row['state'] !== 'en_route' || row['membership_id'] !== me) {
    const name = await displayName(ctx, me);
    const created = row ? null : await insertTracking(ctx.tx, ctx.tenantId, {
      id: uuidv7(), centre_id: visit['centre_id'], visit_id: visitId, membership_id: me, booking_id: visit['booking_id'] ?? null,
      collector_display_name: name, state: 'en_route', started_at: now,
    });
    row = created ?? await restartTracking(ctx.tx, ctx.tenantId, visitId, { membershipId: me, displayName: name, startedAt: now });
  }
  if (position) row = (await setTrackingPosition(ctx.tx, ctx.tenantId, visitId, me, { ...position, at: now })) ?? row;
  return { status: 200, body: trackingDto(row) };
}
