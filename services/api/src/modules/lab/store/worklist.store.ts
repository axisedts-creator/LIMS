// Worklist / worksheet store (T-26 seam of service/worklist.service.ts) over repository/worklist.repo.ts. LD-124: caller's tx only, tenant = argument, RLS is the guard.
import * as repo from '../repository/worklist.repo.js';
import { LimsError } from '../../../core/errors.js';
import { rcOf, sql } from './scope.js';

type Obj = Record<string, any>;
export const worklistStore = () => ({
  listWorklistRows: async (tx: unknown, t: string, a: Obj) => repo.listWorklistRows(await rcOf(tx, t), a as never),
  listPendingRows: async (tx: unknown, t: string, a: Obj) => repo.listPendingRows(await rcOf(tx, t), a as never),
  getOrderTestsForWorksheet: async (tx: unknown, t: string, ids: string[]) => repo.getOrderTestsForWorksheet(await rcOf(tx, t), ids),
  insertWorksheet: async (tx: unknown, t: string, a: { worksheet: Obj; items: Obj[] }) => repo.insertWorksheet(await rcOf(tx, t), a),
  listWorksheets: async (tx: unknown, t: string, a: Obj) => repo.listWorksheets(await rcOf(tx, t), a as never),
  getWorksheet: async (tx: unknown, t: string, id: string) => repo.getWorksheet(await rcOf(tx, t), id),

  /** #34: results in `status` (resulted | verified) with order / specimen context, oldest first; keyset on (queue_at, id). Filters are bound values only. */
  async listQueueRows(tx: unknown, t: string, a: { status: 'resulted' | 'verified'; departmentId?: string; priority?: string; flaggedOnly?: true; scopeCentreIds?: string[]; limit: number; after?: { key: string; id: string } }) {
    if (a.status !== 'resulted' && a.status !== 'verified') throw new LimsError('common.internal');
    const at = 'COALESCE(r.resulted_at, r.created_at)';
    const where = ['r.tenant_id = $1', 'r.status = $2'];
    const v: unknown[] = [a.status];
    const bind = (x: unknown) => { v.push(x); return `$${v.length + 1}`; };
    if (a.departmentId !== undefined) where.push(`r.department_id = ${bind(a.departmentId)}`);
    if (a.priority !== undefined) where.push(`o.priority = ${bind(a.priority)}`);
    if (a.flaggedOnly) where.push(`(r.flag IS NOT NULL OR r.is_critical OR r.delta_status = 'fail' OR r.unit_mismatch OR cardinality(r.instrument_flags) > 0)`);
    if (a.scopeCentreIds) { const p = bind(a.scopeCentreIds); where.push(`(r.centre_id = ANY(${p}::uuid[]) OR r.processing_centre_id = ANY(${p}::uuid[]))`); }   // REQ-SEC-017
    if (a.after) { const k = bind(a.after.key), i = bind(a.after.id); where.push(`(${at}, r.id) > (${k}::timestamptz, ${i}::uuid)`); }
    const l = bind(Math.min(Math.max(Math.trunc(a.limit), 1), 201));
    return sql(tx, t, `SELECT r.*, ${at} AS queue_at, o.registration_no, o.priority AS order_priority, s.barcode FROM lab.v_result_current r
        JOIN lab.orders o ON o.tenant_id = r.tenant_id AND o.id = r.order_id LEFT JOIN lab.specimens s ON s.tenant_id = r.tenant_id AND s.id = r.specimen_id
        WHERE ${where.join(' AND ')} ORDER BY ${at}, r.id LIMIT ${l}`, v);
  },
});
