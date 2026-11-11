// catalog.catalog_state + root-row revision stamping (02-TRD §3). All values are bind parameters; RLS scopes every row.
interface Tx { query(text: string, values?: unknown[]): Promise<{ rows: any[] }> }

/** Lazy create of the tenant's state row; a concurrent creator wins and this is a no-op. */
export async function ensureState(tx: Tx, tenantId: string, rootId: string, actorId: string): Promise<void> {
  await tx.query(
    `INSERT INTO catalog.catalog_state (tenant_id, catalog_root_id, created_by) VALUES ($1, $2, $3)
     ON CONFLICT (tenant_id) DO NOTHING`,
    [tenantId, rootId, actorId],
  );
}

/** Row-locks the state row (held until COMMIT/ROLLBACK) and increments by exactly 1. */
export async function incrementRevision(tx: Tx, tenantId: string): Promise<{ revision: number; rootId: string } | undefined> {
  const { rows } = await tx.query(
    `UPDATE catalog.catalog_state SET catalog_revision = catalog_revision + 1, updated_at = now()
     WHERE tenant_id = $1 RETURNING catalog_revision, catalog_root_id`,
    [tenantId],
  );
  const r = rows[0];
  return r ? { revision: Number(r.catalog_revision), rootId: r.catalog_root_id as string } : undefined;
}

/** Takes the tenant's catalog_state row lock (held until COMMIT/ROLLBACK) without changing it; false when the row does not exist yet. */
export async function lockState(tx: Tx, tenantId: string): Promise<boolean> {
  const { rows } = await tx.query('SELECT catalog_revision FROM catalog.catalog_state WHERE tenant_id = $1 FOR UPDATE', [tenantId]);
  return rows.length > 0;
}

/** The tenant's current revision (a read; 0 before the first write). */
export async function currentRevision(tx: Tx, tenantId: string): Promise<number> {
  const { rows } = await tx.query('SELECT catalog_revision FROM catalog.catalog_state WHERE tenant_id = $1', [tenantId]);
  return rows[0] ? Number(rows[0].catalog_revision) : 0;
}

export async function stampOrderable(tx: Tx, id: string, revision: number): Promise<void> {
  await tx.query(`UPDATE catalog.orderables SET revision = $1 WHERE id = $2`, [revision, id]);
}
