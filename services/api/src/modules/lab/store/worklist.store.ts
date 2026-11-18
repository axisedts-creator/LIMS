// Worklist / worksheet store (T-26 seam of service/worklist.service.ts) over repository/worklist.repo.ts. LD-124: caller's tx only, tenant = argument, RLS is the guard.
import * as repo from '../repository/worklist.repo.js';
import { LimsError } from '../../../core/errors.js';
import { rcOf, sql } from './scope.js';
import { POLICY_LATERAL } from './signoff.store.js';

type Obj = Record<string, any>;
export const worklistStore = () => ({
  listWorklistRows: async (tx: unknown, t: string, a: Obj) => repo.listWorklistRows(await rcOf(tx, t), a as never),
  listPendingRows: async (tx: unknown, t: string, a: Obj) => repo.listPendingRows(await rcOf(tx, t), a as never),
  getOrderTestsForWorksheet: async (tx: unknown, t: string, ids: string[]) => repo.getOrderTestsForWorksheet(await rcOf(tx, t), ids),
  insertWorksheet: async (tx: unknown, t: string, a: { worksheet: Obj; items: Obj[] }) => repo.insertWorksheet(await rcOf(tx, t), a),
  listWorksheets: async (tx: unknown, t: string, a: Obj) => repo.listWorksheets(await rcOf(tx, t), a as never),
  getWorksheet: async (tx: unknown, t: string, id: string) => repo.getWorksheet(await rcOf(tx, t), id),

  /** #34: results due for a sign-off with order / specimen context, oldest first; keyset on (queue_at, id). Filters are bound values only.
   *  T0B-VERLEVEL-1 (LD-316): stage verify = a non final sign-off is due (or the final one may be a verify: policy without a pathologist); stage approve = the next sign-off
   *  is the final one. Rows the caller already signed (this version) are left out: they are never theirs to act on. Counters + resolved level come along for next_step. */
  async listQueueRows(tx: unknown, t: string, a: { stage: 'verify' | 'approve'; callerId: string; departmentId?: string; priority?: string; flaggedOnly?: true; scopeCentreIds?: string[]; limit: number; after?: { key: string; id: string } }) {
    if (a.stage !== 'verify' && a.stage !== 'approve') throw new LimsError('common.internal');
    const at = 'COALESCE(r.resulted_at, r.created_at)';
    const count = `(CASE WHEN r.status = 'verified' AND rs.signoff_count = 0 THEN 1 ELSE rs.signoff_count END)`;   // legacy verified row: its verifier counts
    const required = 'COALESCE(rs.signoff_required, vp.vp_level, 2)';
    const final = `(${count} + 1 >= ${required})`;
    const where = ['r.tenant_id = $1', "r.status IN ('resulted','verified')", `${count} < ${required}`,
      a.stage === 'approve' ? final : `(NOT ${final} OR NOT COALESCE(vp.vp_pathologist, true))`,
      'NOT EXISTS (SELECT 1 FROM lab.result_signoff so WHERE so.tenant_id = r.tenant_id AND so.result_id = r.id AND so.result_version = r.current_version_no AND so.signer_user_id = $2::uuid)'];
    const v: unknown[] = [a.callerId];
    const bind = (x: unknown) => { v.push(x); return `$${v.length + 1}`; };
    if (a.departmentId !== undefined) where.push(`r.department_id = ${bind(a.departmentId)}`);
    if (a.priority !== undefined) where.push(`o.priority = ${bind(a.priority)}`);
    if (a.flaggedOnly) where.push(`(r.flag IS NOT NULL OR r.is_critical OR r.delta_status = 'fail' OR r.unit_mismatch OR cardinality(r.instrument_flags) > 0)`);
    if (a.scopeCentreIds) { const p = bind(a.scopeCentreIds); where.push(`(r.centre_id = ANY(${p}::uuid[]) OR r.processing_centre_id = ANY(${p}::uuid[]))`); }   // REQ-SEC-017
    if (a.after) { const k = bind(a.after.key), i = bind(a.after.id); where.push(`(${at}, r.id) > (${k}::timestamptz, ${i}::uuid)`); }
    const l = bind(Math.min(Math.max(Math.trunc(a.limit), 1), 201));
    return sql(tx, t, `SELECT r.*, rs.signoff_count, rs.signoff_required, vp.vp_level, ${at} AS queue_at, o.registration_no, o.priority AS order_priority, s.barcode FROM lab.v_result_current r
        JOIN lab.results rs ON rs.tenant_id = r.tenant_id AND rs.id = r.id ${POLICY_LATERAL('r')}
        JOIN lab.orders o ON o.tenant_id = r.tenant_id AND o.id = r.order_id LEFT JOIN lab.specimens s ON s.tenant_id = r.tenant_id AND s.id = r.specimen_id
        WHERE ${where.join(' AND ')} ORDER BY ${at}, r.id LIMIT ${l}`, v);
  },
});
