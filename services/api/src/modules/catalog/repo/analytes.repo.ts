// Analyte-specific reads (02-TRD §5.2 #29–#35) on top of tests.repo's generic find/insert/update. One table per statement,
// explicit tenant predicate on tenant tables, bind parameters only (07-SECURITY S-1, REQ-SEC-082).
interface Tx { query(text: string, values?: unknown[]): Promise<{ rows: any[] }> }

/** A value set visible to the tenant: its own (cs_value_sets) or the global vocabulary (g_value_sets). `is_ordered` or undefined when absent. */
export async function valueSetOrdered(tx: Tx, tenantId: string, code: string): Promise<boolean | undefined> {
  const own = await tx.query('SELECT is_ordered FROM catalog.cs_value_sets WHERE tenant_id = $1 AND code = $2 AND is_active = $3', [tenantId, code, true]);
  if (own.rows[0]) return own.rows[0].is_ordered === true;
  const global = await tx.query('SELECT is_ordered FROM catalog.g_value_sets WHERE code = $1 AND is_active = $2', [code, true]);
  return global.rows[0] ? global.rows[0].is_ordered === true : undefined;
}

/** Active value codes of a value set visible to the tenant (own cs_ set first, else the global one); undefined when the set does not exist (T-08 ordinal codes). */
export async function valueSetCodes(tx: Tx, tenantId: string, code: string): Promise<Set<string> | undefined> {
  const own = await tx.query('SELECT id FROM catalog.cs_value_sets WHERE tenant_id = $1 AND code = $2 AND is_active = $3', [tenantId, code, true]);
  if (own.rows[0]) {
    const v = await tx.query('SELECT code FROM catalog.cs_value_set_values WHERE tenant_id = $1 AND value_set_id = $2 AND is_active = $3', [tenantId, own.rows[0].id, true]);
    return new Set(v.rows.map((r) => r.code as string));
  }
  const global = await tx.query('SELECT code FROM catalog.g_value_sets WHERE code = $1 AND is_active = $2', [code, true]);
  if (!global.rows[0]) return undefined;
  const v = await tx.query('SELECT code FROM catalog.g_value_set_values WHERE value_set_code = $1 AND is_active = $2', [code, true]);
  return new Set(v.rows.map((r) => r.code as string));
}

/** result_type of the published version of each given analyte (AC-02.3). */
export async function publishedResultTypes(tx: Tx, tenantId: string, analyteIds: readonly string[]): Promise<any[]> {
  if (!analyteIds.length) return [];
  const { rows } = await tx.query(
    `SELECT analyte_id, result_type FROM catalog.analyte_versions WHERE tenant_id = $1 AND analyte_id = ANY($2) AND status = $3`,
    [tenantId, analyteIds, 'published'],
  );
  return rows;
}
