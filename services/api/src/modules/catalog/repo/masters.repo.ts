// catalog.departments / specimen_types / containers / methods (02-TRD §5 #5–#16) and the coded sets cs_* / g_* (#17–#22, T-05). Every value is a bind parameter; table and
// column names come only from the fixed definitions in service/masters.service.ts. RLS scopes rows; tenant_id is also explicit.
interface Tx { query(text: string, values?: unknown[]): Promise<{ rows: any[] }> }
export type MasterTable = 'departments' | 'specimen_types' | 'containers' | 'methods' | 'cs_units' | 'cs_value_sets' | 'cs_value_set_values'
  | 'comment_codes' | 'comment_code_texts' | 'doctors' | 'credit_parties'   // T-13 / T-15 / T-16 reuse the generic insert/lock/update
  | 'price_lists' | 'price_list_versions' | 'price_list_items'               // T-17 (all three carry version, created_at, updated_at, updated_by)
  | 'surcharge_rules' | 'tax_rules' | 'cs_tax_types'                        // T-18
  | 'instrument_code_maps';                                                  // T-27
/** Global tables are SELECT-only for lims_app (05-SCHEMA); analyte_versions is read here for the in-use rule only. */
export type ReadTable = MasterTable | 'g_units' | 'g_value_sets' | 'g_value_set_values' | 'analyte_versions' | 'orderables' | 'g_tax_types';

export async function insertRow(tx: Tx, table: MasterTable, cols: readonly string[], row: Record<string, unknown>): Promise<any> {
  const names = Object.keys(row);
  const { rows } = await tx.query(
    `INSERT INTO catalog.${table} (${names.join(', ')}, version, created_at, updated_at) VALUES (${names.map((_, i) => `$${i + 1}`).join(', ')}, 1, now(), now()) RETURNING ${cols.join(', ')}`,
    names.map((n) => row[n]),
  );
  return rows[0];
}

/** Row lock held to COMMIT/ROLLBACK; taken before the catalog_state lock (bumpRevision) on every write path. */
export async function lockRow(tx: Tx, table: MasterTable, cols: readonly string[], tenantId: string, id: string): Promise<any> {
  const { rows } = await tx.query(`SELECT ${cols.join(', ')} FROM catalog.${table} WHERE tenant_id = $1 AND id = $2 FOR UPDATE`, [tenantId, id]);
  return rows[0];
}

export async function updateRow(
  tx: Tx, table: MasterTable, cols: readonly string[],
  k: { tenantId: string; id: string; expectedVersion: number; actorId: string }, patch: Record<string, unknown>,
): Promise<any> {
  const names = Object.keys(patch);
  const values: unknown[] = [k.tenantId, k.id, k.expectedVersion, k.actorId, ...names.map((n) => patch[n])];
  const sets = [...names.map((n, i) => `${n} = $${i + 5}`), 'version = version + 1', 'updated_at = now()', 'updated_by = $4'];
  const { rows } = await tx.query(
    `UPDATE catalog.${table} SET ${sets.join(', ')} WHERE tenant_id = $1 AND id = $2 AND version = $3 RETURNING ${cols.join(', ')}`,
    values,
  );
  return rows[0];
}

export interface ListArgs {
  tenantId: string; id?: string; isActive?: boolean; sortCol: string; desc: boolean;
  after?: readonly [unknown, string]; limit: number;
}
export async function listRows(tx: Tx, table: MasterTable, cols: readonly string[], a: ListArgs): Promise<any[]> {
  const values: unknown[] = [a.tenantId];
  const where = ['tenant_id = $1'];
  const bind = (v: unknown) => { values.push(v); return `$${values.length}`; };
  if (a.isActive !== undefined) where.push(`is_active = ${bind(a.isActive)}`);
  if (a.id !== undefined) where.push(`id = ${bind(a.id)}`);
  if (a.after) where.push(`(${a.sortCol}, id) ${a.desc ? '<' : '>'} (${bind(a.after[0])}, ${bind(a.after[1])})`);
  const dir = a.desc ? 'DESC' : 'ASC';
  const { rows } = await tx.query(
    `SELECT ${cols.join(', ')} FROM catalog.${table} WHERE ${where.join(' AND ')} ORDER BY ${a.sortCol} ${dir}, id ${dir} LIMIT ${bind(a.limit)}`,
    values,
  );
  return rows;
}

/** Equality filters only (array value -> `= ANY($n)`); column names come from fixed service code, every value is bound. */
export async function selectRows(
  tx: Tx, table: ReadTable, cols: readonly string[], where: Record<string, unknown>, orderBy: string, limit?: number,
): Promise<any[]> {
  const values: unknown[] = [];
  const bind = (v: unknown) => { values.push(v); return `$${values.length}`; };
  const conds = Object.entries(where).map(([c, v]) => (Array.isArray(v) ? `${c} = ANY(${bind(v)})` : `${c} = ${bind(v)}`));
  const { rows } = await tx.query(
    `SELECT ${cols.join(', ')} FROM catalog.${table}${conds.length ? ` WHERE ${conds.join(' AND ')}` : ''} ORDER BY ${orderBy}${limit === undefined ? '' : ` LIMIT ${bind(limit)}`}`,
    values,
  );
  return rows;
}
