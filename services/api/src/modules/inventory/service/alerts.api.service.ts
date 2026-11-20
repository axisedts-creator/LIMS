// C12.T-26 #90 listInventoryAlerts / #91 acknowledgeInventoryAlert (02-TRD §5.9; 05-SCHEMA §2.27). Separate from alerts.service.ts (ledger hooks) so lots.service's paging helper
// can be reused without an import cycle (ledger.service -> alerts.service).
// Scope: an alert with a store is visible/actionable through that store's branch (404 for an invisible branch, then 403, P-B8); an alert without a store is tenant-wide.
// #91 order: load (404) -> scope (404/403) -> transition open -> acknowledged only (409 inventory.document_invalid_transition) -> If-Match (409 version_conflict).
import { LimsError } from '../../../core/errors.js';
import type { HandlerContext } from '../../../core/module.js';
import type { AlertListQuery } from '../handlers/alerts.schemas.js';
import { PERMISSIONS } from '../permissions.js';
import { updateAlert } from '../repository/alerts.repo.js';
import { type RepoCtx, type Row, Q, first, isUuid } from '../repository/_base.js';
import { page, wire } from './lots.service.js';
import { assertStoreAccess, listVisibleBranchIds } from './scope.service.js';

type Dto = Record<string, unknown>;
type Scope = Parameters<typeof assertStoreAccess>[0];
const rcOf = (ctx: HandlerContext): RepoCtx => ({ tx: ctx.tx as RepoCtx['tx'], tenantId: ctx.tenantId as string, actorId: ctx.actor?.id as string });
const sc = (ctx: HandlerContext): Scope => ctx as unknown as Scope;

const COLS = 'a.id, a.alert_kind, a.status, a.store_id, a.item_id, a.lot_id, a.instrument_id, a.test_id, a.first_raised_at, a.last_raised_at, a.occurrences, a.details, a.version';
const KEYS = ['id', 'alert_kind', 'status', 'store_id', 'item_id', 'lot_id', 'instrument_id', 'test_id', 'first_raised_at', 'last_raised_at', 'occurrences', 'version'];
const DETAIL_KEY = /^[a-z][a-z0-9_]{0,63}$/;

/** details jsonb object -> [{key, value}] (contract: <= 20 pairs, value <= 64 chars, numbers/codes only). */
function detailsOf(d: unknown): { key: string; value: string }[] {
  if (typeof d !== 'object' || d === null || Array.isArray(d)) return [];
  return Object.entries(d).filter(([k, v]) => DETAIL_KEY.test(k) && v !== null && typeof v !== 'object').slice(0, 20).map(([key, v]) => ({ key, value: String(v).slice(0, 64) }));
}
function dto(row: Row): Dto {
  const w = wire(row);
  return { ...Object.fromEntries(KEYS.filter((k) => w[k] !== undefined).map((k) => [k, w[k]])), details: detailsOf(row['details']) };
}
const alertRow = (rc: RepoCtx, id: string): Promise<Row | null> =>
  isUuid(id) ? first(rc, `SELECT ${COLS} FROM inventory.alerts a WHERE a.tenant_id = $1 AND a.id = $2`, [id]) : Promise.resolve(null);

export async function listAlerts(ctx: HandlerContext, f: AlertListQuery): Promise<Dto> {
  const rc = rcOf(ctx);
  if (f.store_id !== undefined) await assertStoreAccess(sc(ctx), f.store_id, PERMISSIONS.itemRead);
  const q = new Q();
  let w = ` AND a.status = ANY(${q.p(f.status)}::text[])`;
  if (f.alert_kind !== undefined) w += ` AND a.alert_kind = ${q.p(f.alert_kind)}`;
  if (f.store_id !== undefined) w += ` AND a.store_id = ${q.p(f.store_id)}`;
  else {
    const v = await listVisibleBranchIds(sc(ctx)); // tenant-wide alerts (no store) are always visible; store alerts only through a visible branch
    if (!v.all) w += ` AND (a.store_id IS NULL OR a.store_id IN (SELECT id FROM inventory.stores WHERE tenant_id = $1 AND branch_id = ANY(${q.p([...v.branchIds])}::uuid[])))`;
  }
  const key = `(to_char(a.last_raised_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') COLLATE "C")`;
  const { rows, page: pg } = await page(rc, { select: COLS, from: 'inventory.alerts a', tenantCol: 'a.tenant_id', idCol: 'a.id', where: w, q, key, dir: 'DESC', p: f });
  return { data: rows.map(dto), page: pg };
}

export async function acknowledgeAlert(ctx: HandlerContext, alertId: string, ifMatch: number): Promise<Dto> {
  const rc = rcOf(ctx);
  const cur = await alertRow(rc, alertId);
  if (cur === null) throw new LimsError('common.not_found');
  if (cur['store_id'] !== null) await assertStoreAccess(sc(ctx), cur['store_id'], PERMISSIONS.stockManage);
  else await ctx.ports.IdentityPort.assertRole(ctx, { permission: PERMISSIONS.stockManage });
  if (cur['status'] !== 'open') throw new LimsError('inventory.document_invalid_transition'); // acknowledged / resolved: nothing to acknowledge
  if (cur['version'] !== ifMatch) throw new LimsError('common.version_conflict');
  await updateAlert(rc, alertId, ifMatch, { status: 'acknowledged', acknowledged_at: new Date().toISOString(), acknowledged_by: rc.actorId });
  return dto((await alertRow(rc, alertId)) as Row);
}
