// catalog.orderables / tests / panels / test_specimen_types (+ read-only analytes / analyte_versions) — 02-TRD §5.2 #2, #23–#27.
// Every value is a bind parameter; table, column and ORDER BY text come only from fixed constants in service/tests.service.ts.
// One table per statement; every statement carries an explicit `tenant_id = $1` predicate on top of RLS (07-SECURITY S-1).
interface Tx { query(text: string, values?: unknown[]): Promise<{ rows: any[] }> }
export type RangeSetTable = 'reference_range_sets' | 'critical_limit_sets';
export type RangeBandTable = 'reference_ranges' | 'critical_limits';
export type Table = 'orderables' | 'tests' | 'panels' | 'panel_members' | 'test_specimen_types' | 'analytes' | 'analyte_versions' | 'departments' | 'specimen_types' | 'containers'
  | RangeSetTable | RangeBandTable   // T-08
  | 'formula_dependencies'           // T-09 (insert only)
  | 'tat_targets'                    // T-14 (insert; rows are only ended, never deleted)
  | 'test_categories' | 'test_stage_tat_targets';   // T0B-TESTMGMT-1 (read here; stage targets written by upsertStageTargets only)

/** Stage TAT targets (T0B-TESTMGMT-1): one row per (tenant, test, stage), updated in place (id kept, version +1, no DELETE); an unchanged value is not rewritten. */
export async function upsertStageTargets(tx: Tx, rows: ReadonlyArray<{ id: string; tenant_id: string; test_id: string; stage: string; target_minutes: number; created_by: string; updated_by: string }>): Promise<void> {
  const values: unknown[] = [];
  const groups = rows.map((r) => `(${[r.id, r.tenant_id, r.test_id, r.stage, r.target_minutes, r.created_by, r.updated_by].map((v) => { values.push(v); return `$${values.length}`; }).join(', ')})`);
  await tx.query(
    `INSERT INTO catalog.test_stage_tat_targets AS s (id, tenant_id, test_id, stage, target_minutes, created_by, updated_by) VALUES ${groups.join(', ')}
     ON CONFLICT (tenant_id, test_id, stage) DO UPDATE SET target_minutes = EXCLUDED.target_minutes, version = s.version + 1, updated_at = now(), updated_by = EXCLUDED.updated_by,
     is_active = true WHERE s.target_minutes IS DISTINCT FROM EXCLUDED.target_minutes OR s.is_active IS DISTINCT FROM true`,
    values,
  );
}

/**
 * T0D-FIX-1 item 5 (LD-446, CR DEPLOY-AXIS-012 item 10, night25 host fix): unit price of each orderable in the version of the tenant's DEFAULT price list
 * in force at `now` (published, or superseded whose window still holds now; same rule as getPriceListDetail current_version). One statement per page.
 */
export async function defaultPrices(tx: Tx, tenantId: string, orderableIds: readonly string[], now: string): Promise<Map<string, number>> {
  if (!orderableIds.length) return new Map();
  const { rows } = await tx.query(
    `SELECT DISTINCT ON (i.orderable_id) i.orderable_id, i.unit_price_paisa
       FROM catalog.price_list_items i
       JOIN catalog.price_list_versions v ON v.tenant_id = i.tenant_id AND v.id = i.price_list_version_id
       JOIN catalog.price_lists l ON l.tenant_id = v.tenant_id AND l.id = v.price_list_id
      WHERE i.tenant_id = $1 AND v.tenant_id = $1 AND l.tenant_id = $1 AND l.owner_kind = 'default' AND v.status IN ('published', 'superseded')
        AND v.effective_from <= $3::timestamptz AND (v.effective_to IS NULL OR $3::timestamptz < v.effective_to) AND i.orderable_id = ANY($2::uuid[])
      ORDER BY i.orderable_id, v.effective_from DESC`,
    [tenantId, orderableIds, now],
  );
  return new Map(rows.map((r) => [r.orderable_id as string, Number(r.unit_price_paisa)]));
}

