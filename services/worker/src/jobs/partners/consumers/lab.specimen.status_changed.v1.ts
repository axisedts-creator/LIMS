// Consumer lab.specimen.status_changed.v1 (02-TRD §7.2, 03-IC §3.7; US-07.1-07.5). The C0 wrapper already did the inbox insert + dedupe + schema validation, so this handler never
// touches partners.event_inbox. Steps: the order must be a partner order of THIS tenant (partners.order_tracking, locked FOR UPDATE: events of one order serialise) else
// ignored_not_partner; aggregate.seq must be strictly greater than the stored last_seq (else stale, nothing written); upsert the specimen row (partner / centre copied from the
// tracking row, never from the event); status fills its own timestamp column; tracking_status is re-derived (T1-T7) and last_event_at moves forward only.
// rejected: rejection_reason_code stays NULL (the event has none) and partners.reconcile_orders is enqueued for this order (job_key reconcile:<order_id>) to read it from the view.
import type { ConsumerHandler } from '../../../core/manifest.js';
import { countEvent, enqueueReconcile, rederive, UUID } from '../tasks/partners.reconcile_orders.js';

const EVENT = 'lab.specimen.status_changed.v1';
const STATUS_COLUMN: Readonly<Record<string, string>> = { collected: 'collected_at', in_transit: 'in_transit_at', received: 'received_at', rejected: 'rejected_at', reported: 'reported_at' };
const optUuid = (v: unknown): string | null => (typeof v === 'string' && UUID.test(v) ? v : null);

export const onSpecimenStatusChanged: ConsumerHandler = async (event, ctx) => {
  const tenantId = ctx.tenantId;
  if (typeof tenantId !== 'string' || event?.tenant_id !== tenantId) throw new Error(`partners consumer ${EVENT}: envelope tenant differs from the job tenant`);
  const p = event.payload ?? {}; const seq = event.aggregate?.seq;
  if (typeof p.specimen_id !== 'string' || !UUID.test(p.specimen_id) || typeof p.order_id !== 'string' || !UUID.test(p.order_id) || typeof p.to_status !== 'string'
    || typeof p.specimen_type_code !== 'string' || !Number.isInteger(seq) || seq < 0 || Number.isNaN(Date.parse(p.changed_at))) throw new TypeError(`partners consumer ${EVENT}: malformed event`);
  const tx = ctx.tx; const actor = ctx.actor.id; const now = ctx.now();

  const order = (await tx.query('SELECT partner_id, receiving_centre_id FROM partners.order_tracking WHERE tenant_id = $1 AND order_id = $2 FOR UPDATE', [tenantId, p.order_id])).rows[0];
  if (!order) return countEvent(ctx, EVENT, 'ignored_not_partner');

  const mine = (await tx.query('SELECT order_id, last_seq FROM partners.tracked_specimens WHERE tenant_id = $1 AND specimen_id = $2', [tenantId, p.specimen_id])).rows[0];
  if (mine && mine.order_id !== p.order_id) { ctx.log.warn({ event_type: EVENT }, 'specimen is projected under another order, event ignored'); return countEvent(ctx, EVENT, 'mismatch'); }
  if (mine && !(seq > mine.last_seq)) return countEvent(ctx, EVENT, 'stale'); // also the replay of an identical event

  const tsCol = STATUS_COLUMN[p.to_status]; const replaces = optUuid(p.replaces_specimen_id); const parent = optUuid(p.parent_specimen_id);
  if (!mine) {
    const cols = ['tenant_id', 'specimen_id', 'order_id', 'partner_id', 'receiving_centre_id', 'specimen_type_code', 'status', 'last_seq', 'changed_at', 'replaces_specimen_id', 'parent_specimen_id', 'created_by', 'updated_by'];
    const vals: unknown[] = [tenantId, p.specimen_id, p.order_id, order.partner_id, order.receiving_centre_id, p.specimen_type_code, p.to_status, seq, p.changed_at, replaces, parent, actor, actor];
    if (tsCol) { cols.push(tsCol); vals.push(p.changed_at); }
    await tx.query(`INSERT INTO partners.tracked_specimens (${cols.join(', ')}) VALUES (${vals.map((_, i) => `$${i + 1}`).join(', ')})`, vals);
  } else {
    const ps: unknown[] = [tenantId, p.specimen_id, p.to_status, seq, p.changed_at, now, actor]; const set = ['status = $3', 'last_seq = $4', 'changed_at = $5', 'updated_at = $6', 'updated_by = $7'];
    if (tsCol) { ps.push(p.changed_at); set.push(`${tsCol} = $${ps.length}`); }
    if (replaces) { ps.push(replaces); set.push(`replaces_specimen_id = coalesce(replaces_specimen_id, $${ps.length})`); }
    if (parent) { ps.push(parent); set.push(`parent_specimen_id = coalesce(parent_specimen_id, $${ps.length})`); }
    const r = await tx.query(`UPDATE partners.tracked_specimens SET ${set.join(', ')} WHERE tenant_id = $1 AND specimen_id = $2 AND last_seq < $4`, ps); // compare-and-set
    if (r.rowCount === 0) return countEvent(ctx, EVENT, 'stale');
  }

  await rederive(ctx, tenantId, p.order_id, { eventAt: p.changed_at });
  if (p.to_status === 'rejected') await enqueueReconcile(ctx, tenantId, p.order_id);
  countEvent(ctx, EVENT, 'applied');
};
