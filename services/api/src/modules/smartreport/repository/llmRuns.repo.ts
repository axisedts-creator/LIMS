// smartreport.llm_runs (class A, Phase 3, inserted once when the run finishes, 05-SCHEMA §2.11). `items` is a jsonb array: serialised by insertRow.
import { cols, insertRow, type RepoCtx, type Row } from './common.repo.js';

const INS = cols('id centre_id summary_id status prompt_template_version model_ref input_sha256 items latency_ms error_code');

export const insertLlmRun = (rc: RepoCtx, row: Row) => insertRow(rc, 'smartreport.llm_runs', INS, row, false);
export async function listLlmRuns(rc: RepoCtx, summaryId: string): Promise<Row[]> {
  return (await rc.tx.query(
    `SELECT * FROM smartreport.llm_runs WHERE tenant_id = $1 AND summary_id = $2 ORDER BY created_at ASC, id`, [rc.tenantId, summaryId])).rows;
}
