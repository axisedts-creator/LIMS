// Shared helpers of the five inventory crons (C12.T-18; 02-TRD §9; 08 A13 P-6, A17 D-72). Every cron is per_tenant: the payload tenant must equal the job's tenant (REQ-SEC-024),
// the work runs as the system actor on ctx.tx, and every statement binds tenant_id = $1 (rc = { tx, tenantId, actorId }, same shape as T-15).
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import type { RepoCtx, Row } from '../../../../../api/src/modules/inventory/repository/_base.js';
import { query } from '../../../../../api/src/modules/inventory/repository/_base.js';
import { assertZone } from '../../../../../api/src/modules/inventory/domain/tenantTime.js';

/** The RepoCtx of a job, or null (and a warning) when the payload names another tenant than the job runs for. */
export function jobScope(name: string, payload: { tenant_id?: string } | null | undefined, jobCtx: unknown): RepoCtx | null {
  const ctx = jobCtx as any;
  const tenantId = ctx.tenantId;
  if (typeof tenantId !== 'string' || payload?.tenant_id !== tenantId) { // the payload can never widen the tenant scope
    ctx.log?.warn?.({ event: `${name}_skipped`, reason: 'bad_payload' });
    return null;
  }
  return { tx: ctx.tx, tenantId, actorId: ctx.actor.id as string };
}

/** Tenant timezone (core repo) validated; the clock instant comes from ctx.now(). */
export async function tenantClock(jobCtx: unknown): Promise<{ tz: string; nowMs: number }> {
  const ctx = jobCtx as any;
  return { tz: assertZone((await ctx.core.tenant(ctx)).timezone), nowMs: Date.parse(ctx.now()) };
}

export interface AlertRow { store_id?: string | null; item_id?: string | null; lot_id?: string | null; test_id?: string | null; key: string; details?: Record<string, unknown> }

/** ONE open alert per (tenant, dedupe_key): a repeat raise = occurrences + 1 (partial unique index alerts__tenant_id_dedupe__p_uq), same pattern as alerts.service. */
export async function raiseAlerts(rc: RepoCtx, kind: string, rows: readonly AlertRow[]): Promise<void> {
  if (rows.length === 0) return;
  const json = rows.map((r) => ({ id: uuidv7(), store_id: r.store_id ?? null, item_id: r.item_id ?? null, lot_id: r.lot_id ?? null, test_id: r.test_id ?? null, key: r.key, details: r.details ?? {} }));
  await query(rc, `INSERT INTO inventory.alerts (id, tenant_id, alert_kind, store_id, item_id, lot_id, test_id, dedupe_key, status, first_raised_at, last_raised_at, occurrences, details, created_by, updated_by)
    SELECT r.id, $1::uuid, $2, r.store_id, r.item_id, r.lot_id, r.test_id, r.key, 'open', now(), now(), 1, r.details, $3::uuid, $3::uuid
      FROM jsonb_to_recordset($4::jsonb) AS r(id uuid, store_id uuid, item_id uuid, lot_id uuid, test_id uuid, key text, details jsonb)
     ORDER BY r.key
    ON CONFLICT (tenant_id, dedupe_key) WHERE status <> 'resolved'
    DO UPDATE SET occurrences = alerts.occurrences + 1, last_raised_at = now(), version = alerts.version + 1, updated_at = now(), updated_by = EXCLUDED.updated_by`,
  [kind, rc.actorId, JSON.stringify(json)]);
}

/** Resolves the open / acknowledged alerts of `kind` whose dedupe key is no longer raised; retention floor: expires_at = resolved_at + 365 days (05-SCHEMA §11 [CONV]). */
export async function resolveGone(rc: RepoCtx, kind: string, liveKeys: readonly string[]): Promise<void> {
  await query(rc, `UPDATE inventory.alerts SET status = 'resolved', resolved_at = now(), expires_at = now() + interval '365 days', version = version + 1, updated_at = now(), updated_by = $3::uuid
     WHERE tenant_id = $1 AND alert_kind = $2 AND status <> 'resolved' AND NOT (dedupe_key = ANY($4::text[]))`, [kind, rc.actorId, liveKeys]);
}
