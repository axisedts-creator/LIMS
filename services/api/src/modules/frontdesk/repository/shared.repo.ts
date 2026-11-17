// Shared frontdesk repository plumbing (FD-T03). Static SQL only: table/column names come from per-repo constant allowlists, values are always
// parameters. REQ-SEC-024: every statement binds tenant_id explicitly ($1) in addition to RLS. Login role has search_path '' -> schema-qualify.

export interface Tx { query(text: string, values?: unknown[]): Promise<{ rows: any[]; rowCount?: number | null }> }

const ACTOR = '(SELECT app.current_actor_id())';

/**
 * INSERT one row. tenant_id is always the `tenantId` argument (a tenant_id inside `row` is ignored). Only allowlisted columns present in `row`
 * are written; omitted columns take DDL defaults. `actorCols` (created_by/updated_by) default to the claims actor when absent from `row`.
 * `jsonCols` are JSON-encoded (node-pg would send a JS array as a PG array literal). Returns the stored row.
 */
export async function insertRow(tx: Tx, table: string, cols: readonly string[], tenantId: string, row: Record<string, unknown>,
  opts: { actorCols?: readonly string[]; jsonCols?: readonly string[] } = {}): Promise<any> {
  const { actorCols = ['created_by', 'updated_by'], jsonCols = [] } = opts;
  const use = [...cols, ...actorCols].filter((c) => row[c] !== undefined);
  const names = ['tenant_id', ...use];
  const exprs = ['$1', ...use.map((_, i) => `$${i + 2}`)];
  for (const c of actorCols) if (row[c] === undefined) { names.push(c); exprs.push(ACTOR); }
  const values = [tenantId, ...use.map((c) => (jsonCols.includes(c) ? JSON.stringify(row[c]) : row[c]))];
  const { rows } = await tx.query(`INSERT INTO ${table} (${names.join(', ')}) VALUES (${exprs.join(', ')}) RETURNING *`, values);
  return rows[0];
}

/** SELECT one row by id inside the tenant; null on miss. */
export async function getRow(tx: Tx, table: string, tenantId: string, id: string): Promise<any | null> {
  const { rows } = await tx.query(`SELECT * FROM ${table} WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
  return rows[0] ?? null;
}
