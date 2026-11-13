// Shared homecollection repository plumbing (HC-T03). Static SQL only: schema-qualified table names (homecollection.<table>) and column names come from
// per-repo constant allowlists; values are always $n parameters. Every statement binds tenant_id explicitly ($1) in addition to RLS (REQ-SEC-024).
// The login role has search_path '' -> always schema-qualify.

export interface Tx { query(text: string, values?: unknown[]): Promise<{ rows: any[]; rowCount?: number | null }> }

const ACTOR = '(SELECT app.current_actor_id())';

export interface InsertOpts { actorCols?: readonly string[]; jsonCols?: readonly string[]; doNothingOnConflict?: string }

/**
 * INSERT one row. tenant_id is always the `tenantId` argument (a tenant_id inside `row` is ignored). Only allowlisted columns present in `row` are written;
 * omitted columns take DDL defaults; `actorCols` (created_by/updated_by) default to the claims actor. `jsonCols` are JSON-encoded. Returns the stored row, or
 * null when `doNothingOnConflict` (a column list, constant) swallowed a conflict.
 */
export async function insertRow(tx: Tx, table: string, cols: readonly string[], tenantId: string, row: Record<string, unknown>, opts: InsertOpts = {}): Promise<any | null> {
  const { actorCols = ['created_by', 'updated_by'], jsonCols = [], doNothingOnConflict } = opts;
  const use = [...cols, ...actorCols].filter((c) => row[c] !== undefined);
  const names = ['tenant_id', ...use];
  const exprs = ['$1', ...use.map((_, i) => `$${i + 2}`)];
  for (const c of actorCols) if (row[c] === undefined) { names.push(c); exprs.push(ACTOR); }
  const values = [tenantId, ...use.map((c) => (jsonCols.includes(c) && row[c] !== null ? JSON.stringify(row[c]) : row[c]))];
  const tail = doNothingOnConflict ? ` ON CONFLICT (${doNothingOnConflict}) DO NOTHING` : '';
  const { rows } = await tx.query(`INSERT INTO ${table} (${names.join(', ')}) VALUES (${exprs.join(', ')})${tail} RETURNING *`, values);
  return rows[0] ?? null;
}

/** SELECT one row by primary key inside the tenant; null on miss. */
export async function getRowById(tx: Tx, table: string, tenantId: string, rowId: string): Promise<any | null> {
  const { rows } = await tx.query(`SELECT * FROM ${table} WHERE tenant_id = $1 AND id = $2`, [tenantId, rowId]);
  return rows[0] ?? null;
}

/**
 * Optimistic UPDATE: applies `patch` (keys MUST be in `allowed`, else throws before any SQL), bumps version, stamps updated_at/updated_by.
 * null when no row matches (tenant_id, id, version = expectedVersion).
 */
export async function updateRow(tx: Tx, table: string, allowed: readonly string[], jsonCols: readonly string[], tenantId: string, rowId: string,
  expectedVersion: number, patch: Record<string, unknown>): Promise<any | null> {
  const keys = Object.keys(patch).filter((k) => patch[k] !== undefined);
  const bad = keys.filter((k) => !allowed.includes(k));
  if (bad.length > 0) throw Object.assign(new Error(`patch column not allowed: ${bad.join(', ')}`), { code: 'HC_PATCH_COLUMN' });
  const sets = keys.map((k, i) => `${k} = $${i + 4}`);
  if (!keys.includes('updated_by')) sets.push(`updated_by = ${ACTOR}`);
  sets.push('version = version + 1', 'updated_at = now()');
  const values = [tenantId, rowId, expectedVersion, ...keys.map((k) => (jsonCols.includes(k) && patch[k] !== null ? JSON.stringify(patch[k]) : patch[k]))];
  const { rows } = await tx.query(`UPDATE ${table} SET ${sets.join(', ')} WHERE tenant_id = $1 AND id = $2 AND version = $3 RETURNING *`, values);
  return rows[0] ?? null;
}
