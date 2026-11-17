// engagement.queue_definitions / engagement.queue_counters (05-SCHEMA §2 queue; table matrix S I U: no DELETE, rows are deactivated). STAFF_C RLS scopes by centre;
// REQ-SEC-024: every statement still binds tenant_id. Static SQL only (table/column names come from the closed KINDS map, never from input); values are parameters.
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import type { Tx } from '../../../core/db/tx.js';

type Q = Pick<Tx, 'query'>;
type Row = Record<string, any>;
export type QueueKind = 'queue' | 'counter';

const KINDS = {
  queue: {
    list: `SELECT id, centre_id, code, display_name, token_prefix, sort_order, is_active, version FROM engagement.queue_definitions
           WHERE tenant_id = $1 AND ($2::uuid IS NULL OR centre_id = $2::uuid) AND ($3::boolean IS NULL OR is_active = $3::boolean)
           ORDER BY sort_order, display_name, id LIMIT 200` /* contract maxItems 200 */,
    get: 'SELECT id, centre_id, code, display_name, token_prefix, sort_order, is_active, version FROM engagement.queue_definitions WHERE tenant_id = $1 AND id = $2',
    insert: `INSERT INTO engagement.queue_definitions (id, tenant_id, centre_id, code, display_name, token_prefix, sort_order, is_active, created_by, updated_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
             RETURNING id, centre_id, code, display_name, token_prefix, sort_order, is_active, version`,
    update: `UPDATE engagement.queue_definitions SET code = $4, display_name = $5, token_prefix = $6, sort_order = $7, is_active = $8,
               version = version + 1, updated_at = now(), updated_by = $9
             WHERE tenant_id = $1 AND id = $2 AND version = $3
             RETURNING id, centre_id, code, display_name, token_prefix, sort_order, is_active, version`,
    cols: ['code', 'display_name', 'token_prefix', 'sort_order', 'is_active'],
  },
  counter: {
    list: `SELECT id, centre_id, display_name, sort_order, is_active, version FROM engagement.queue_counters
           WHERE tenant_id = $1 AND ($2::uuid IS NULL OR centre_id = $2::uuid) AND ($3::boolean IS NULL OR is_active = $3::boolean)
           ORDER BY sort_order, display_name, id LIMIT 200` /* contract maxItems 200 */,
    get: 'SELECT id, centre_id, display_name, sort_order, is_active, version FROM engagement.queue_counters WHERE tenant_id = $1 AND id = $2',
    insert: `INSERT INTO engagement.queue_counters (id, tenant_id, centre_id, display_name, sort_order, is_active, created_by, updated_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
             RETURNING id, centre_id, display_name, sort_order, is_active, version`,
    update: `UPDATE engagement.queue_counters SET display_name = $4, sort_order = $5, is_active = $6,
               version = version + 1, updated_at = now(), updated_by = $7
             WHERE tenant_id = $1 AND id = $2 AND version = $3
             RETURNING id, centre_id, display_name, sort_order, is_active, version`,
    cols: ['display_name', 'sort_order', 'is_active'],
  },
} as const;

export async function listRows(tx: Q, kind: QueueKind, a: { tenantId: string; centreId?: string; isActive?: boolean }): Promise<Row[]> {
  const { rows } = await tx.query(KINDS[kind].list, [a.tenantId, a.centreId ?? null, a.isActive ?? null]);
  return rows;
}

/** Tenant + RLS scoped: a row of another tenant or an out-of-scope centre is simply absent. */
export async function getRow(tx: Q, kind: QueueKind, a: { tenantId: string; id: string }): Promise<Row | undefined> {
  const { rows } = await tx.query(KINDS[kind].get, [a.tenantId, a.id]);
  return rows[0];
}

/** FK target read (core.collection_centres): same tenant, and visible under the actor's centre scope. */
export async function centreExists(tx: Q, a: { tenantId: string; centreId: string }): Promise<boolean> {
  const { rows } = await tx.query('SELECT id FROM core.collection_centres WHERE tenant_id = $1 AND id = $2', [a.tenantId, a.centreId]);
  return rows.length > 0;
}

export async function insertRow(tx: Q, kind: QueueKind, a: { tenantId: string; userId: string; centreId: string; values: Readonly<Record<string, unknown>> }): Promise<Row | undefined> {
  const k = KINDS[kind];
  const { rows } = await tx.query(k.insert, [uuidv7(), a.tenantId, a.centreId, ...k.cols.map((c) => a.values[c]), a.userId]);
  return rows[0];
}

/** undefined = no row matched id + version (the caller has already read the row, so this means a concurrent change). */
export async function updateRow(tx: Q, kind: QueueKind, a: { tenantId: string; userId: string; id: string; expectedVersion: number; values: Readonly<Record<string, unknown>> }): Promise<Row | undefined> {
  const k = KINDS[kind];
  const { rows } = await tx.query(k.update, [a.tenantId, a.id, a.expectedVersion, ...k.cols.map((c) => a.values[c]), a.userId]);
  return rows[0];
}