export interface FindOpts {
  ids?: readonly string[];                          // id = ANY(...)
  anyOf?: { col: string; values: readonly string[] };   // <col> = ANY(...); col is a fixed constant of the caller (T-12)
  after?: { col: string; desc: boolean; value: unknown; id: string };   // keyset
  order?: string; limit?: number; lock?: boolean;
}

export async function find(tx: Tx, table: Table, cols: readonly string[], tenantId: string, eq: Record<string, unknown>, o: FindOpts = {}): Promise<any[]> {
  const values: unknown[] = [tenantId];
  const bind = (v: unknown) => { values.push(v); return `$${values.length}`; };
  const where = ['tenant_id = $1', ...Object.entries(eq).map(([c, v]) => `${c} = ${bind(v)}`)];
  if (o.ids) where.push(`id = ANY(${bind(o.ids)})`);
  if (o.anyOf) where.push(`${o.anyOf.col} = ANY(${bind(o.anyOf.values)})`);
  if (o.after) where.push(`(${o.after.col}, id) ${o.after.desc ? '<' : '>'} (${bind(o.after.value)}, ${bind(o.after.id)})`);
  let sql = `SELECT ${cols.join(', ')} FROM catalog.${table} WHERE ${where.join(' AND ')}`;
  if (o.order) sql += ` ORDER BY ${o.order}`;
  if (o.limit !== undefined) sql += ` LIMIT ${bind(o.limit)}`;
  if (o.lock) sql += ' FOR UPDATE';
  return (await tx.query(sql, values)).rows;
}

/** Multi-row INSERT; `stamp` columns are set to now(). */
export async function insert(tx: Tx, table: Table, rows: readonly Record<string, unknown>[], stamp: readonly string[]): Promise<void> {
  if (!rows.length) return;
  const names = Object.keys(rows[0]!);
  const values: unknown[] = [];
  const groups = rows.map((r) => `(${[...names.map((n) => { values.push(r[n]); return `$${values.length}`; }), ...stamp.map(() => 'now()')].join(', ')})`);
  await tx.query(`INSERT INTO catalog.${table} (${[...names, ...stamp].join(', ')}) VALUES ${groups.join(', ')}`, values);
}

/** UPDATE … WHERE tenant_id AND id [AND version]; returns the updated row or undefined. */
export async function update(
  tx: Tx, table: 'orderables' | 'tests' | 'panels' | 'analytes' | 'analyte_versions' | RangeSetTable, cols: readonly string[],
  k: { tenantId: string; id: string; actorId: string; expectedVersion?: number }, patch: Record<string, unknown>,
): Promise<any> {
  const values: unknown[] = [k.tenantId, k.id, k.actorId];
  const bind = (v: unknown) => { values.push(v); return `$${values.length}`; };
  const sets = [...Object.entries(patch).map(([c, v]) => `${c} = ${bind(v)}`), 'updated_at = now()', 'updated_by = $3'];
  let where = 'tenant_id = $1 AND id = $2';
  if (k.expectedVersion !== undefined) { sets.push('version = version + 1'); where += ` AND version = ${bind(k.expectedVersion)}`; }
  const { rows } = await tx.query(`UPDATE catalog.${table} SET ${sets.join(', ')} WHERE ${where} RETURNING ${cols.join(', ')}`, values);
  return rows[0];
}

export async function deleteSpecimens(tx: Tx, tenantId: string, testId: string): Promise<void> {
  await tx.query('DELETE FROM catalog.test_specimen_types WHERE tenant_id = $1 AND test_id = $2', [tenantId, testId]);
}

/** Draft replace-all (T-08): the band tables are children of a draft set; the DB trigger refuses this on a non-draft parent. */
export async function deleteBands(tx: Tx, table: RangeBandTable, tenantId: string, setId: string): Promise<void> {
  await tx.query(`DELETE FROM catalog.${table} WHERE tenant_id = $1 AND set_id = $2`, [tenantId, setId]);
}

export async function deleteMembers(tx: Tx, tenantId: string, panelId: string): Promise<void> {
  await tx.query('DELETE FROM catalog.panel_members WHERE tenant_id = $1 AND panel_id = $2', [tenantId, panelId]);
}

