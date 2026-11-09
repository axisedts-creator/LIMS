// Live reads on published source views (02-TRD §6.8; 07-SECURITY P1, P4). One bound SELECT, explicit columns, tenant `$1`,
// scope `$2` (all-centres flag) / `$3` (centre ids). Nothing from input is part of the statement text.
import { checkScope, int, type RollupScope } from './rollups.repo.js';

export interface SourceViewsTx { query(text: string, values?: unknown[]): Promise<{ rows: any[] }> }
export interface AgentStatusRow { agent_id: string; centre_id: string; state: string; last_heartbeat_at: string; agent_version: string; queue_depth: number }

export async function listAgentStatus(tx: SourceViewsTx, a: { readonly tenantId: string; readonly scope: RollupScope }): Promise<AgentStatusRow[]> {
  const scope = checkScope(a.scope);
  if (!scope.all && scope.centreIds.length === 0) return []; // empty restricted scope sees nothing
  const { rows } = await tx.query(
    `SELECT agent_id, centre_id, state, last_heartbeat_at, agent_version, queue_depth
FROM instruments.v_pub_agent_status
WHERE tenant_id = $1 AND ($2 OR (centre_id IS NOT NULL AND centre_id = ANY ($3)))
ORDER BY agent_id`,
    [a.tenantId, scope.all, [...scope.centreIds]],
  );
  return rows.map((r) => {
    const depth = Number(r.queue_depth);
    if (!Number.isSafeInteger(depth)) throw new RangeError('sourceViews: queue_depth is not a safe integer');
    return {
      agent_id: String(r.agent_id), centre_id: String(r.centre_id), state: String(r.state),
      last_heartbeat_at: r.last_heartbeat_at instanceof Date ? r.last_heartbeat_at.toISOString() : String(r.last_heartbeat_at),
      agent_version: String(r.agent_version), queue_depth: depth,
    };
  });
}

// ------------------------------------------------------------------ AN-T13: live pending items (TRD §6.7; 08 A13 D-13, A17 D-49)
// Runs in the CALLER'S tx: centre scope comes from C5's RLS on lab.order_tests through the invoker view. There is NO implicit centre predicate:
// `centre_id` appears in the statement only for an explicit `centreIds` filter ([] matches nothing, never "no predicate").
export type AgeBucket = 'lt_4h' | 'h4_24' | 'd1_3' | 'gt_3d';
export interface PendingFilters {
  readonly tenantId: string;
  readonly centreIds?: readonly string[] | undefined; readonly departmentIds?: readonly string[] | undefined; readonly priority?: 'routine' | 'urgent' | undefined;
  readonly processingBranchIds?: readonly string[] | undefined;
}
export interface PendingSummaryRow { item_status: string; priority: string; department_id: string; age_bucket: AgeBucket; n: number; overdue: number; no_target: number }
export interface PendingItemsArgs extends PendingFilters {
  readonly itemStatuses?: readonly string[] | undefined; readonly overdueOnly?: boolean | undefined;
  readonly sort: '-age_seconds' | 'age_seconds'; readonly after?: { readonly age_seconds: number; readonly order_item_id: string } | undefined; readonly limit: number;
}
export interface PendingItemRow {
  order_item_id: string; order_id: string; centre_id: string; processing_branch_id: string | null; department_id: string; test_id: string;
  priority: 'routine' | 'urgent'; item_status: string; age_seconds: number; tat_target_seconds: number | null;
}

/** WHERE tail (starting with " AND ") for the explicit filters; values are pushed after $1. null = an empty centre filter: nothing can match. */
function pendingWhere(a: PendingFilters, values: unknown[]): string | null {
  if (typeof a.tenantId !== 'string' || a.tenantId === '') throw new TypeError('sourceViews: tenantId is mandatory');
  if (a.priority !== undefined && a.priority !== 'routine' && a.priority !== 'urgent') throw new TypeError('sourceViews: priority outside routine|urgent');
  if (a.centreIds !== undefined && a.centreIds.length === 0) return null;
  const bind = (v: unknown): string => { values.push(v); return `$${values.length}`; };
  let w = '';
  if (a.centreIds !== undefined) w += ` AND centre_id = ANY (${bind([...a.centreIds])})`;
  if (a.departmentIds?.length) w += ` AND department_id = ANY (${bind([...a.departmentIds])})`;
  if (a.priority !== undefined) w += ` AND priority = ${bind(a.priority)}`;
  if (a.processingBranchIds?.length) w += ` AND processing_branch_id = ANY (${bind([...a.processingBranchIds])})`;
  return w;
}

