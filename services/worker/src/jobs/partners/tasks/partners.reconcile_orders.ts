// partners.reconcile_orders (02-TRD §8.1, §8.2 every 10 min; 03-APP-FLOW §5.3/§5.4; US-07.5, US-07.7). Fills what events missed from the published views:
//   frontdesk.v_pub_order_status (cancellation, stored_order_status) and lab.v_pub_specimen_timeline (specimen status / timestamps / rejection reason / replaces link).
// Payload {tenant_id} = tick (every non-terminal order of the tenant touched in the last 30 days + the converting-line sweep), {tenant_id, partner_id} = one partner's orders,
// {tenant_id, order_id} = exactly that order (no window). One run = one transaction (the job's): a throw anywhere rolls the whole run back. Every value is a bound parameter.
// Rules: a timeline row with specimen_version > last_seq moves the projection forward; one that is not newer never moves the status backwards but still fills NULL
// timestamps / NULL rejection_reason_code (the event carries no reason). 'cancelled' and 'reported' orders are never scanned, so they never revert.
// Also exports the shared tracking helpers used by the T12 consumers (rederive, metric).
import type { JobContext, TaskHandler } from '../../../core/manifest.js';
import { deriveTrackingStatus } from '../../../../../api/src/modules/partners/domain/tracking-status.js';
import { scopeOf } from './partners.sync_price_list.js';

export const RECONCILE_TASK = 'partners.reconcile_orders';
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_MS = 86_400_000;
const WINDOW_MS = 30 * DAY_MS;
const CONVERTING_MS = 30 * 60_000;
const CHUNK = 500; // order ids per view read
const TS_COLS = ['collected_at', 'in_transit_at', 'received_at', 'rejected_at', 'reported_at'] as const;
const STORED_STATUSES = new Set(['pre_registered', 'registered', 'cancelled']); // order_tracking__stored__ck

export const ms = (v: unknown): number => (v instanceof Date ? v.getTime() : Date.parse(String(v)));

/** TRD §9 lims_partners_events_consumed_total{event_type, outcome}. */
export function countEvent(ctx: JobContext, eventType: string, outcome: 'applied' | 'ignored_not_partner' | 'stale' | 'duplicate' | 'mismatch'): void {
  (ctx as unknown as { metrics?: { inc(n: string, l?: Record<string, string>): void } }).metrics?.inc('lims_partners_events_consumed_total', { event_type: eventType, outcome });
}

/**
 * Re-derive order_tracking.tracking_status (T1-T7, domain/tracking-status.ts) from the line state, the order's specimens and report versions; write only what changed.
 * eventAt moves last_event_at forward (never back); countReports also refreshes report_count (= valid versions).
 */
export async function rederive(ctx: JobContext, tenantId: string, orderId: string, o: { eventAt?: unknown; countReports?: boolean } = {}): Promise<void> {
  const tx = ctx.tx;
  const t = (await tx.query('SELECT tracking_status, line_id, last_event_at, report_count FROM partners.order_tracking WHERE tenant_id = $1 AND order_id = $2', [tenantId, orderId])).rows[0];
  if (!t) return;
  const line = (await tx.query('SELECT state FROM partners.manifest_lines WHERE tenant_id = $1 AND id = $2', [tenantId, t.line_id])).rows[0];
  const specimens = (await tx.query('SELECT specimen_id, status, replaces_specimen_id FROM partners.tracked_specimens WHERE tenant_id = $1 AND order_id = $2', [tenantId, orderId])).rows;
  const reports = (await tx.query('SELECT kind, status FROM partners.order_reports WHERE tenant_id = $1 AND order_id = $2', [tenantId, orderId])).rows;
  const cancelled = t.tracking_status === 'cancelled' || line?.state === 'cancelled'; // terminal: a late event never revives it
  const status = deriveTrackingStatus({
    lineState: cancelled ? 'cancelled' : String(line?.state ?? ''),
    specimens: specimens.map((s: any) => ({ id: s.specimen_id, status: s.status, replacesSpecimenId: s.replaces_specimen_id })),
    reports: reports.map((r: any) => ({ kind: r.kind, status: r.status })),
  });
  const set: string[] = []; const params: unknown[] = [tenantId, orderId];
  const add = (col: string, v: unknown) => { params.push(v); set.push(`${col} = $${params.length}`); };
  if (status !== t.tracking_status) add('tracking_status', status);
  if (o.eventAt != null && !(ms(o.eventAt) <= ms(t.last_event_at))) add('last_event_at', o.eventAt);
  const count = reports.filter((r: any) => r.status === 'valid').length;
  if (o.countReports && count !== t.report_count) add('report_count', count);
  if (set.length === 0) return;
  add('updated_at', ctx.now()); add('updated_by', ctx.actor.id);
  await tx.query(`UPDATE partners.order_tracking SET ${set.join(', ')} WHERE tenant_id = $1 AND order_id = $2`, params);
}

