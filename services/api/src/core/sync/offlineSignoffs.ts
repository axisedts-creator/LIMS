// T0B-SYNC-4 (LD-322 decision 2; design C:/LIMS-state/offline-design-20261117.md sections 3 and 8): what result.verify and report.print_marker
// share. The sign off outcomes a print relied on, the offline print markers and the lab manager alerts are stored in core.sync_signoff_outcome,
// core.sync_print_marker and core.sync_alert (migration 20261118100000; [CR .orchestra/cr/T0B-SYNC-4.nonblocking.md]). Every statement runs on the
// operation's ctx.tx under RLS with the tenant of ctx; ids and codes only, never a value or a name (design section 6).
import { uuidv7 } from '../../../../../packages/shared-ts/src/uuidv7/index.js';
import type { HandlerContext } from '../module.js';

export type ResultState = { status: string; version: number; specimenStatus?: string };
/** undefined = unknown, other tenant or out of the caller's centre scope. */
export type ReadResult = (ctx: HandlerContext, resultId: string) => Promise<ResultState | undefined>;
export interface Alert { kind: 'result_locked' | 'verification_policy_failed'; opId: string; resultId?: string; code?: string; reportVersionIds?: string[] }
export interface Alerts { raise(ctx: HandlerContext, a: Alert): Promise<void> }
export type MarkerState = 'pending' | 'confirmed' | 'recall_required';
export interface Marker { opId: string; reportVersionId: string; deviceId: string; resultIds: string[]; state: MarkerState }
export interface Signoffs {
  recordVerify(ctx: HandlerContext, v: { opId: string; deviceId: string; resultId: string; outcome: 'accepted' | 'rejected'; deviceCreatedAt: string }): Promise<void>;
  reliedVerifies(ctx: HandlerContext, q: { deviceId: string; resultIds: string[] }): Promise<Array<{ opId: string; resultId: string; outcome: string }>>;
  addMarker(ctx: HandlerContext, m: { opId: string; reportVersionId: string; resultIds: string[]; deviceId: string; deviceCreatedAt: string }): Promise<void>;
  markersForResult(ctx: HandlerContext, resultId: string): Promise<Marker[]>;
  setMarkerState(ctx: HandlerContext, opId: string, state: 'confirmed' | 'recall_required'): Promise<void>;
}

/** A result the server holds as signed off: further entry is locked, a print showing it may be confirmed. */
export const FINAL_RESULT = new Set(['verified', 'approved']);

const q = (ctx: HandlerContext, text: string, values: unknown[]) => (ctx as any).tx.query(text, values) as Promise<{ rows: any[] }>;

export const syncAlerts: Alerts = {
  async raise(ctx, a) {
    await q(ctx, 'INSERT INTO core.sync_alert (id, tenant_id, kind, op_id, result_id, code, report_version_ids) VALUES ($1, $2, $3, $4, $5, $6, $7::uuid[])',
      [uuidv7(), ctx.tenantId, a.kind, a.opId, a.resultId ?? null, a.code ?? null, a.reportVersionIds ?? []]);
  },
};

export const syncSignoffs: Signoffs = {
  async recordVerify(ctx, v) {
    await q(ctx, 'INSERT INTO core.sync_signoff_outcome (tenant_id, op_id, device_id, result_id, outcome, device_created_at) VALUES ($1, $2, $3, $4, $5, $6)',
      [ctx.tenantId, v.opId, v.deviceId, v.resultId, v.outcome, v.deviceCreatedAt]);
  },
  async reliedVerifies(ctx, x) {
    const r = await q(ctx, `SELECT op_id, result_id, outcome FROM core.sync_signoff_outcome WHERE tenant_id = $1 AND device_id = $2 AND result_id = ANY($3::uuid[])
      ORDER BY created_at, op_id`, [ctx.tenantId, x.deviceId, x.resultIds]);
    return r.rows.map((w) => ({ opId: w.op_id, resultId: w.result_id, outcome: w.outcome }));
  },
  async addMarker(ctx, m) {
    await q(ctx, `INSERT INTO core.sync_print_marker (tenant_id, op_id, report_version_id, result_ids, device_id, state, device_created_at) VALUES ($1, $2, $3, $4::uuid[], $5, 'pending', $6)`,
      [ctx.tenantId, m.opId, m.reportVersionId, m.resultIds, m.deviceId, m.deviceCreatedAt]);
  },
  async markersForResult(ctx, resultId) {
    const r = await q(ctx, `SELECT op_id, report_version_id, device_id, result_ids, state FROM core.sync_print_marker WHERE tenant_id = $1 AND result_ids @> ARRAY[$2::uuid]
      ORDER BY op_id LIMIT 500`, [ctx.tenantId, resultId]);
    return r.rows.map((w) => ({ opId: w.op_id, reportVersionId: w.report_version_id, deviceId: w.device_id, resultIds: w.result_ids, state: w.state }));
  },
  async setMarkerState(ctx, opId, state) {
    await q(ctx, 'UPDATE core.sync_print_marker SET state = $3, updated_at = now() WHERE tenant_id = $1 AND op_id = $2', [ctx.tenantId, opId, state]);
  },
};

/** Print path seam (reporting print.service PrintCtx.offlineMarkers): a pending offline print marker exists for the report version. */
export const pendingMarkers = {
  async isPending(tx: { query(t: string, v: unknown[]): Promise<{ rows: any[] }> }, tenantId: string, reportVersionId: string): Promise<boolean> {
    return (await tx.query(`SELECT 1 FROM core.sync_print_marker WHERE tenant_id = $1 AND report_version_id = $2 AND state = 'pending' LIMIT 1`, [tenantId, reportVersionId])).rows.length > 0;
  },
};

/** The marker rule (pinned, ./__tests__/adapters/doubles4.ts): a PENDING marker becomes recall_required (+ alert with its report id) when a sign off it
 *  relied on (a verify of one of its results synced from the printing device) was rejected; confirmed when none was and every result is final on
 *  the server; otherwise it stays pending. confirmed and recall_required markers are left alone (a recall is only raised by a rejected verify). */
export async function settleMarker(ctx: HandlerContext, d: { readResult: ReadResult; signoffs: Signoffs; alerts: Alerts }, m: Marker): Promise<MarkerState> {
  if (m.state !== 'pending') return m.state;
  const relied = await d.signoffs.reliedVerifies(ctx, { deviceId: m.deviceId, resultIds: m.resultIds });
  const bad = relied.find((v) => v.outcome === 'rejected');
  if (bad) {
    await d.signoffs.setMarkerState(ctx, m.opId, 'recall_required');
    await d.alerts.raise(ctx, { kind: 'verification_policy_failed', opId: m.opId, resultId: bad.resultId, reportVersionIds: [m.reportVersionId] });
    return 'recall_required';
  }
  for (const id of m.resultIds) {
    const r = await d.readResult(ctx, id);
    if (!r || !FINAL_RESULT.has(r.status)) return 'pending';
  }
  await d.signoffs.setMarkerState(ctx, m.opId, 'confirmed');
  return 'confirmed';
}
