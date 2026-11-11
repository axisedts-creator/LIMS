// frontdesk.number_counters (03-IC §9.3): gaps allowed (rolled-back tx), repeats never. The upsert row lock serialises concurrent callers.
import type { Tx } from './shared.repo.js';

export type CounterKind = 'patient_code' | 'registration_no';

/** scopeKey: '' for tenant scope, branch_id::text for registration_no. Unknown kind -> 23514 from the DDL CHECK. */
export async function nextCounterValue(tx: Tx, tenantId: string, kind: CounterKind, scopeKey: string, actorId: string): Promise<number> {
  const { rows } = await tx.query(`INSERT INTO frontdesk.number_counters AS c (tenant_id, counter_kind, scope_key, last_value, created_by, updated_by)
    VALUES ($1, $2, $3, 1, $4, $4)
    ON CONFLICT (tenant_id, counter_kind, scope_key) DO UPDATE
      SET last_value = c.last_value + 1, version = c.version + 1, updated_by = EXCLUDED.updated_by, updated_at = now()
      WHERE c.tenant_id = $1
    RETURNING last_value`, [tenantId, kind, scopeKey, actorId]);
  return Number(rows[0].last_value);
}
