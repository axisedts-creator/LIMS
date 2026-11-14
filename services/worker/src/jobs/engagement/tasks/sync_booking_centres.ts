// engagement.sync_booking_centres (TRD §8.1, max_attempts 5; 08 A19 D-119): upserts the booking_centres projection (05-SCHEMA, system-written only) from core's centre list.
// Enqueued on every slot-template save (job key bcentres:<tenant_id>) and nightly by engagement.sync_booking_centres_nightly (TRD §8.2, 01:50 Asia/Kathmandu).
// Tenant guard (REQ-SEC-024): acts only when payload.tenant_id is a uuid equal to the job's tenant, otherwise resolves without running a statement.
// Centres missing from core's list or inactive there are deactivated, never deleted. Core failing -> throws (retry), nothing is deactivated.
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import type { TaskHandler } from '../../../core/manifest.js';

export const SYNC_BOOKING_CENTRES = 'engagement.sync_booking_centres';
export const SYNC_BOOKING_CENTRES_NIGHTLY = 'engagement.sync_booking_centres_nightly';
const MAX_ATTEMPTS = 5; // TRD §8.1
const ENQUEUE_SQL = 'SELECT app.enqueue_job($1, $2::jsonb, $3, $4, $5)'; // (identifier, payload, job_key, run_at, max_attempts)
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NAME_MAX = 200, ADDRESS_MAX = 300; // booking_centres__lengths__ck

const ownTenant = (payload: { tenant_id?: unknown }, ctxTenant: string | undefined): string | undefined => {
  const t = payload?.tenant_id;
  return typeof t === 'string' && UUID.test(t) && ctxTenant === t ? t : undefined;
};

export const syncBookingCentres: TaskHandler = async (payload, jobCtx) => {
  const ctx = jobCtx as any;
  const tenantId = ownTenant(payload, ctx.tenantId);
  if (!tenantId) return;
  const centres: Array<Record<string, any>> = [...(await ctx.core.centres(ctx, {}))]; // ALL centres of the tenant (any kind, active or not); a failure propagates = retry
  const now = ctx.now(), actor = ctx.actor.id;
  const seen = new Set<string>();
  for (const c of centres) {
    const name = typeof c['name'] === 'string' ? c['name'].slice(0, NAME_MAX) : '';
    if (!name) continue; // display_name CHECK needs >= 1 char: skip this centre, sync the others
    seen.add(c['id']);
    const address = typeof c['addressText'] === 'string' && c['addressText'] ? c['addressText'].slice(0, ADDRESS_MAX) : null;
    await ctx.tx.query(
      `INSERT INTO engagement.booking_centres (id, tenant_id, centre_id, branch_id, display_name, address_text, is_active, synced_at, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
       ON CONFLICT (tenant_id, centre_id) DO UPDATE SET branch_id = EXCLUDED.branch_id, display_name = EXCLUDED.display_name, address_text = EXCLUDED.address_text,
         is_active = EXCLUDED.is_active, synced_at = EXCLUDED.synced_at, updated_at = now(), updated_by = EXCLUDED.updated_by`,
      [uuidv7(), tenantId, c['id'], c['branchId'], name, address, c['isActive'] === true, now, actor]);
  }
  // projection rows whose centre core no longer lists: deactivate, keep (no DELETE)
  const { rows } = await ctx.tx.query('SELECT centre_id FROM engagement.booking_centres WHERE tenant_id = $1 AND is_active = true', [tenantId]);
  const gone = rows.map((r: any) => r.centre_id).filter((id: string) => !seen.has(id));
  if (gone.length) {
    await ctx.tx.query('UPDATE engagement.booking_centres SET is_active = false, synced_at = $3, updated_at = now(), updated_by = $4 WHERE tenant_id = $1 AND centre_id = ANY($2::uuid[])', [tenantId, gone, now, actor]);
  }
};

/** Nightly cron task: only enqueues the sync for its own tenant (never calls core, never writes the projection). */
export const syncBookingCentresNightly: TaskHandler = async (payload, jobCtx) => {
  const ctx = jobCtx as any;
  const tenantId = ownTenant(payload, ctx.tenantId);
  if (!tenantId) return;
  await ctx.tx.query(ENQUEUE_SQL, [SYNC_BOOKING_CENTRES, JSON.stringify({ tenant_id: tenantId }), `bcentres:${tenantId}`, null, MAX_ATTEMPTS]);
};
