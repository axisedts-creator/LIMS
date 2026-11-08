// Live reads on published source views (02-TRD §6.8; 07-SECURITY P1, P4). One bound SELECT, explicit columns, tenant `$1`,
// scope `$2` (all-centres flag) / `$3` (centre ids). Nothing from input is part of the statement text.
import { checkScope, type RollupScope } from './rollups.repo.js';

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