export async function pendingSummaryRows(tx: SourceViewsTx, a: PendingFilters): Promise<PendingSummaryRow[]> {
  const values: unknown[] = [a.tenantId];
  const where = pendingWhere(a, values);
  if (where === null) return [];
  const { rows } = await tx.query(
    `SELECT item_status, priority, department_id,
       CASE WHEN age_seconds < 14400 THEN 'lt_4h' WHEN age_seconds < 86400 THEN 'h4_24'
            WHEN age_seconds < 259200 THEN 'd1_3' ELSE 'gt_3d' END AS age_bucket,
       count(*) AS n,
       count(*) FILTER (WHERE tat_target_seconds IS NOT NULL AND age_seconds > tat_target_seconds) AS overdue,
       count(*) FILTER (WHERE tat_target_seconds IS NULL) AS no_target
FROM lab.v_pub_pending_items
WHERE tenant_id = $1${where}
GROUP BY 1, 2, 3, 4`,
    values,
  );
  return rows.map((r) => ({
    item_status: String(r.item_status), priority: String(r.priority), department_id: String(r.department_id), age_bucket: r.age_bucket as AgeBucket,
    n: int(r.n, 'n'), overdue: int(r.overdue, 'overdue'), no_target: int(r.no_target, 'no_target'),
  }));
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ITEM_COLS = 'order_item_id, order_id, centre_id, processing_branch_id, department_id, test_id, priority, item_status, age_seconds, tat_target_seconds';

export async function pendingItems(tx: SourceViewsTx, a: PendingItemsArgs): Promise<PendingItemRow[]> {
  if (a.sort !== '-age_seconds' && a.sort !== 'age_seconds') throw new TypeError('sourceViews: sort outside the allow-list');
  if (!Number.isInteger(a.limit) || a.limit < 1 || a.limit > 201) throw new RangeError('sourceViews: limit outside 1..201');
  if (a.after !== undefined && (!Number.isSafeInteger(a.after.age_seconds) || typeof a.after.order_item_id !== 'string' || !UUID.test(a.after.order_item_id))) {
    throw new TypeError('sourceViews: malformed keyset position');
  }
  const values: unknown[] = [a.tenantId];
  let where = pendingWhere(a, values);
  if (where === null) return [];
  const bind = (v: unknown): string => { values.push(v); return `$${values.length}`; };
  const desc = a.sort === '-age_seconds';
  if (a.itemStatuses?.length) where += ` AND item_status = ANY (${bind([...a.itemStatuses])})`;
  if (a.overdueOnly) where += ' AND tat_target_seconds IS NOT NULL AND age_seconds > tat_target_seconds';
  if (a.after) {
    const age = bind(a.after.age_seconds);
    where += ` AND (age_seconds ${desc ? '<' : '>'} ${age} OR (age_seconds = ${age} AND order_item_id > ${bind(a.after.order_item_id)}))`;
  }
  const { rows } = await tx.query(
    `SELECT ${ITEM_COLS}
FROM lab.v_pub_pending_items
WHERE tenant_id = $1${where}
ORDER BY age_seconds ${desc ? 'DESC' : 'ASC'}, order_item_id ASC
LIMIT ${bind(a.limit)}`,
    values,
  );
  return rows.map((r) => ({
    order_item_id: String(r.order_item_id), order_id: String(r.order_id), centre_id: String(r.centre_id),
    processing_branch_id: r.processing_branch_id === null || r.processing_branch_id === undefined ? null : String(r.processing_branch_id),
    department_id: String(r.department_id), test_id: String(r.test_id), priority: r.priority as 'routine' | 'urgent', item_status: String(r.item_status),
    age_seconds: int(r.age_seconds, 'age_seconds'),
    tat_target_seconds: r.tat_target_seconds === null || r.tat_target_seconds === undefined ? null : int(r.tat_target_seconds, 'tat_target_seconds'),
  }));
}
