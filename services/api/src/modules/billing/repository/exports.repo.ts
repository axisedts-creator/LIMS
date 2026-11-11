// billing.export_jobs, the only billing table where lims_app holds DELETE (retention purge, BL-T15). Read here.
import type { Tx } from '../../../core/db/tx.js';

export async function getExportJob(tx: Pick<Tx, 'query'>, a: { tenantId: string; jobId: string }): Promise<Record<string, unknown> | undefined> {
  const { rows } = await tx.query('SELECT * FROM billing.export_jobs WHERE tenant_id = $1 AND id = $2', [a.tenantId, a.jobId]);
  return rows[0];
}
