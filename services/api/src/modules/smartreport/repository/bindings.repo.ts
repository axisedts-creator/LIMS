// smartreport.summary_report_bindings (class A: append-only, no UPDATE grant, 05-SCHEMA §2.9).
import { cols, insertRow, type RepoCtx, type Row } from './common.repo.js';

const INS = cols('id centre_id summary_id order_id report_version_no bound_at');

export const insertBinding = (rc: RepoCtx, row: Row) => insertRow(rc, 'smartreport.summary_report_bindings', INS, row, false);
export async function listBindingsBySummary(rc: RepoCtx, summaryId: string): Promise<Row[]> {
  return (await rc.tx.query(
    `SELECT * FROM smartreport.summary_report_bindings WHERE tenant_id = $1 AND summary_id = $2 ORDER BY report_version_no ASC`, [rc.tenantId, summaryId])).rows;
}
