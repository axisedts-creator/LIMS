// smartreport.summary_report_bindings (class A: append-only, no UPDATE grant, 05-SCHEMA §2.9).
import { cols, type RepoCtx, type Row } from './common.repo.js';

const INS = cols('id centre_id summary_id order_id report_version_no bound_at');

/** INSERT ... ON CONFLICT DO NOTHING (02-TRD §7.1 step 8): null when the (summary, report version) binding already exists. tenant_id / created_by come from rc. */
export async function insertBinding(rc: RepoCtx, row: Row): Promise<Row | null> {
  const keys = Object.keys(row).filter((k) => row[k] !== undefined);
  const bad = keys.filter((k) => !INS.includes(k));
  if (bad.length > 0) throw new Error(`smartreport repository: insert row carries column(s) not allowed: ${bad.join(', ')}`);
  const names = ['tenant_id', ...keys, 'created_by'];
  const values = [rc.tenantId, ...keys.map((k) => row[k]), rc.actorId];
  const { rows } = await rc.tx.query(
    `INSERT INTO smartreport.summary_report_bindings (${names.join(', ')}) VALUES (${names.map((_, i) => `$${i + 1}`).join(', ')}) ON CONFLICT DO NOTHING RETURNING *`, values);
  return (rows[0] as Row | undefined) ?? null;
}
export async function listBindingsBySummary(rc: RepoCtx, summaryId: string): Promise<Row[]> {
  return (await rc.tx.query(
    `SELECT * FROM smartreport.summary_report_bindings WHERE tenant_id = $1 AND summary_id = $2 ORDER BY report_version_no ASC`, [rc.tenantId, summaryId])).rows;
}
