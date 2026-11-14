// Task micro.reconcile_chain_status (02-TRD §9; 01-PRD AC-17.1; 07-SECURITY P-6, REQ-SEC-024; 08 A13 P-6).
// per_tenant cron: runs in the per-job tx under the system claims of ctx.tenantId (the tenant comes from ctx only). For up to LIMS_MICRO_RECONCILE_BATCH
// open cultures older than 24 h: one LabPort.getOrderResults(all_visible) per order; C5 line `cancelled` -> culture `cancelled` / order_item_cancelled
// when it has no submitted version (+ transition, + open instrument records released as in M18), else only chain_cancelled = true (a submitted report is never changed).
// A LabPort or DB failure rejects (the job retries, TRD §9: 5 attempts); the error text is never logged.
import { LimsError } from '../../../../../api/src/core/errors.js';
import { loadMicroConfig } from '../../../../../api/src/modules/micro/config.js';
import { insertTransition, releaseOpenRecords } from '../../../../../api/src/modules/micro/repository/cultures.repo.js';
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import type { TaskHandler } from '../../../core/manifest.js';

type Row = Record<string, any>;
const REASON = 'order_item_cancelled';

// ponytail: oldest-first window; a tenant with more than the batch of old, never-cancelled cultures re-examines the same ones each day. Add a cursor if that ever happens.
const SELECT = `SELECT id, centre_id, order_id, order_item_id, status, current_report_version_no FROM micro.cultures
  WHERE tenant_id = $1 AND status <> 'cancelled' AND chain_cancelled = false AND received_at < now() - interval '24 hours'
  ORDER BY received_at, id LIMIT $2`;
const CANCEL = `UPDATE micro.cultures SET status = 'cancelled', cancel_reason_code = '${REASON}', cancelled_at = now(), version = version + 1, updated_at = now(), updated_by = $3
  WHERE tenant_id = $1 AND id = $2 AND status = $4 AND current_report_version_no = 0 AND chain_cancelled = false`;
const FLAG = `UPDATE micro.cultures SET chain_cancelled = true, version = version + 1, updated_at = now(), updated_by = $3
  WHERE tenant_id = $1 AND id = $2 AND status <> 'cancelled' AND chain_cancelled = false`;

/** The C5 line of a culture: the one whose moduleRef is micro/<culture id>, else the first line of its order item (same rule as M2/M18). */
function labLine(order: Row | undefined, c: Row): Row | undefined {
  const item = (order?.['items'] ?? []).find((i: Row) => i?.['orderItemId'] === c['order_item_id']);
  const lines: Row[] = Array.isArray(item?.['results']) ? item['results'] : [];
  return lines.find((l) => l?.['moduleRef']?.['module'] === 'micro' && l['moduleRef']['entityId'] === c['id']) ?? lines[0];
}

export const reconcileChainStatus: TaskHandler = async (payload, ctx) => {
  const tenantId = ctx.tenantId;
  if (!tenantId || (payload?.tenant_id !== undefined && payload.tenant_id !== tenantId)) throw new LimsError('common.internal', 'micro reconcile_chain_status: tenant mismatch');
  const tx = ctx.tx, userId = ctx.actor.id;
  const lab = (ctx as any).ports?.LabPort;
  const { rows } = await tx.query(SELECT, [tenantId, loadMicroConfig(process.env).reconcileBatch]);
  const byOrder = new Map<string, Row[]>();
  for (const c of rows as Row[]) byOrder.set(c['order_id'], [...(byOrder.get(c['order_id']) ?? []), c]);

  let cancelled = 0, flagged = 0;
  for (const [orderId, cultures] of byOrder) {
    const order = await lab.getOrderResults(ctx, { orderId, scope: 'all_visible' });
    for (const c of cultures) {
      if (labLine(order, c)?.['status'] !== 'cancelled') continue;
      if (Number(c['current_report_version_no']) > 0 || c['has_report']) {
        if ((await tx.query(FLAG, [tenantId, c['id'], userId])).rowCount) flagged++;
        continue;
      }
      if (!(await tx.query(CANCEL, [tenantId, c['id'], userId, c['status']])).rowCount) continue;   // changed since the read: the next run decides
      await insertTransition(tx, { id: uuidv7(), tenantId, centreId: c['centre_id'], cultureId: c['id'], from: c['status'], to: 'cancelled', reason: REASON, occurredAt: ctx.now(), userId });
      await releaseOpenRecords(tx, { tenantId, cultureId: c['id'], userId });
      cancelled++;
    }
  }
  ctx.log.info({ task: 'micro.reconcile_chain_status', examined: rows.length, orders: byOrder.size, cancelled, flagged }, 'micro reconcile_chain_status done');
};