const enqueueSql = 'SELECT app.enqueue_job($1, $2::jsonb, $3)';
export const enqueueReconcile = (ctx: JobContext, tenantId: string, orderId: string) =>
  ctx.tx.query(enqueueSql, [RECONCILE_TASK, JSON.stringify({ tenant_id: tenantId, order_id: orderId }), `reconcile:${orderId}`]);

const chunks = <T>(a: T[]): T[][] => { const out: T[][] = []; for (let i = 0; i < a.length; i += CHUNK) out.push(a.slice(i, i + CHUNK)); return out; };

export const reconcileOrdersTask: TaskHandler = async (payload, ctx) => {
  const { tenantId, partnerId } = scopeOf(payload, ctx);
  const orderId = payload['order_id'];
  if (orderId !== undefined && (typeof orderId !== 'string' || !UUID.test(orderId))) throw new TypeError('partners.reconcile_orders: order_id is not a uuid');
  const tx = ctx.tx; const now = ctx.now(); const nowDate = new Date(now); const actor = ctx.actor.id;

  // 1. orders in scope (terminal orders are never scanned; the tick and a partner scope are bounded to the last 30 days)
  const where = ['tenant_id = $1', "tracking_status NOT IN ('reported', 'cancelled')"]; const params: unknown[] = [tenantId];
  const bind = (v: unknown) => `$${params.push(v)}`;
  if (partnerId !== undefined) where.push(`partner_id = ${bind(partnerId)}`);
  if (orderId !== undefined) where.push(`order_id = ${bind(orderId)}`); else where.push(`updated_at >= ${bind(new Date(nowDate.getTime() - WINDOW_MS))}`);
  // ponytail: whole scope held in memory + 3 reads per order in rederive(); fine for the 30-day non-terminal window, page the scan if a tenant outgrows it
  const orders: any[] = (await tx.query(`SELECT order_id, partner_id, receiving_centre_id, tracking_status FROM partners.order_tracking WHERE ${where.join(' AND ')}`, params)).rows;

  for (const batch of chunks(orders)) {
    const ids = batch.map((o) => o.order_id);
    const views: any[] = (await tx.query('SELECT order_id, status FROM frontdesk.v_pub_order_status WHERE tenant_id = $1 AND order_id = ANY($2::uuid[])', [tenantId, ids])).rows;
    const line: any[] = (await tx.query('SELECT specimen_id, order_id, specimen_type_code, status, specimen_version, collected_at, in_transit_at, received_at, rejected_at, reported_at, rejection_reason_code, '
      + 'parent_specimen_id, replaces_specimen_id FROM lab.v_pub_specimen_timeline WHERE tenant_id = $1 AND order_id = ANY($2::uuid[])', [tenantId, ids])).rows;
    const have = new Map<string, any>(((await tx.query('SELECT specimen_id, order_id, status, last_seq, rejection_reason_code, collected_at, in_transit_at, received_at, rejected_at, reported_at '
      + 'FROM partners.tracked_specimens WHERE tenant_id = $1 AND order_id = ANY($2::uuid[])', [tenantId, ids])).rows as any[]).map((r) => [r.specimen_id, r]));
    const viewOf = new Map<string, string>(views.map((v) => [v.order_id, v.status]));

    // 2. order level: cancellation + stored_order_status + reconciled_at (a cancelled order is terminal from here on)
    for (const o of batch) {
      const st = viewOf.get(o.order_id);
      const cancel = st === 'cancelled' && o.tracking_status !== 'cancelled';
      const ps: unknown[] = [tenantId, o.order_id, now, st !== undefined && STORED_STATUSES.has(st) ? st : null];
      let set = 'reconciled_at = $3, stored_order_status = coalesce($4, stored_order_status)';
      if (cancel) { ps.push(actor); set += ", tracking_status = 'cancelled', cancelled_at = $3, updated_at = $3, updated_by = $5"; }
      await tx.query(`UPDATE partners.order_tracking SET ${set} WHERE tenant_id = $1 AND order_id = $2`, ps);
    }

    // 3. specimen level: timeline vs projection
    const byOrder = new Map<string, any>(batch.map((o) => [o.order_id, o]));
    for (const v of line) {
      const order = byOrder.get(v.order_id); const mine = have.get(v.specimen_id);
      if (!order || (mine && mine.order_id !== v.order_id)) continue;
      const stamps = TS_COLS.map((c) => v[c]).filter((x) => x != null);
      const changedAt = stamps.length ? new Date(Math.max(...stamps.map(ms))) : null;
      const version = Number(v.specimen_version);
      if (!mine) {
        const cols = ['tenant_id', 'specimen_id', 'order_id', 'partner_id', 'receiving_centre_id', 'specimen_type_code', 'status', 'last_seq', 'changed_at', 'replaces_specimen_id', 'parent_specimen_id',
          'rejection_reason_code', ...TS_COLS, 'created_by', 'updated_by'];
        const vals = [tenantId, v.specimen_id, v.order_id, order.partner_id, order.receiving_centre_id, v.specimen_type_code, v.status, version, changedAt ?? nowDate, v.replaces_specimen_id ?? null,
          v.parent_specimen_id ?? null, v.rejection_reason_code ?? null, ...TS_COLS.map((c) => v[c] ?? null), actor, actor];
        await tx.query(`INSERT INTO partners.tracked_specimens (${cols.join(', ')}) VALUES (${vals.map((_, i) => `$${i + 1}`).join(', ')})`, vals);
        continue;
      }
      const ps: unknown[] = [tenantId, v.specimen_id]; const set: string[] = [];
      const put = (col: string, val: unknown) => { ps.push(val); set.push(`${col} = $${ps.length}`); };
      if (version > Number(mine.last_seq)) {
        put('status', v.status); put('last_seq', version); const seqParam = ps.length;
        if (changedAt) put('changed_at', changedAt);
        for (const c of TS_COLS) if (v[c] != null) put(c, v[c]);
        if (v.rejection_reason_code != null) put('rejection_reason_code', v.rejection_reason_code);
        if (v.replaces_specimen_id != null) put('replaces_specimen_id', v.replaces_specimen_id);
        if (v.parent_specimen_id != null) put('parent_specimen_id', v.parent_specimen_id);
        put('updated_at', now); put('updated_by', actor);
        // compare-and-set: a concurrent newer event (last_seq >= version) wins
        await tx.query(`UPDATE partners.tracked_specimens SET ${set.join(', ')} WHERE tenant_id = $1 AND specimen_id = $2 AND last_seq < $${seqParam}`, ps);
        continue;
      }
      // not newer: never move the status; only fill gaps (NULL timestamps, the rejection reason the event did not carry)
      for (const c of TS_COLS) if (mine[c] == null && v[c] != null) put(c, v[c]);
      if (mine.rejection_reason_code == null && v.rejection_reason_code != null) put('rejection_reason_code', v.rejection_reason_code);
      if (set.length === 0) continue;
      put('updated_at', now); put('updated_by', actor);
      await tx.query(`UPDATE partners.tracked_specimens SET ${set.join(', ')} WHERE tenant_id = $1 AND specimen_id = $2`, ps);
    }

    // 4. tracking_status follows (T1-T7)
    for (const o of batch) await rederive(ctx, tenantId, o.order_id);
  }

  // 5. converting lines stuck > 30 min (tick only): the conversion worker died; surface as conversion_failed
  if (partnerId === undefined && orderId === undefined) {
    await tx.query("UPDATE partners.manifest_lines SET state = 'conversion_failed', failure_code = 'common.internal', failed_at = $2, updated_at = $2, updated_by = $4 "
      + "WHERE tenant_id = $1 AND state = 'converting' AND updated_at < $3", [tenantId, now, new Date(nowDate.getTime() - CONVERTING_MS), actor]);
  }
};