/** Versions that can be shown on a test: the draft, and the version in force at `asOf` ([effective_from, effective_to)). */
export async function analyteVersions(tx: Tx, cols: readonly string[], tenantId: string, analyteIds: readonly string[], asOf: Date): Promise<any[]> {
  const { rows } = await tx.query(
    `SELECT ${cols.join(', ')} FROM catalog.analyte_versions WHERE tenant_id = $1 AND analyte_id = ANY($2) AND (status = 'draft'
     OR (status IN ('published', 'superseded', 'retired') AND effective_from <= $3 AND (effective_to IS NULL OR effective_to > $3)))`,
    [tenantId, analyteIds, asOf],
  );
  return rows;
}

/** TAT rows in force at `asOf` ([effective_from, effective_to)), routine before urgent (T-14). */
export async function tatAt(tx: Tx, cols: readonly string[], tenantId: string, testId: string, asOf: Date): Promise<any[]> {
  const { rows } = await tx.query(
    `SELECT ${cols.join(', ')} FROM catalog.tat_targets WHERE tenant_id = $1 AND test_id = $2 AND effective_from <= $3 AND (effective_to IS NULL OR effective_to > $3)
     ORDER BY priority`,
    [tenantId, testId, asOf],
  );
  return rows;
}

/** End every open TAT row of a test at `at` (T-14). Only effective_to changes; run BEFORE inserting the new rows (the open-row unique index is not deferrable). */
export async function endOpenTat(tx: Tx, tenantId: string, testId: string, actorId: string, at: Date): Promise<void> {
  await tx.query(
    'UPDATE catalog.tat_targets SET effective_to = $3, updated_at = now(), updated_by = $4, version = version + 1 WHERE tenant_id = $1 AND test_id = $2 AND effective_to IS NULL',
    [tenantId, testId, at, actorId],
  );
}

export async function hasPublishedVersion(tx: Tx, tenantId: string, testId: string): Promise<boolean> {
  const analytes = await find(tx, 'analytes', ['id'], tenantId, { test_id: testId });
  if (!analytes.length) return false;
  const { rows } = await tx.query(
    `SELECT id FROM catalog.analyte_versions WHERE tenant_id = $1 AND analyte_id = ANY($2) AND status = 'published' LIMIT 1`,
    [tenantId, analytes.map((a) => a.id)],
  );
  return rows.length > 0;
}

export interface SearchArgs {
  tenantId: string; exact: string; codePrefix: string; namePrefix: string; nameContains: string;
  isOrderable: boolean; isActive?: boolean; kind?: string; departmentId?: string; ids?: readonly string[]; limit: number;
}
/** §7.9 ranking in SQL so LIMIT applies after ranking; patterns are pre-escaped (escapeLike) and matched with ESCAPE '\'. */
export async function searchOrderables(tx: Tx, cols: readonly string[], a: SearchArgs): Promise<any[]> {
  const values: unknown[] = [a.tenantId, a.exact, a.codePrefix, a.namePrefix, a.nameContains, a.isOrderable];
  const bind = (v: unknown) => { values.push(v); return `$${values.length}`; };
  const where = ['tenant_id = $1', 'is_orderable = $6', "(code LIKE $3 ESCAPE '\\' OR name ILIKE $5 ESCAPE '\\')"];
  if (a.isActive !== undefined) where.push(`is_active = ${bind(a.isActive)}`);
  if (a.kind !== undefined) where.push(`kind = ${bind(a.kind)}`);
  if (a.departmentId !== undefined) where.push(`department_id = ${bind(a.departmentId)}`);
  if (a.ids) where.push(`id = ANY(${bind(a.ids)})`);
  const rank = "CASE WHEN code = $2 THEN 0 WHEN code LIKE $3 ESCAPE '\\' THEN 1 WHEN name ILIKE $4 ESCAPE '\\' THEN 2 ELSE 3 END";
  const { rows } = await tx.query(
    `SELECT ${cols.join(', ')} FROM catalog.orderables WHERE ${where.join(' AND ')} ORDER BY ${rank}, LENGTH(code), code COLLATE "C" LIMIT ${bind(a.limit)}`,
    values,
  );
  return rows;
}
